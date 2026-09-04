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
use std::time::Duration;

use crate::log;
use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

/// SSE 流空闲超时：连接保持但 N 秒无任何字节 → 按错误终止（服务端挂死不能永久悬挂回合）。
const LLM_IDLE_TIMEOUT_SECS: u64 = 60;

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
fn chat_request_body(
    model: &str,
    messages: &[LlmChatMessage],
    reasoning_effort: &str,
) -> serde_json::Value {
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
    log::info("llm", format!("start model={model} base={base_url}"));
    let request_id = state.next_id.fetch_add(1, Ordering::SeqCst);

    let response = send_chat_request(
        &base_url,
        &model,
        &api_key_env,
        &messages,
        &reasoning_effort,
    )
    .await?;

    let app_task = app.clone();
    let task = tauri::async_runtime::spawn(async move {
        stream_response(&app_task, response).await;
    });
    state.streams.lock().await.insert(request_id, task);
    Ok(request_id)
}

/// 构造并发送 chat/completions 请求（command 与宿主自主执行共用）。
/// 密钥宿主侧解析：变量未设或为空（本地服务常见）则匿名请求。
async fn send_chat_request(
    base_url: &str,
    model: &str,
    api_key_env: &str,
    messages: &[LlmChatMessage],
    reasoning_effort: &str,
) -> Result<reqwest::Response, String> {
    let api_key = std::env::var(api_key_env.trim()).unwrap_or_default();
    let client = crate::http::shared_client(10)?;
    let mut request = client
        .post(completions_url(base_url))
        .json(&chat_request_body(model.trim(), messages, reasoning_effort));
    if !api_key.is_empty() {
        request = request.bearer_auth(api_key);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("llm request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = crate::http::read_text(response, crate::http::RESPONSE_READ_TIMEOUT)
            .await
            .unwrap_or_default();
        return Err(format!(
            "llm endpoint returned {status}: {}",
            truncate(&body, 300)
        ));
    }
    Ok(response)
}

/// 响应是否为 SSE 流（Content-Type 判定）。
fn is_sse_response(response: &reqwest::Response) -> bool {
    response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("event-stream"))
}

/// 宿主自主执行：完整单轮 LLM 回合并聚合全文（不经事件通道——
/// automation 队列宿主兜底消费用；渲染端路径仍走 llm_chat_start 事件流）。
pub async fn chat_complete(
    base_url: &str,
    model: &str,
    api_key_env: &str,
    messages: Vec<LlmChatMessage>,
    reasoning_effort: &str,
) -> Result<String, String> {
    let response =
        send_chat_request(base_url, model, api_key_env, &messages, reasoning_effort).await?;
    if !is_sse_response(&response) {
        // 非流式：整包 JSON（服务端忽略 stream 时）
        let body: serde_json::Value =
            crate::http::read_json(response, crate::http::RESPONSE_READ_TIMEOUT).await?;
        return content_from_completion(&body).ok_or_else(|| "empty completion".to_string());
    }
    let events = drain_sse(
        response.bytes_stream(),
        Duration::from_secs(LLM_IDLE_TIMEOUT_SECS),
    )
    .await;
    let mut text = String::new();
    for event in events {
        match event {
            SseEvent::Delta(delta) => text.push_str(&delta),
            SseEvent::Done => return Ok(text),
            SseEvent::Error(message) => return Err(message),
        }
    }
    Ok(text) // 无 [DONE] 的连接关闭：已收文本视为完成（与命令路径语义一致）
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
    if !is_sse_response(&response) {
        match crate::http::read_json::<serde_json::Value>(
            response,
            crate::http::RESPONSE_READ_TIMEOUT,
        )
        .await
        {
            Ok(body) => match content_from_completion(&body) {
                Some(content) => {
                    emit(app, "llm-delta", serde_json::json!({ "delta": content }));
                    emit(app, "llm-done", serde_json::json!({}));
                }
                None => {
                    log::error("llm", "empty completion（非流式响应无内容）");
                    emit(
                        app,
                        "llm-error",
                        serde_json::json!({ "message": "empty completion" }),
                    );
                }
            },
            Err(error) => {
                log::error("llm", format!("非流式响应失败: {error}"));
                emit(
                    app,
                    "llm-error",
                    serde_json::json!({ "message": error.to_string() }),
                );
            }
        }
        return;
    }

    let events = drain_sse(
        response.bytes_stream(),
        Duration::from_secs(LLM_IDLE_TIMEOUT_SECS),
    )
    .await;
    for event in events {
        match event {
            SseEvent::Delta(delta) => {
                emit(app, "llm-delta", serde_json::json!({ "delta": delta }));
            }
            SseEvent::Done => {
                emit(app, "llm-done", serde_json::json!({}));
                return;
            }
            SseEvent::Error(message) => {
                log::error("llm", format!("流式失败: {message}"));
                emit(app, "llm-error", serde_json::json!({ "message": message }));
                return;
            }
        }
    }
    // 流在未发送 [DONE] 时关闭：仍视为结束，避免前端 busy 卡死。
    emit(app, "llm-done", serde_json::json!({}));
}

/// SSE 消费结果。
#[derive(Debug, PartialEq)]
enum SseEvent {
    Delta(String),
    Done,
    Error(String),
}

