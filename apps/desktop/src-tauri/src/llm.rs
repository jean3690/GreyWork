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
use std::time::{Duration, Instant};

use crate::log;
use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

/// SSE 流空闲超时：连接保持但 N 秒无任何字节 → 按错误终止（服务端挂死不能永久悬挂回合）。
const LLM_IDLE_TIMEOUT_SECS: u64 = 60;

/// 增量合批时间窗：与渲染端 `stores/chat/stream.ts` 的 40ms flush 节奏对齐。
const DELTA_FLUSH_INTERVAL: Duration = Duration::from_millis(40);
/// 增量合批字节阈值：攒够就直接发，避免大段内容被无谓压后。
const DELTA_FLUSH_BYTES: usize = 2048;

/// 流式增量合批器（纯逻辑，便于单测）。
///
/// 上游按 token 产出增量，逐条过 IPC 意味着每个 token 一次 serde 序列化 + 一次全量
/// 广播 + 一次 JS 回调；token 密集时这些开销远超内容本身。这里按「时间窗或字节阈值」
/// 合并，`push` 只在需要发车时给出待发文本。
///
/// 取的是「上一条增量到达时刻」而非定时器：增量本身就是节拍，模型正常产出时每个
/// 窗口都会被下一条增量触发；模型中途长停顿则内容多等一拍（下一条增量或回合结束的
/// `finish` 兜底），不会丢内容。
struct DeltaBatcher {
    pending: String,
    last_flush: Instant,
}

impl DeltaBatcher {
    fn new() -> Self {
        Self {
            pending: String::new(),
            last_flush: Instant::now(),
        }
    }

    /// 收下一个增量；返回 `Some(合并后的文本)` 表示该发车了。
    fn push(&mut self, delta: &str) -> Option<String> {
        self.pending.push_str(delta);
        if self.pending.len() >= DELTA_FLUSH_BYTES
            || self.last_flush.elapsed() >= DELTA_FLUSH_INTERVAL
        {
            return self.finish();
        }
        None
    }

    /// 强制发车。回合结束 / 报错 / 中止前必须调用，否则最后一段内容会留在缓冲里。
    fn finish(&mut self) -> Option<String> {
        if self.pending.is_empty() {
            return None;
        }
        self.last_flush = Instant::now();
        Some(std::mem::take(&mut self.pending))
    }
}

/// 事件信封：统一 kind + payload（与 acp_host 的 AcpEventEnvelope 同构）。
#[derive(Serialize, Clone)]
struct LlmEventEnvelope {
    kind: &'static str,
    payload: serde_json::Value,
}

/// 渲染端提交的对话消息（历史上下文 + 本轮输入）。
///
/// `content` 有意用 `serde_json::Value` 而不是 String 或自定义 enum：纯文本消息是 string，
/// 带图片的消息是 OpenAI vision 的 content parts 数组，形状由协议决定、本层不解释，
/// 直接原样透传即可（用 enum 还得自定义 Deserialize，收益只是编译期收窄）。
#[derive(Deserialize)]
pub struct LlmChatMessage {
    pub role: String,
    pub content: serde_json::Value,
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
    messages: Vec<LlmChatMessage>,
    reasoning_effort: &str,
) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": model,
        "stream": true,
        "messages": messages
            .into_iter()
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
/// content 可能是 string，也可能是 parts 数组（部分兼容端点对带图请求回数组），后者拼接 text 段。
fn content_from_completion(body: &serde_json::Value) -> Option<String> {
    let content = body
        .get("choices")?
        .get(0)?
        .get("message")?
        .get("content")?;
    if let Some(text) = content.as_str() {
        return (!text.is_empty()).then(|| text.to_string());
    }
    let joined: String = content
        .as_array()?
        .iter()
        .filter_map(|part| part.get("text").and_then(|text| text.as_str()))
        .collect();
    (!joined.is_empty()).then_some(joined)
}

