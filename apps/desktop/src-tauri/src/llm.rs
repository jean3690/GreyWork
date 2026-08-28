//! LLM 直连（openai-compatible `/chat/completions` 流式）。
//!
//! 设计约束：
//! - 密钥只在 Rust 宿主从环境变量解析；渲染端仅传变量名，密钥永不进入前端。
//! - 流式增量经 `llm://event` 转发，kind：`llm-delta` / `llm-done` / `llm-error`。
//!   事件信封与 acp_host 同构，前端按 kind 分流。
//! - 服务端若忽略 `stream:true` 返回整段 JSON，按非流式路径一次性下发。
//! - Anthropic / Ollama 均提供 openai-compatible 端点，Phase 1 统一走该线格式。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

/// 事件信封：统一 kind + payload（与 acp_host 的 AcpEventEnvelope 同构）。
#[derive(Serialize, Clone)]
struct LlmEventEnvelope {
    kind: &'static str,
    payload: serde_json::Value,
}

/// 渲染端提交的对话消息（历史上下文 + 本轮输入）。
#[derive(Deserialize)]
pub struct LlmChatMessage {
    pub role: String,
    pub content: String,
}

/// 全局 LLM 主机状态：请求 id 分配 + 可中止的流任务句柄。
#[derive(Default)]
pub struct LlmHost {
    next_id: AtomicU64,
    streams: Mutex<HashMap<u64, tauri::async_runtime::JoinHandle<()>>>,
}

fn emit(app: &AppHandle, kind: &'static str, payload: serde_json::Value) {
    let _ = app.emit("llm://event", LlmEventEnvelope { kind, payload });
}

/// 拼接 chat/completions 端点：baseUrl 已带版本段（/v1、/v4…）则直接追加，
/// 否则补默认 /v1。兼容 OpenAI / DeepSeek / Moonshot / 智谱 / vLLM / Ollama(/v1) 等。
fn completions_url(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    let last_segment = trimmed.rsplit('/').next().unwrap_or("");
    let has_version = last_segment.len() >= 2
        && last_segment.starts_with('v')
        && last_segment[1..].chars().all(|c| c.is_ascii_digit());
    if has_version {
        format!("{trimmed}/chat/completions")
    } else {
        format!("{trimmed}/v1/chat/completions")
    }
}

/// 推理等级 → openai `reasoning_effort`。auto/空/未知不传；max 收敛为 high（openai 无 max 档）。
fn openai_reasoning_effort(effort: &str) -> Option<&'static str> {
    match effort.trim().to_ascii_lowercase().as_str() {
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        "max" => Some("high"),
        _ => None,
    }
}

/// 构造流式请求体。推理档位映射为 openai `reasoning_effort`，
/// 仅对显式档位（low/medium/high/max）添加，避免不支持的模型拒绝整个请求。
fn chat_request_body(model: &str, messages: &[LlmChatMessage], reasoning_effort: &str) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": model,
        "stream": true,
        "messages": messages
            .iter()
            .map(|message| serde_json::json!({
                "role": message.role,
                "content": message.content,
            }))
            .collect::<Vec<_>>(),
    });
    if let Some(effort) = openai_reasoning_effort(reasoning_effort) {
        body["reasoning_effort"] = serde_json::json!(effort);
    }
    body
}

/// 解析一条 SSE data 行为增量文本；非流式完整响应由调用方单独处理。
/// 返回 None 表示该行不含可追加内容（如 usage 帧、空 delta）。
fn delta_from_sse_data(data: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(data).ok()?;
    let content = value
        .get("choices")?
        .get(0)?
        .get("delta")?
        .get("content")?
        .as_str()?;
    (!content.is_empty()).then(|| content.to_string())
}

/// 非流式完整响应（服务端忽略 stream 时）提取全文。
fn content_from_completion(body: &serde_json::Value) -> Option<String> {
    let content = body
        .get("choices")?
        .get(0)?
        .get("message")?
        .get("content")?
        .as_str()?;
    (!content.is_empty()).then(|| content.to_string())
}

/// 发起一轮流式对话；返回请求 id（用于 llm_chat_stop 中止）。
#[tauri::command]
pub async fn llm_chat_start(
    app: AppHandle,
    state: State<'_, LlmHost>,
    base_url: String,
    model: String,
    api_key_env: String,
    messages: Vec<LlmChatMessage>,
    reasoning_effort: String,
) -> Result<u64, String> {
    let base_url = base_url.trim().to_string();
    if base_url.is_empty() || model.trim().is_empty() {
        return Err("base_url and model are required".to_string());
    }
    // 密钥宿主侧解析：变量未设或为空（本地服务常见）则匿名请求。
    let api_key = std::env::var(api_key_env.trim()).unwrap_or_default();

    let request_id = state.next_id.fetch_add(1, Ordering::SeqCst);

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|error| format!("http client build failed: {error}"))?;

    let mut request = client
        .post(completions_url(&base_url))
        .json(&chat_request_body(model.trim(), &messages, &reasoning_effort));
    if !api_key.is_empty() {
        request = request.bearer_auth(api_key);
    }

    let response = request
        .send()
        .await
        .map_err(|error| format!("llm request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "llm endpoint returned {status}: {}",
            truncate(&body, 300)
        ));
    }

    let app_task = app.clone();
    let task = tauri::async_runtime::spawn(async move {
        stream_response(&app_task, response).await;
    });
    state.streams.lock().await.insert(request_id, task);
    Ok(request_id)
}