/// 消费 openai SSE 字节流为事件序列。空闲（无任何字节）超过 `idle` 按错误提前终止。
async fn drain_sse(
    mut stream: impl Stream<Item = Result<Bytes, reqwest::Error>> + Unpin,
    idle: Duration,
) -> Vec<SseEvent> {
    let mut buffer = String::new();
    let mut events = Vec::new();
    loop {
        let chunk = match tokio::time::timeout(idle, stream.next()).await {
            Err(_) => {
                events.push(SseEvent::Error(format!(
                    "LLM 响应空闲超时（{} 秒无数据）",
                    idle.as_secs()
                )));
                break;
            }
            Ok(None) => break, // 服务端关闭连接：调用方按结束处理
            Ok(Some(Err(error))) => {
                events.push(SseEvent::Error(error.to_string()));
                break;
            }
            Ok(Some(Ok(bytes))) => bytes,
        };
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(position) = buffer.find('\n') {
            let line: String = buffer.drain(..=position).collect();
            let line = line.trim_end_matches(['\r', '\n']);
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data == "[DONE]" {
                events.push(SseEvent::Done);
                return events;
            }
            if let Some(delta) = delta_from_sse_data(data) {
                events.push(SseEvent::Delta(delta));
            }
        }
    }
    events
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

    fn sse_chunk(json: &str) -> Result<Bytes, reqwest::Error> {
        Ok(Bytes::from(format!("data: {json}\n")))
    }

    /// 复刻 stream 增量帧的最小形状（choices[0].delta.content）。
    fn sse_chunk_delta(text: &str) -> Result<Bytes, reqwest::Error> {
        sse_chunk(&format!(
            r#"{{"choices":[{{"delta":{{"content":"{text}"}}}}]}}"#
        ))
    }

    #[tokio::test]
    async fn drain_sse_emits_deltas_then_done() {
        let stream = futures_util::stream::iter(vec![
            sse_chunk_delta("你"),
            sse_chunk_delta("好"),
            sse_chunk("[DONE]"),
        ]);
        let events = drain_sse(stream, Duration::from_secs(5)).await;
        assert_eq!(
            events,
            vec![
                SseEvent::Delta("你".into()),
                SseEvent::Delta("好".into()),
                SseEvent::Done,
            ]
        );
    }

    #[tokio::test]
    async fn drain_sse_close_without_done_is_clean_end() {
        // 服务端直接关闭连接：无错误事件，调用方按 done 收尾（前端 busy 不卡死）。
        let stream = futures_util::stream::iter(vec![sse_chunk_delta("半")]);
        let events = drain_sse(stream, Duration::from_secs(5)).await;
        assert_eq!(events, vec![SseEvent::Delta("半".into())]);
    }

    /// 起本地 mock chat/completions 服务器，返回其 URL。
    /// body: 完整响应体；content_type: 响应类型。
    async fn mock_completions_server(body: String, content_type: &str) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let content_type = content_type.to_string();
        tokio::spawn(async move {
            if let Ok((mut stream, _)) = listener.accept().await {
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\n\r\n",
                    content_type,
                    body.len()
                );
                let _ = tokio::io::AsyncWriteExt::write_all(&mut stream, header.as_bytes()).await;
                let _ = tokio::io::AsyncWriteExt::write_all(&mut stream, body.as_bytes()).await;
            }
        });
        format!("http://{addr}/v1")
    }

    fn complete_message(text: &str) -> String {
        format!(r#"{{"choices":[{{"message":{{"role":"assistant","content":"{text}"}}}}]}}"#)
    }

    #[tokio::test]
    async fn chat_complete_aggregates_sse_stream() {
        let sse = format!(
            "data: {}\ndata: {}\ndata: [DONE]\n",
            serde_json::json!({"choices":[{"delta":{"content":"你"}}]}),
            serde_json::json!({"choices":[{"delta":{"content":"好"}}]})
        );
        let url = mock_completions_server(sse, "text/event-stream").await;
        let reply = chat_complete(
            &url,
            "mock-model",
            "GREYWORK_TEST_NO_SUCH_KEY",
            vec![LlmChatMessage {
                role: "user".into(),
                content: "hi".into(),
            }],
            "auto",
        )
        .await
        .expect("aggregated");
        assert_eq!(reply, "你好");
    }

    #[tokio::test]
    async fn chat_complete_reads_non_stream_json_body() {
        let url = mock_completions_server(complete_message("整包回复"), "application/json").await;
        let reply = chat_complete(
            &url,
            "mock-model",
            "GREYWORK_TEST_NO_SUCH_KEY",
            vec![LlmChatMessage {
                role: "user".into(),
                content: "hi".into(),
            }],
            "auto",
        )
        .await
        .expect("parsed");
        assert_eq!(reply, "整包回复");
    }

    #[tokio::test]
    async fn drain_sse_idle_timeout_aborts_hung_stream() {
        // 连接保持但零数据：超过 idle 必须终止并报错，而不是永久悬挂。
        // unfold 产出含 async future 非 Unpin：Box::pin 后满足 drain_sse 约束。
        let stream = Box::pin(futures_util::stream::unfold(0u8, |mut state| async move {
            if state == 0 {
                state = 1;
                Some((sse_chunk_delta("前"), state))
            } else {
                tokio::time::sleep(Duration::from_secs(10)).await;
                Some((Ok(Bytes::new()), state))
            }
        }));
        let events = drain_sse(stream, Duration::from_millis(200)).await;
        assert_eq!(events.len(), 2);
        assert_eq!(events[0], SseEvent::Delta("前".into()));
        assert!(matches!(&events[1], SseEvent::Error(message) if message.contains("空闲超时")));
    }
}
