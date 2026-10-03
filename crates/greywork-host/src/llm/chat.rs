//! 对话流：请求发起、事件下发、中止与宿主自主执行聚合。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::Mutex;

use crate::host::HostContext;
use crate::log;

use super::dto::{InferenceParams, LlmChatMessage};
use super::sse::{content_from_completion, drain_sse, drain_sse_into, DeltaBatcher, SseEvent};
use super::transport::{is_sse_response, send_chat_request};

/// SSE 流空闲超时：连接保持但 N 秒无任何字节 → 按错误终止（服务端挂死不能永久悬挂回合）。
const LLM_IDLE_TIMEOUT_SECS: u64 = 60;
/// 事件信封：统一 kind + payload（与 acp_host 的 AcpEventEnvelope 同构）。
#[derive(Serialize, Clone)]
struct LlmEventEnvelope {
    kind: &'static str,
    payload: serde_json::Value,
}

/// 全局 LLM 主机状态：请求 id 分配 + 可中止的流任务句柄。
///
/// `streams` 用 `Arc<Mutex<…>>` 而不是裸 `Mutex`：流任务结束时**自己**要把句柄摘掉
/// （正常完成也要摘，否则长会话会攒下成千上万个已完成的 `JoinHandle`），
/// 于是它得持有一份锁的共享引用。
#[derive(Default)]
pub struct LlmHost {
    next_id: AtomicU64,
    streams: Arc<Mutex<HashMap<u64, tokio::task::JoinHandle<()>>>>,
}

fn emit(host: &dyn HostContext, kind: &'static str, payload: serde_json::Value) {
    crate::host::emit_json(host, "llm://event", LlmEventEnvelope { kind, payload });
}

/// 发起一轮流式对话；返回请求 id（用于 llm_chat_stop 中止）。
///
/// `client_token` 是调用方自带的轮次令牌，原样回灌进每条事件：`llm://event` 是全局广播
/// （会话流与远程助手回复可能并行），消费方凭它过滤出属于自己那一笔。
///
/// `host` 收 `Arc` 而非 `&dyn`：流任务 spawn 出去后要自己持有事件出口。
// 参数是前端命令的扁平入参（invoke 按名传），拆成结构体会把 invoke 形状也改掉。
#[allow(clippy::too_many_arguments)]
pub async fn llm_chat_start(
    host: Arc<dyn HostContext>,
    llm: &LlmHost,
    base_url: String,
    model: String,
    api_key_env: String,
    messages: Vec<LlmChatMessage>,
    reasoning_effort: String,
    headers: Option<HashMap<String, String>>,
    params: InferenceParams,
    client_token: Option<String>,
) -> Result<u64, String> {
    let base_url = base_url.trim().to_string();
    if base_url.is_empty() || model.trim().is_empty() {
        return Err("base_url and model are required".to_string());
    }
    log::info("llm", format!("start model={model} base={base_url}"));
    let request_id = llm.next_id.fetch_add(1, Ordering::SeqCst);
    let turn_token = client_token.unwrap_or_default();

    let response = send_chat_request(
        &base_url,
        &model,
        &api_key_env,
        messages,
        &reasoning_effort,
        &headers.unwrap_or_default(),
        &params,
    )
    .await?;

    let host_task = host;
    // 先持锁生成句柄再插入：流任务结束时会自己摘除，若它在插入前就跑到摘除那一步，
    // 那次 remove 会落空、句柄永久残留。持锁期间它拿不到锁，摘除必然发生在插入之后。
    let mut streams = llm.streams.lock().await;
    let streams_handle = Arc::clone(&llm.streams);
    let task = tokio::spawn(async move {
        stream_response(host_task.as_ref(), response, &turn_token).await;
        streams_handle.lock().await.remove(&request_id);
    });
    streams.insert(request_id, task);
    Ok(request_id)
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
        &InferenceParams::default(),
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
            // 聚合回复只要正文：思考链不进宿主兜底执行的产物。
            SseEvent::Thinking(_) => {}
            SseEvent::Done => return Ok(text),
            SseEvent::Error(message) => return Err(message),
        }
    }
    Ok(text) // 无 [DONE] 的连接关闭：已收文本视为完成（与命令路径语义一致）
}

/// 发一条 LLM 事件；带上调用方令牌（空令牌 = 旧调用方，事件不带该字段）。
fn emit_llm(
    host: &dyn HostContext,
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
    emit(host, kind, payload);
}

