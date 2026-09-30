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
use std::sync::Arc;
use std::time::{Duration, Instant};

use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::host::HostContext;
use crate::log;
use crate::workspace_fs::WorkspaceFsAccess;

/// SSE 流空闲超时：连接保持但 N 秒无任何字节 → 按错误终止（服务端挂死不能永久悬挂回合）。
const LLM_IDLE_TIMEOUT_SECS: u64 = 60;

/// 语音转写的音频上限：与附件通用文件上限一致（`attachments.ts` 的 20MB）。
/// 转写要把整段音频读进内存再走 multipart，不设硬顶等于让一次调用分配任意大缓冲。
const TRANSCRIBE_MAX_BYTES: usize = 20 * 1024 * 1024;

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

/// 拼接 openai 兼容端点：baseUrl 已带版本段（/v1、/v4…）则直接追加，
/// 否则补默认 /v1。兼容 OpenAI / DeepSeek / Moonshot / 智谱 / vLLM / Ollama(/v1) 等。
fn endpoint_url(base_url: &str, path: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    let last_segment = trimmed.rsplit('/').next().unwrap_or("");
    let has_version = last_segment.len() >= 2
        && last_segment.starts_with('v')
        && last_segment[1..].chars().all(|c| c.is_ascii_digit());
    if has_version {
        format!("{trimmed}/{path}")
    } else {
        format!("{trimmed}/v1/{path}")
    }
}