/// 解析请求头值中的 `{{ENV_VAR}}` 占位符为环境变量实际值。
/// 变量未设置/为空 → Err（指路用户补环境变量），绝不静默丢头——带占位符原样发出
/// 等于把密钥模板发给远端。
fn resolve_header_placeholders(value: &str) -> Result<String, String> {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        match after.find("}}") {
            Some(end) => {
                let name = after[..end].trim();
                match std::env::var(name) {
                    Ok(resolved) if !resolved.is_empty() => out.push_str(&resolved),
                    _ => {
                        return Err(format!(
                            "未设置环境变量 {name}：请求头占位符 {{{{{name}}}}} 无法解析，请先 export 后从同一终端启动 GreyWork（或到设置页修改该请求头）"
                        ));
                    }
                }
                rest = &after[end + 2..];
            }
            None => {
                // 只有 {{ 没有 }}：按字面量保留，交给 reqwest/服务端判定合法性
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    Ok(out)
}

/// 发起一轮流式对话；返回请求 id（用于 llm_chat_stop 中止）。
///
/// `client_token` 是调用方自带的轮次令牌，原样回灌进每条事件：`llm://event` 是全局广播
/// （会话流与远程助手回复可能并行），消费方凭它过滤出属于自己那一笔。
// 参数是 Tauri 命令的扁平入参（前端 invoke 按名传），拆成结构体会把 invoke 形状也改掉。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn llm_chat_start(
    app: AppHandle,
    state: State<'_, LlmHost>,
    base_url: String,
    model: String,
    api_key_env: String,
    messages: Vec<LlmChatMessage>,
    reasoning_effort: String,
    headers: Option<HashMap<String, String>>,
    client_token: Option<String>,
) -> Result<u64, String> {
    let base_url = base_url.trim().to_string();
    if base_url.is_empty() || model.trim().is_empty() {
        return Err("base_url and model are required".to_string());
    }
    log::info("llm", format!("start model={model} base={base_url}"));
    let request_id = state.next_id.fetch_add(1, Ordering::SeqCst);
    let turn_token = client_token.unwrap_or_default();

    let response = send_chat_request(
        &base_url,
        &model,
        &api_key_env,
        messages,
        &reasoning_effort,
        &headers.unwrap_or_default(),
    )
    .await?;

    let app_task = app.clone();
    let task = tauri::async_runtime::spawn(async move {
        stream_response(&app_task, response, &turn_token).await;
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
    messages: Vec<LlmChatMessage>,
    reasoning_effort: &str,
    headers: &HashMap<String, String>,
) -> Result<reqwest::Response, String> {
    let env_name = api_key_env.trim();
    let api_key = std::env::var(env_name).unwrap_or_default();
    // 声明了 env 却没设值：别拿匿名请求去撞 401 —— 直接告诉用户去哪补。
    // （env 名为空的本地服务如 Ollama 才允许匿名。）
    if !env_name.is_empty() && api_key.is_empty() {
        return Err(format!(
            "未设置 API Key：先在本机终端执行 {}，再从同一终端启动 GreyWork（设置页 → Agent → 模型供应商可查看/修改变量名）",
            env_set_hint(env_name, cfg!(windows))
        ));
    }
    let client = crate::http::shared_client(10)?;
    let mut request = client
        .post(completions_url(base_url))
        .json(&chat_request_body(model.trim(), messages, reasoning_effort));
    if !api_key.is_empty() {
        request = request.bearer_auth(api_key);
    }
    for (key, value) in headers {
        let resolved = resolve_header_placeholders(value)?;
        request = request.header(key, resolved);
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
            "llm endpoint returned {status}: {}（检查 API Key 是否有效，或到设置页 → Agent → 模型供应商核对 Base URL / 模型名）",
            truncate(&body, 200)
        ));
    }
    Ok(response)
}

/// 设置环境变量在当前平台的写法。
///
/// 写死 `export` 会让 Windows 用户照做后仍然失败（cmd 用 `set`、PowerShell 用 `$env:`）。
/// 参数化平台是为了能在 Linux CI 上把三种写法都钉住。
fn env_set_hint(env_name: &str, windows: bool) -> String {
    if windows {
        format!("set {env_name}=你的密钥（PowerShell 用 $env:{env_name}=\"你的密钥\"）")
    } else {
        format!("export {env_name}=你的密钥")
    }
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
    headers: &HashMap<String, String>,
) -> Result<String, String> {
    let response = send_chat_request(
        base_url,
        model,
        api_key_env,
        messages,
        reasoning_effort,
        headers,
    )
    .await?;
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

/// 发一条 LLM 事件；带上调用方令牌（空令牌 = 旧调用方，事件不带该字段）。
fn emit_llm(
    app: &AppHandle,
    client_token: &str,
    kind: &'static str,
    mut payload: serde_json::Value,
) {
    if !client_token.is_empty() {
        if let Some(object) = payload.as_object_mut() {
            object.insert(
                "clientToken".into(),
                serde_json::Value::String(client_token.to_string()),
            );
        }
    }
    emit(app, kind, payload);
}

/// 发一条增量。合批后仍走 `llm-delta` + `delta` 字段，前端契约不变（接收侧本就是累加）。
fn emit_delta(app: &AppHandle, client_token: &str, delta: String) {
    emit_llm(
        app,
        client_token,
        "llm-delta",
        serde_json::json!({ "delta": delta }),
    );
}

/// SSE / 整段 JSON 双路处理；所有出口都保证发出 llm-done 或 llm-error。
async fn stream_response(app: &AppHandle, response: reqwest::Response, client_token: &str) {
    if !is_sse_response(&response) {
        match crate::http::read_json::<serde_json::Value>(
            response,
            crate::http::RESPONSE_READ_TIMEOUT,
        )
        .await
        {
            Ok(body) => match content_from_completion(&body) {
                Some(content) => {
                    emit_delta(app, client_token, content);
                    emit_llm(app, client_token, "llm-done", serde_json::json!({}));
                }
                None => {
                    log::error("llm", "empty completion（非流式响应无内容）");
                    emit_llm(
                        app,
                        client_token,
                        "llm-error",
                        serde_json::json!({ "message": "empty completion" }),
                    );
                }
            },
            Err(error) => {
                log::error("llm", format!("非流式响应失败: {error}"));
                emit_llm(
                    app,
                    client_token,
                    "llm-error",
                    serde_json::json!({ "message": error }),
                );
            }
        }
        return;
    }

    // 边收边发：合批后在增量到达时立刻下发，而不是等整段响应收完再一次性铺出去。
    // 末端内容靠 `finish()` 兜底——终止事件之前必须先把它发出去，否则最后一段会丢。
    let mut batcher = DeltaBatcher::new();
    let mut terminal = None;
    drain_sse_into(
        response.bytes_stream(),
        Duration::from_secs(LLM_IDLE_TIMEOUT_SECS),
        |event| match event {
            SseEvent::Delta(delta) => {
                if let Some(batch) = batcher.push(&delta) {
                    emit_delta(app, client_token, batch);
                }
                true
            }
            terminal_event => {
                terminal = Some(terminal_event);
                false
            }
        },
    )
    .await;
    if let Some(batch) = batcher.finish() {
        emit_delta(app, client_token, batch);
    }
    match terminal {
        Some(SseEvent::Error(message)) => {
            log::error("llm", format!("流式失败: {message}"));
            emit_llm(
                app,
                client_token,
                "llm-error",
                serde_json::json!({ "message": message }),
            );
        }
        // Done / 流在未发送 [DONE] 时关闭（None）：都按结束处理，避免前端 busy 卡死。
        _ => emit_llm(app, client_token, "llm-done", serde_json::json!({})),
    }
}

/// SSE 消费结果。
#[derive(Debug, PartialEq)]
enum SseEvent {
    Delta(String),
    Done,
    Error(String),
}

/// 消费 openai SSE 字节流并收集为事件序列（`drain_sse_into` 的收集式包装）。
async fn drain_sse(
    stream: impl Stream<Item = Result<Bytes, reqwest::Error>> + Unpin,
    idle: Duration,
) -> Vec<SseEvent> {
    let mut events = Vec::new();
    drain_sse_into(stream, idle, |event| {
        events.push(event);
        true
    })
    .await;
    events
}

/// 逐事件消费 openai SSE 字节流：每解析出一条就立刻交给 `sink`，不等整段响应收完。
///
/// `sink` 返回 `false` 表示不再需要后续事件，消费立即停止；终止事件（`Done` /
/// `Error`）交付后总是返回，它们的返回值不被检查。
///
/// 空闲（无任何字节）超过 `idle` 按错误提前终止。
async fn drain_sse_into(
    mut stream: impl Stream<Item = Result<Bytes, reqwest::Error>> + Unpin,
    idle: Duration,
    mut sink: impl FnMut(SseEvent) -> bool,
) {
    let mut buffer = String::new();
    loop {
        let chunk = match tokio::time::timeout(idle, stream.next()).await {
            Err(_) => {
                sink(SseEvent::Error(format!(
                    "LLM 响应空闲超时（{} 秒无数据）",
                    idle.as_secs()
                )));
                return;
            }
            Ok(None) => return, // 服务端关闭连接：调用方按结束处理
            Ok(Some(Err(error))) => {
                sink(SseEvent::Error(error.to_string()));
                return;
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
                sink(SseEvent::Done);
                return;
            }
            if let Some(delta) = delta_from_sse_data(data) {
                if !sink(SseEvent::Delta(delta)) {
                    return;
                }
            }
        }
    }
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

    /// 兼容端点对带图请求可能回 content parts 数组：拼接 text 段，别当成「空回复」。
    #[test]
    fn completion_body_joins_content_parts_array() {
        let body: serde_json::Value = serde_json::from_str(
            r#"{"choices":[{"message":{"role":"assistant","content":[{"type":"text","text":"看"},{"type":"text","text":"到了"}]}}]}"#,
        )
        .unwrap();
        assert_eq!(content_from_completion(&body).as_deref(), Some("看到了"));
        // 数组里没有 text 段（如只有图片）→ None，交由调用方报「空回复」
        let no_text: serde_json::Value = serde_json::from_str(
            r#"{"choices":[{"message":{"content":[{"type":"image","data":"x"}]}}]}"#,
        )
        .unwrap();
        assert_eq!(content_from_completion(&no_text), None);
    }

    /// 带图请求的 content parts 数组要原样透传给端点，不能被本层改写。
    #[test]
    fn request_body_passes_content_parts_through() {
        let parts = serde_json::json!([
            { "type": "text", "text": "这张图有什么问题" },
            { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAA" } },
        ]);
        let messages = vec![LlmChatMessage {
            role: "user".into(),
            content: parts.clone(),
        }];
        let body = chat_request_body("gpt-test", messages, "auto");
        assert_eq!(body["messages"][0]["content"], parts);
    }

    #[test]
    fn request_body_marks_stream_and_maps_messages() {
        let messages = vec![
            LlmChatMessage {
                role: "system".into(),
                content: serde_json::json!("sys"),
            },
            LlmChatMessage {
                role: "user".into(),
                content: serde_json::json!("hi"),
            },
        ];
        let body = chat_request_body("gpt-test", messages, "high");
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
        let body = chat_request_body("gpt-test", vec![], "auto");
        assert!(body.get("reasoning_effort").is_none());
    }

    /// 三种平台写法都要给对：写死 `export` 会让 Windows 用户照做后仍然失败。
    #[test]
    fn env_set_hint_matches_the_platform_shell() {
        assert_eq!(
            env_set_hint("OPENAI_API_KEY", false),
            "export OPENAI_API_KEY=你的密钥"
        );
        let windows = env_set_hint("OPENAI_API_KEY", true);
        assert!(
            windows.starts_with("set OPENAI_API_KEY="),
            "cmd 用 set: {windows}"
        );
        assert!(
            windows.contains("$env:OPENAI_API_KEY="),
            "PowerShell 用 $env:: {windows}"
        );
        // 两边都不该出现对方平台的写法
        assert!(!env_set_hint("K", true).contains("export "));
        assert!(!env_set_hint("K", false).contains("set K="));
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

    /// 事件是「解析出一条就交付一条」，不是收完整段再一次性铺出来——
    /// 发送侧合批的正确性就建立在这个前提上。
    #[tokio::test]
    async fn drain_sse_into_delivers_each_event_as_it_is_parsed() {
        let stream = futures_util::stream::iter(vec![
            sse_chunk_delta("一"),
            sse_chunk_delta("二"),
            sse_chunk_delta("三"),
        ]);
        let mut seen = Vec::new();
        drain_sse_into(stream, Duration::from_secs(5), |event| {
            seen.push(event);
            false // 第一条就喊停：后续增量不该再被消费
        })
        .await;
        assert_eq!(seen, vec![SseEvent::Delta("一".into())]);
    }

    /// 把合批器的「上次发车时刻」往前拨，让时间窗分支必然命中——
    /// 免得单测靠真实 sleep，CI 上既慢又不稳。
    fn backdate(batcher: &mut DeltaBatcher, by: Duration) {
        if let Some(aged) = Instant::now().checked_sub(by) {
            batcher.last_flush = aged;
        }
    }

    #[test]
    fn delta_batcher_holds_empty_buffer_but_flushes_once_the_window_elapsed() {
        let mut batcher = DeltaBatcher::new();
        assert!(batcher.finish().is_none(), "空缓冲不该产出事件");
        backdate(&mut batcher, DELTA_FLUSH_INTERVAL);
        assert_eq!(batcher.push("迟到").as_deref(), Some("迟到"));
    }

    #[test]
    fn delta_batcher_flushes_on_the_byte_threshold() {
        let mut batcher = DeltaBatcher::new();
        // 一次性超过字节阈值：与时间窗无关，必然发车（阈值按字节数判定）
        let big = "x".repeat(DELTA_FLUSH_BYTES);
        assert_eq!(batcher.push(&big).as_deref(), Some(big.as_str()));
        assert!(batcher.finish().is_none(), "发车后缓冲应已清空");
    }

    /// 合批只该改变事件条数：内容与顺序必须逐字节不变。
    /// 前端两处消费方（`stores/chat/stream.ts`、`stores/remote-assistant/pipeline.ts`）都是累加。
    /// 不断言「几条事件」而断言拼接结果——避免依赖具体切分点。
    #[test]
    fn delta_batcher_preserves_order_and_never_loses_the_tail() {
        let mut batcher = DeltaBatcher::new();
        let mut seen = String::new();
        for token in ["前", "中", "后", "尾"] {
            if let Some(batch) = batcher.push(token) {
                seen.push_str(&batch);
            }
        }
        if let Some(batch) = batcher.finish() {
            seen.push_str(&batch);
        }
        assert_eq!(seen, "前中后尾");
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
            // 循环 accept：reqwest 偶发重连/复用连接时，单次 accept 的服务器会让
            // 第二次连接直接撞 RST，客户端侧表现为偶发「error decoding response
            // body」。每连接独立子任务：先吞掉请求（防写响应时对端仍在写导致
            // RST），响应头体一次写完，再显式 shutdown 干净收尾。
            while let Ok((mut stream, _)) = listener.accept().await {
                let body = body.clone();
                let content_type = content_type.clone();
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = vec![0u8; 4096];
                    let _ = stream.read(&mut buf).await;
                    let mut wire = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    )
                    .into_bytes();
                    wire.extend_from_slice(body.as_bytes());
                    let _ = stream.write_all(&wire).await;
                    let _ = stream.shutdown().await;
                });
            }
        });
        format!("http://{addr}/v1")
    }

    fn complete_message(text: &str) -> String {
        format!(r#"{{"choices":[{{"message":{{"role":"assistant","content":"{text}"}}}}]}}"#)
    }

    /// chat_complete 只在声明的 env 变量非空时才发起请求；CI 与多数本地环境
    /// 都没有这个变量（名字带 TEST 前缀，示意无需真实密钥）。测试自设同名同值，
    /// 两个用例并行 set 也互不干扰（std env 内部有锁）。
    fn mock_api_key_env() -> String {
        const ENV: &str = "GREYWORK_TEST_NO_SUCH_KEY";
        std::env::set_var(ENV, "test-key");
        ENV.to_string()
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
            &mock_api_key_env(),
            vec![LlmChatMessage {
                role: "user".into(),
                content: serde_json::json!("hi"),
            }],
            "auto",
            &HashMap::new(),
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
            &mock_api_key_env(),
            vec![LlmChatMessage {
                role: "user".into(),
                content: serde_json::json!("hi"),
            }],
            "auto",
            &HashMap::new(),
        )
        .await
        .expect("parsed");
        assert_eq!(reply, "整包回复");
    }

    #[test]
    fn header_placeholders_resolve_env_vars() {
        std::env::set_var("GREYWORK_TEST_HEADER_TOKEN", "secret-123");
        assert_eq!(
            resolve_header_placeholders("Bearer {{GREYWORK_TEST_HEADER_TOKEN}}").unwrap(),
            "Bearer secret-123"
        );
        // 多占位符 + 相邻文本
        std::env::set_var("GREYWORK_TEST_HEADER_ORG", "acme");
        assert_eq!(
            resolve_header_placeholders(
                "{{GREYWORK_TEST_HEADER_ORG}}:{{GREYWORK_TEST_HEADER_TOKEN}}"
            )
            .unwrap(),
            "acme:secret-123"
        );
        // 无占位符原样返回；占位符名容忍空白
        assert_eq!(
            resolve_header_placeholders("plain-value").unwrap(),
            "plain-value"
        );
        assert_eq!(
            resolve_header_placeholders("{{ GREYWORK_TEST_HEADER_ORG }}").unwrap(),
            "acme"
        );
    }

    #[test]
    fn header_placeholders_error_on_missing_env() {
        let error = resolve_header_placeholders("{{GREYWORK_TEST_HEADER_MISSING}}").unwrap_err();
        assert!(error.contains("GREYWORK_TEST_HEADER_MISSING"));
        assert!(error.contains("未设置环境变量"));
        // 未闭合的 {{ 按字面量保留（交由 reqwest/服务端判定合法性）
        assert_eq!(
            resolve_header_placeholders("literal {{ open").unwrap(),
            "literal {{ open"
        );
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

    /// 性能测量用例：统计发送侧合批前后的 `llm-delta` IPC 事件数。
    /// 两种端点节奏各测一轮——合批的触发条件不同（时间窗 vs 字节阈值）。
    /// 按需手动运行：
    /// `cargo test --lib delta_batch_measurement -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "性能测量用例，按需手动运行"]
    async fn delta_batch_measurement_counts_ipc_events() {
        const TOKENS: usize = 200;
        for (label, gap_ms) in [("100 tok/s", 10u64), ("无间隔突发", 0)] {
            let chunk = sse_chunk_delta(&"x".repeat(30)).expect("chunk");
            let stream = Box::pin(futures_util::stream::unfold(
                (0usize, chunk),
                move |(index, chunk)| async move {
                    if index >= TOKENS {
                        return None;
                    }
                    if gap_ms > 0 {
                        tokio::time::sleep(Duration::from_millis(gap_ms)).await;
                    }
                    Some((Ok(chunk.clone()), (index + 1, chunk)))
                },
            ));
            let mut batcher = DeltaBatcher::new();
            let mut raw = 0usize;
            let mut batched = 0usize;
            drain_sse_into(stream, Duration::from_secs(5), |event| {
                if let SseEvent::Delta(delta) = event {
                    raw += 1;
                    if batcher.push(&delta).is_some() {
                        batched += 1;
                    }
                }
                true
            })
            .await;
            if batcher.finish().is_some() {
                batched += 1;
            }
            println!(
                "{label}：{TOKENS} 个 token → 逐条发 {raw} 条 IPC，合批后 {batched} 条（{:.0}×）",
                raw as f64 / batched as f64
            );
            assert!(batched < raw, "合批必须减少事件数");
        }
    }
}