/// 发一条正文增量。合批后仍走 `llm-delta` + `delta` 字段，前端契约不变（接收侧本就是累加）。
fn emit_delta(host: &dyn HostContext, client_token: &str, delta: String) {
    emit_llm(
        host,
        client_token,
        "llm-delta",
        serde_json::json!({ "delta": delta }),
    );
}

/// 发一条思考链增量（DeepSeek-R1 / Qwen3 / Ollama 的 reasoning）。
/// 与正文分开一个 kind：前端渲染成「思考段」，与 ACP 的 AgentThoughtChunk 对齐。
fn emit_thinking(host: &dyn HostContext, client_token: &str, delta: String) {
    emit_llm(
        host,
        client_token,
        "llm-thinking-delta",
        serde_json::json!({ "delta": delta }),
    );
}

/// SSE / 整段 JSON 双路处理；所有出口都保证发出 llm-done 或 llm-error。
async fn stream_response(host: &dyn HostContext, response: reqwest::Response, client_token: &str) {
    if !is_sse_response(&response) {
        let body = match crate::http::read_json::<serde_json::Value>(
            response,
            crate::http::RESPONSE_READ_TIMEOUT,
        )
        .await
        {
            Ok(body) => body,
            Err(error) => {
                log::error("llm", format!("非流式响应失败: {error}"));
                emit_llm(
                    host,
                    client_token,
                    "llm-error",
                    serde_json::json!({ "message": error }),
                );
                return;
            }
        };
        // 非流式整包：思考链先出（如果有），正文随后 —— 与流式路径的段序一致。
        let reasoning = body
            .get("choices")
            .and_then(|choices| choices.get(0))
            .and_then(|choice| choice.get("message"))
            .and_then(|message| {
                message
                    .get("reasoning_content")
                    .or_else(|| message.get("reasoning"))
            })
            .and_then(|value| value.as_str())
            .unwrap_or("");
        if !reasoning.is_empty() {
            emit_thinking(host, client_token, reasoning.to_string());
        }
        match content_from_completion(&body) {
            Some(content) => {
                emit_delta(host, client_token, content);
                emit_llm(host, client_token, "llm-done", serde_json::json!({}));
            }
            None => {
                log::error("llm", "empty completion（非流式响应无内容）");
                emit_llm(
                    host,
                    client_token,
                    "llm-error",
                    serde_json::json!({ "message": "empty completion" }),
                );
            }
        }
        return;
    }

    // 边收边发：合批后在增量到达时立刻下发，而不是等整段响应收完再一次性铺出去。
    // 末端内容靠 `finish()` 兜底——终止事件之前必须先把它发出去，否则最后一段会丢。
    // 正文与思考各一个合批器：两条流交替到达时各自按自己的节奏发车。
    let mut content_batcher = DeltaBatcher::new();
    let mut thinking_batcher = DeltaBatcher::new();
    let mut terminal = None;
    drain_sse_into(
        response.bytes_stream(),
        Duration::from_secs(LLM_IDLE_TIMEOUT_SECS),
        |event| match event {
            SseEvent::Delta(delta) => {
                if let Some(batch) = content_batcher.push(&delta) {
                    emit_delta(host, client_token, batch);
                }
                true
            }
            SseEvent::Thinking(delta) => {
                if let Some(batch) = thinking_batcher.push(&delta) {
                    emit_thinking(host, client_token, batch);
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
    if let Some(batch) = content_batcher.finish() {
        emit_delta(host, client_token, batch);
    }
    if let Some(batch) = thinking_batcher.finish() {
        emit_thinking(host, client_token, batch);
    }
    match terminal {
        Some(SseEvent::Error(message)) => {
            log::error("llm", format!("流式失败: {message}"));
            emit_llm(
                host,
                client_token,
                "llm-error",
                serde_json::json!({ "message": message }),
            );
        }
        // Done / 流在未发送 [DONE] 时关闭（None）：都按结束处理，避免前端 busy 卡死。
        _ => emit_llm(host, client_token, "llm-done", serde_json::json!({})),
    }
}

/// 中止进行中的流任务并回收句柄。
pub async fn llm_chat_stop(llm: &LlmHost, request_id: u64) -> Result<(), String> {
    let task = llm.streams.lock().await.remove(&request_id);
    match task {
        Some(task) => {
            task.abort();
            Ok(())
        }
        None => Err(format!("unknown llm request {request_id}")),
    }
}