fn completions_url(base_url: &str) -> String {
    endpoint_url(base_url, "chat/completions")
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

/// 采样参数（temperature / max_tokens）：仅显式设置才写进请求体。
///
/// 本地模型常见的「确定性 / 限长」诉求靠这两项，但对不支持的端点写进去等于拒收整个请求，
/// 所以缺省一律不传（与 `reasoning_effort` 的 auto 同款策略）。
#[derive(Debug, Default, Clone, Copy)]
pub struct InferenceParams {
    pub temperature: Option<f64>,
    pub max_tokens: Option<u32>,
}

/// 构造流式请求体。推理档位映射为 openai `reasoning_effort`，
/// 仅对显式档位（low/medium/high/max）添加，避免不支持的模型拒绝整个请求。
fn chat_request_body(
    model: &str,
    messages: Vec<LlmChatMessage>,
    reasoning_effort: &str,
    params: &InferenceParams,
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
    if let Some(temperature) = params.temperature {
        body["temperature"] = serde_json::json!(temperature);
    }
    if let Some(max_tokens) = params.max_tokens {
        body["max_tokens"] = serde_json::json!(max_tokens);
    }
    body
}

/// 一条 SSE data 行里的增量：正文与思考链分开取。
///
/// 思考链有两种线上形状：`delta.reasoning_content`（DeepSeek-R1 / Qwen3）与
/// `delta.reasoning`（Ollama / vLLM）。两种都收，正文与思考各自独立合批下发。
#[derive(Debug, Default, PartialEq, Eq)]
struct SseDelta {
    content: Option<String>,
    reasoning: Option<String>,
}

/// 解析一条 SSE data 行为增量；非流式完整响应由调用方单独处理。
/// 返回 None 表示该行连 choices/delta 都没有（如 usage 帧）。
fn parse_sse_delta(data: &str) -> Option<SseDelta> {
    let value: serde_json::Value = serde_json::from_str(data).ok()?;
    let delta = value.get("choices")?.get(0)?.get("delta")?;
    let pick = |key: &str| -> Option<String> {
        let text = delta.get(key)?.as_str()?;
        (!text.is_empty()).then(|| text.to_string())
    };
    let reasoning = pick("reasoning_content").or_else(|| pick("reasoning"));
    Some(SseDelta {
        content: pick("content"),
        reasoning,
    })
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
///
/// `pub(crate)`：`office.rs` 的配方请求头用同一套占位符语义，共用一份实现
/// （两处各写一遍迟早会在「未闭合 `{{` 怎么处理」这类边角上分叉）。
pub(crate) fn resolve_header_placeholders(value: &str) -> Result<String, String> {
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

/// 解析 API Key（环境变量名 → 值）。声明了 env 却没设值 → Err 指路用户去哪补；
/// env 名为空（本地服务如 Ollama）才允许匿名。
fn resolve_api_key(api_key_env: &str) -> Result<String, String> {
    let env_name = api_key_env.trim();
    if env_name.is_empty() {
        return Ok(String::new());
    }
    match std::env::var(env_name) {
        Ok(value) if !value.is_empty() => Ok(value),
        _ => Err(format!(
            "未设置 API Key：先在本机终端执行 {}，再从同一终端启动 GreyWork（设置页 → Agent → 模型供应商可查看/修改变量名）",
            env_set_hint(env_name, cfg!(windows))
        )),
    }
}

/// 给请求挂上 bearer 鉴权与自定义头（`{{ENV}}` 占位符宿主侧解析）。
fn apply_auth(
    mut request: reqwest::RequestBuilder,
    api_key: &str,
    headers: &HashMap<String, String>,
) -> Result<reqwest::RequestBuilder, String> {
    if !api_key.is_empty() {
        request = request.bearer_auth(api_key);
    }
    for (key, value) in headers {
        let resolved = resolve_header_placeholders(value)?;
        request = request.header(key, resolved);
    }
    Ok(request)
}

/// 构造并发送 chat/completions 请求（command 与宿主自主执行共用）。
async fn send_chat_request(
    base_url: &str,
    model: &str,
    api_key_env: &str,
    messages: Vec<LlmChatMessage>,
    reasoning_effort: &str,
    headers: &HashMap<String, String>,
    params: &InferenceParams,
) -> Result<reqwest::Response, String> {
    let api_key = resolve_api_key(api_key_env)?;
    let client = crate::http::shared_client(10)?;
    let request = client
        .post(completions_url(base_url))
        .json(&chat_request_body(
            model.trim(),
            messages,
            reasoning_effort,
            params,
        ));
    let request = apply_auth(request, &api_key, headers)?;
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
/// `pub(crate)`：`office.rs` 的凭证未设置提示复用同一句，免得两个模块给出两种引导。
pub(crate) fn env_set_hint(env_name: &str, windows: bool) -> String {
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

/// 按字符（不是字节）截断，附省略号。错误体诊断用。
/// `pub(crate)`：`office.rs` 的上传失败诊断复用（按字节截会切坏中文错误体）。
pub(crate) fn truncate(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let cut: String = value.chars().take(max_chars).collect();
    format!("{cut}…")
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

/// SSE 消费结果。
#[derive(Debug, PartialEq)]
enum SseEvent {
    Delta(String),
    Thinking(String),
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
            if let Some(delta) = parse_sse_delta(data) {
                if let Some(content) = delta.content {
                    if !sink(SseEvent::Delta(content)) {
                        return;
                    }
                }
                if let Some(reasoning) = delta.reasoning {
                    if !sink(SseEvent::Thinking(reasoning)) {
                        return;
                    }
                }
            }
        }
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

/* ===== 命令入参 ===== */

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatStartArgs {
    pub base_url: String,
    pub model: String,
    pub api_key_env: String,
    pub messages: Vec<LlmChatMessage>,
    pub reasoning_effort: String,
    pub headers: Option<HashMap<String, String>>,
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    pub client_token: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatStopArgs {
    pub request_id: u64,
}

/// `llm_list_models` 入参：连通性自检与模型下拉共用。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListModelsArgs {
    pub base_url: String,
    #[serde(default)]
    pub api_key_env: Option<String>,
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
}

/// `llm_embed` 入参（RAG 索引用）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedArgs {
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub api_key_env: Option<String>,
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
    pub input: Vec<String>,
}

/// 向量结果：`dim` 冗余回传，便于调用方校验模型是否换过。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedResult {
    pub embeddings: Vec<Vec<f32>>,
    pub dim: usize,
    pub model: String,
}

/// `llm_transcribe` 入参：音频以**授权路径**给出（附件已落在授权根内）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeArgs {
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub api_key_env: Option<String>,
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
    pub path: String,
    #[serde(default)]
    pub language: Option<String>,
}

#[derive(serde::Serialize, Debug)]
pub struct TranscribeResult {
    pub text: String,
}

/* ===== 模型发现 / 向量 / 语音转写 ===== */

/// 拉取 `GET /models` 的模型 id 清单。既供设置页做模型下拉，也兼作连通性自检
/// （能列出来 = Base URL 可达 + 鉴权正确）。
pub async fn llm_list_models(args: ListModelsArgs) -> Result<Vec<String>, String> {
    let base_url = args.base_url.trim();
    if base_url.is_empty() {
        return Err("base_url is required".to_string());
    }
    let api_key = resolve_api_key(args.api_key_env.as_deref().unwrap_or(""))?;
    let empty = HashMap::new();
    let headers = args.headers.as_ref().unwrap_or(&empty);
    let client = crate::http::shared_client(10)?;
    let request = client.get(endpoint_url(base_url, "models"));
    let request = apply_auth(request, &api_key, headers)?;
    let response = request
        .send()
        .await
        .map_err(|error| format!("llm models request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = crate::http::read_text(response, crate::http::RESPONSE_READ_TIMEOUT)
            .await
            .unwrap_or_default();
        return Err(format!(
            "llm endpoint returned {status}: {}（检查 Base URL 是否正确、本地服务是否在运行）",
            truncate(&body, 200)
        ));
    }
    let body: serde_json::Value =
        crate::http::read_json(response, crate::http::RESPONSE_READ_TIMEOUT).await?;
    Ok(collect_model_ids(&body))
}

/// 从 `/models` 响应里收集模型 id：兼容 OpenAI `data[].id` 与 Ollama 原生 `models[].name`。
fn collect_model_ids(body: &serde_json::Value) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    if let Some(data) = body.get("data").and_then(|value| value.as_array()) {
        for item in data {
            if let Some(id) = item.get("id").and_then(|value| value.as_str()) {
                ids.push(id.to_string());
            }
        }
    }
    if let Some(models) = body.get("models").and_then(|value| value.as_array()) {
        for item in models {
            if let Some(name) = item.get("name").and_then(|value| value.as_str()) {
                ids.push(name.to_string());
            }
        }
    }
    ids.sort();
    ids.dedup();
    ids
}

/// 批量取文本向量（`POST /embeddings`）。RAG 索引与查询共用。
pub async fn llm_embed(args: EmbedArgs) -> Result<EmbedResult, String> {
    let base_url = args.base_url.trim();
    let model = args.model.trim();
    if base_url.is_empty() || model.is_empty() {
        return Err("base_url and model are required".to_string());
    }
    if args.input.is_empty() {
        return Ok(EmbedResult {
            embeddings: Vec::new(),
            dim: 0,
            model: model.to_string(),
        });
    }
    let api_key = resolve_api_key(args.api_key_env.as_deref().unwrap_or(""))?;
    let empty = HashMap::new();
    let headers = args.headers.as_ref().unwrap_or(&empty);
    let client = crate::http::shared_client(30)?;
    let request = client
        .post(endpoint_url(base_url, "embeddings"))
        .json(&serde_json::json!({ "model": model, "input": args.input }));
    let request = apply_auth(request, &api_key, headers)?;
    let response = request
        .send()
        .await
        .map_err(|error| format!("llm embeddings request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = crate::http::read_text(response, crate::http::RESPONSE_READ_TIMEOUT)
            .await
            .unwrap_or_default();
        return Err(format!(
            "llm embeddings returned {status}: {}（确认该模型是 embedding 模型、且服务支持 /v1/embeddings）",
            truncate(&body, 200)
        ));
    }
    let body: serde_json::Value =
        crate::http::read_json(response, crate::http::RESPONSE_READ_TIMEOUT).await?;
    let embeddings = parse_embeddings(&body)?;
    let dim = embeddings.first().map_or(0, Vec::len);
    Ok(EmbedResult {
        embeddings,
        dim,
        model: model.to_string(),
    })
}

/// 解析向量响应：OpenAI `data[].embedding`、批式 `embeddings[][]`、单条 `embedding[]` 三种形状。
fn parse_embeddings(body: &serde_json::Value) -> Result<Vec<Vec<f32>>, String> {
    let to_vec = |value: &serde_json::Value| -> Option<Vec<f32>> {
        value.as_array().map(|arr| {
            arr.iter()
                .map(|n| n.as_f64().unwrap_or(0.0) as f32)
                .collect()
        })
    };
    if let Some(data) = body.get("data").and_then(|value| value.as_array()) {
        let out: Vec<Vec<f32>> = data
            .iter()
            .filter_map(|item| item.get("embedding").and_then(&to_vec))
            .collect();
        if !out.is_empty() {
            return Ok(out);
        }
    }
    if let Some(embeddings) = body.get("embeddings").and_then(|value| value.as_array()) {
        let out: Vec<Vec<f32>> = embeddings.iter().filter_map(&to_vec).collect();
        if !out.is_empty() {
            return Ok(out);
        }
    }
    if let Some(single) = body.get("embedding").and_then(&to_vec) {
        return Ok(vec![single]);
    }
    Err("embedding 响应里没有向量（确认模型是 embedding 模型）".to_string())
}

/// 语音转写（`POST /audio/transcriptions`，OpenAI 兼容 multipart）。
/// 音频从**授权路径**读取 —— 附件落在 `~/.greyWork/attachments`，该根始终授权。
pub async fn llm_transcribe(
    workspace: &WorkspaceFsAccess,
    args: TranscribeArgs,
) -> Result<TranscribeResult, String> {
    let base_url = args.base_url.trim();
    if base_url.is_empty() {
        return Err("base_url is required".to_string());
    }
    let path = workspace.resolve_existing(&args.path)?;
    let bytes = std::fs::read(&path).map_err(|error| format!("读取音频失败: {error}"))?;
    if bytes.is_empty() {
        return Err("音频文件为空".to_string());
    }
    if bytes.len() > TRANSCRIBE_MAX_BYTES {
        return Err(format!(
            "音频超过上限 {} MB，无法转写",
            TRANSCRIBE_MAX_BYTES / 1024 / 1024
        ));
    }
    let api_key = resolve_api_key(args.api_key_env.as_deref().unwrap_or(""))?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("audio")
        .to_string();
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(file_name)
        .mime_str("application/octet-stream")
        .map_err(|error| format!("构造音频分片失败: {error}"))?;
    let mut form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("response_format", "json");
    if !args.model.trim().is_empty() {
        form = form.text("model", args.model.trim().to_string());
    }
    if let Some(language) = args.language.as_deref().map(str::trim) {
        if !language.is_empty() {
            form = form.text("language", language.to_string());
        }
    }
    let client = crate::http::shared_client(60)?;
    let request = client
        .post(endpoint_url(base_url, "audio/transcriptions"))
        .multipart(form);
    let empty = HashMap::new();
    let headers = args.headers.as_ref().unwrap_or(&empty);
    let request = apply_auth(request, &api_key, headers)?;
    let response = request
        .send()
        .await
        .map_err(|error| format!("llm transcribe request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = crate::http::read_text(response, crate::http::RESPONSE_READ_TIMEOUT)
            .await
            .unwrap_or_default();
        return Err(format!(
            "llm transcribe returned {status}: {}（确认本地服务支持 /v1/audio/transcriptions）",
            truncate(&body, 200)
        ));
    }
    let body: serde_json::Value =
        crate::http::read_json(response, crate::http::RESPONSE_READ_TIMEOUT).await?;
    let text = body
        .get("text")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    Ok(TranscribeResult { text })
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
        assert_eq!(
            parse_sse_delta(chunk),
            Some(SseDelta {
                content: Some("你好".into()),
                reasoning: None
            })
        );
        // 空 delta：content 为空 → None 字段（不产出事件）
        assert_eq!(
            parse_sse_delta(r#"{"choices":[{"delta":{}}]}"#),
            Some(SseDelta::default())
        );
        // 无 choices 的帧（usage 等）→ None
        assert_eq!(parse_sse_delta(r#"{"usage":{"total_tokens":10}}"#), None);
        assert_eq!(parse_sse_delta("not-json"), None);
    }

    /// 思考链两种线上形状：reasoning_content（DeepSeek-R1/Qwen3）与 reasoning（Ollama/vLLM）。
    #[test]
    fn sse_delta_extracts_reasoning_from_both_shapes() {
        assert_eq!(
            parse_sse_delta(r#"{"choices":[{"delta":{"reasoning_content":"先想"}}]}"#),
            Some(SseDelta {
                content: None,
                reasoning: Some("先想".into())
            })
        );
        assert_eq!(
            parse_sse_delta(r#"{"choices":[{"delta":{"reasoning":"再想"}}]}"#),
            Some(SseDelta {
                content: None,
                reasoning: Some("再想".into())
            })
        );
        // 同一帧既有正文又有思考：两个字段都取到
        assert_eq!(
            parse_sse_delta(r#"{"choices":[{"delta":{"content":"答","reasoning_content":"思"}}]}"#),
            Some(SseDelta {
                content: Some("答".into()),
                reasoning: Some("思".into())
            })
        );
    }

    #[test]
    fn endpoint_url_builds_all_openai_paths() {
        assert_eq!(
            endpoint_url("http://localhost:11434", "models"),
            "http://localhost:11434/v1/models"
        );
        assert_eq!(
            endpoint_url("http://localhost:11434/v1/", "embeddings"),
            "http://localhost:11434/v1/embeddings"
        );
        assert_eq!(
            endpoint_url("http://localhost:9000/v1", "audio/transcriptions"),
            "http://localhost:9000/v1/audio/transcriptions"
        );
    }

    #[test]
    fn request_body_includes_sampling_params_only_when_set() {
        let params = InferenceParams {
            temperature: Some(0.2),
            max_tokens: Some(512),
        };
        let body = chat_request_body("m", vec![], "auto", &params);
        assert_eq!(body["temperature"], 0.2);
        assert_eq!(body["max_tokens"], 512);
        let bare = chat_request_body("m", vec![], "auto", &InferenceParams::default());
        assert!(bare.get("temperature").is_none());
        assert!(bare.get("max_tokens").is_none());
    }

    #[test]
    fn collect_model_ids_handles_both_shapes_and_dedups() {
        let openai: serde_json::Value =
            serde_json::from_str(r#"{"data":[{"id":"b"},{"id":"a"},{"id":"a"}]}"#).unwrap();
        assert_eq!(collect_model_ids(&openai), vec!["a", "b"]);
        let ollama: serde_json::Value =
            serde_json::from_str(r#"{"models":[{"name":"qwen2.5"},{"name":"llama3"}]}"#).unwrap();
        assert_eq!(collect_model_ids(&ollama), vec!["llama3", "qwen2.5"]);
        assert!(collect_model_ids(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn parse_embeddings_handles_three_shapes() {
        let openai: serde_json::Value =
            serde_json::from_str(r#"{"data":[{"embedding":[1,2]},{"embedding":[3,4]}]}"#).unwrap();
        assert_eq!(
            parse_embeddings(&openai).unwrap(),
            vec![vec![1.0, 2.0], vec![3.0, 4.0]]
        );
        let batch: serde_json::Value = serde_json::from_str(r#"{"embeddings":[[1,2]]}"#).unwrap();
        assert_eq!(parse_embeddings(&batch).unwrap(), vec![vec![1.0, 2.0]]);
        let single: serde_json::Value = serde_json::from_str(r#"{"embedding":[5,6]}"#).unwrap();
        assert_eq!(parse_embeddings(&single).unwrap(), vec![vec![5.0, 6.0]]);
        assert!(parse_embeddings(&serde_json::json!({"ok":true})).is_err());
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
        let body = chat_request_body("gpt-test", messages, "auto", &InferenceParams::default());
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
        let body = chat_request_body("gpt-test", messages, "high", &InferenceParams::default());
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
        let body = chat_request_body("gpt-test", vec![], "auto", &InferenceParams::default());
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

    /// 思考链增量与正文增量都从同一个 SSE 流里解析出来，各自成为事件。
    #[tokio::test]
    async fn drain_sse_emits_thinking_and_content_events() {
        let stream = futures_util::stream::iter(vec![
            sse_chunk(r#"{"choices":[{"delta":{"reasoning_content":"想"}}]}"#),
            sse_chunk_delta("答"),
            sse_chunk("[DONE]"),
        ]);
        let events = drain_sse(stream, Duration::from_secs(5)).await;
        assert_eq!(
            events,
            vec![
                SseEvent::Thinking("想".into()),
                SseEvent::Delta("答".into()),
                SseEvent::Done,
            ]
        );
    }

    #[tokio::test]
    async fn llm_list_models_parses_openai_and_ollama_shapes() {
        let openai = r#"{"data":[{"id":"qwen2.5"},{"id":"llama3.2"}]}"#.to_string();
        let url = mock_completions_server(openai, "application/json").await;
        let models = llm_list_models(ListModelsArgs {
            base_url: url,
            api_key_env: Some(mock_api_key_env()),
            headers: None,
        })
        .await
        .expect("listed");
        assert_eq!(models, vec!["llama3.2", "qwen2.5"]);
    }

    #[tokio::test]
    async fn llm_embed_reads_vectors_and_dim() {
        let body = r#"{"data":[{"embedding":[1,2,3]},{"embedding":[0.5,0.25,0.125]}]}"#.to_string();
        let url = mock_completions_server(body, "application/json").await;
        let result = llm_embed(EmbedArgs {
            base_url: url,
            model: "bge-m3".into(),
            api_key_env: Some(mock_api_key_env()),
            headers: None,
            input: vec!["a".into(), "b".into()],
        })
        .await
        .expect("embedded");
        assert_eq!(result.dim, 3);
        assert_eq!(result.embeddings.len(), 2);
        assert_eq!(result.model, "bge-m3");
    }

    /// 空输入不该发请求（避免无谓往返），直接回空结果。
    #[tokio::test]
    async fn llm_embed_empty_input_skips_request() {
        let result = llm_embed(EmbedArgs {
            base_url: "http://127.0.0.1:1".into(),
            model: "m".into(),
            api_key_env: None,
            headers: None,
            input: vec![],
        })
        .await
        .expect("empty ok");
        assert!(result.embeddings.is_empty());
        assert_eq!(result.dim, 0);
    }

    #[tokio::test]
    async fn llm_transcribe_reads_authorized_audio_and_returns_text() {
        let tmp = std::env::temp_dir().join(format!("gw-transcribe-{}", std::process::id()));
        let root = tmp.join("root");
        std::fs::create_dir_all(&root).expect("mkdir");
        let audio = root.join("voice.wav");
        std::fs::write(&audio, b"RIFFfake-audio-bytes").expect("write audio");
        let workspace =
            WorkspaceFsAccess::new(&root, tmp.join("access.json")).expect("workspace access");

        let url =
            mock_completions_server(r#"{"text":"  你好世界  "}"#.to_string(), "application/json")
                .await;
        let result = llm_transcribe(
            &workspace,
            TranscribeArgs {
                base_url: url,
                model: "whisper-1".into(),
                api_key_env: Some(mock_api_key_env()),
                headers: None,
                path: audio.to_string_lossy().to_string(),
                language: Some("zh".into()),
            },
        )
        .await
        .expect("transcribed");
        assert_eq!(result.text, "你好世界");
    }

    /// 授权面外的路径不得被转写读取（与 fs 读同一条边界）。
    #[tokio::test]
    async fn llm_transcribe_rejects_unauthorized_path() {
        let tmp = std::env::temp_dir().join(format!("gw-transcribe-deny-{}", std::process::id()));
        let root = tmp.join("root");
        let outside = tmp.join("outside");
        std::fs::create_dir_all(&root).expect("mkdir root");
        std::fs::create_dir_all(&outside).expect("mkdir outside");
        let audio = outside.join("secret.wav");
        std::fs::write(&audio, b"x").expect("write");
        let workspace =
            WorkspaceFsAccess::new(&root, tmp.join("access.json")).expect("workspace access");
        let error = llm_transcribe(
            &workspace,
            TranscribeArgs {
                base_url: "http://127.0.0.1:1".into(),
                model: "whisper-1".into(),
                api_key_env: None,
                headers: None,
                path: audio.to_string_lossy().to_string(),
                language: None,
            },
        )
        .await
        .expect_err("unauthorized");
        assert!(error.contains("未获用户授权"), "{error}");
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