fn truncate(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let cut: String = value.chars().take(max_chars).collect();
    format!("{cut}…")
}

/// SSE / 整段 JSON 双路处理；所有出口都保证发出 llm-done 或 llm-error。
async fn stream_response(app: &AppHandle, response: reqwest::Response) {
    let is_sse = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("event-stream"));

    if !is_sse {
        match response.json::<serde_json::Value>().await {
            Ok(body) => match content_from_completion(&body) {
                Some(content) => {
                    emit(app, "llm-delta", serde_json::json!({ "delta": content }));
                    emit(app, "llm-done", serde_json::json!({}));
                }
                None => emit(
                    app,
                    "llm-error",
                    serde_json::json!({ "message": "empty completion" }),
                ),
            },
            Err(error) => emit(
                app,
                "llm-error",
                serde_json::json!({ "message": error.to_string() }),
            ),
        }
        return;
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    while let Some(chunk) = stream.next().await {
        let bytes = match chunk {
            Ok(bytes) => bytes,
            Err(error) => {
                emit(
                    app,
                    "llm-error",
                    serde_json::json!({ "message": error.to_string() }),
                );
                return;
            }
        };
        buffer.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(position) = buffer.find('\n') {
            let line: String = buffer.drain(..=position).collect();
            let line = line.trim_end_matches(['\r', '\n']);
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data == "[DONE]" {
                emit(app, "llm-done", serde_json::json!({}));
                return;
            }
            if let Some(delta) = delta_from_sse_data(data) {
                emit(app, "llm-delta", serde_json::json!({ "delta": delta }));
            }
        }
    }
    // 流在未发送 [DONE] 时关闭：仍视为结束，避免前端 busy 卡死。
    emit(app, "llm-done", serde_json::json!({}));
}

/// 中止进行中的流任务并回收句柄。
#[tauri::command]
pub async fn llm_chat_stop(state: State<'_, LlmHost>, request_id: u64) -> Result<(), String> {
    let task = state.streams.lock().await.remove(&request_id);
    match task {
        Some(task) => {
            task.abort();
            Ok(())
        }
        None => Err(format!("unknown llm request {request_id}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completions_url_inserts_default_version_segment() {
        assert_eq!(
            completions_url("https://api.openai.com"),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            completions_url("https://api.openai.com/"),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            completions_url(" http://localhost:11434 "),
            "http://localhost:11434/v1/chat/completions"
        );
    }

    #[test]
    fn completions_url_respects_existing_version_segment() {
        assert_eq!(
            completions_url("https://api.deepseek.com/v1"),
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            completions_url("https://open.bigmodel.cn/api/paas/v4"),
            "https://open.bigmodel.cn/api/paas/v4/chat/completions"
        );
    }

    #[test]
    fn sse_delta_parses_content_and_ignores_noise_frames() {
        let chunk =
            r#"{"id":"x","choices":[{"index":0,"delta":{"role":"assistant","content":"你好"}}]}"#;
        assert_eq!(delta_from_sse_data(chunk).as_deref(), Some("你好"));
        // 空 delta 与无 choices 帧
        assert_eq!(delta_from_sse_data(r#"{"choices":[{"delta":{}}]}"#), None);
        assert_eq!(
            delta_from_sse_data(r#"{"usage":{"total_tokens":10}}"#),
            None
        );
        assert_eq!(delta_from_sse_data("not-json"), None);
    }

    #[test]
    fn completion_body_yields_message_content() {
        let body: serde_json::Value = serde_json::from_str(
            r#"{"choices":[{"message":{"role":"assistant","content":"完整回复"}}]}"#,
        )
        .unwrap();
        assert_eq!(content_from_completion(&body).as_deref(), Some("完整回复"));
        assert_eq!(content_from_completion(&serde_json::Value::Null), None);
    }

    #[test]
    fn request_body_marks_stream_and_maps_messages() {
        let messages = vec![
            LlmChatMessage {
                role: "system".into(),
                content: "sys".into(),
            },
            LlmChatMessage {
                role: "user".into(),
                content: "hi".into(),
            },
        ];
        let body = chat_request_body("gpt-test", &messages, "high");
        assert_eq!(body["model"], "gpt-test");
        assert_eq!(body["stream"], true);
        assert_eq!(body["reasoning_effort"], "high");
        assert_eq!(body["messages"].as_array().unwrap().len(), 2);
        assert_eq!(body["messages"][0]["role"], "system");
    }

    #[test]
    fn openai_reasoning_effort_maps_explicit_tiers_only() {
        assert_eq!(openai_reasoning_effort("low"), Some("low"));
        assert_eq!(openai_reasoning_effort("medium"), Some("medium"));
        assert_eq!(openai_reasoning_effort("high"), Some("high"));
        // max 收敛为 high（openai 无 max 档）
        assert_eq!(openai_reasoning_effort("max"), Some("high"));
        // auto / 空 / 未知 → 不传，避免模型拒绝请求
        assert_eq!(openai_reasoning_effort("auto"), None);
        assert_eq!(openai_reasoning_effort(""), None);
        assert_eq!(openai_reasoning_effort("ultra"), None);
        // 大小写不敏感
        assert_eq!(openai_reasoning_effort("HIGH"), Some("high"));
    }

    #[test]
    fn request_body_omits_reasoning_effort_when_auto() {
        let body = chat_request_body("gpt-test", &[], "auto");
        assert!(body.get("reasoning_effort").is_none());
    }
}
