//! 本机 agent 回合循环：请求 → 工具 → 回填 → 再请求，直到模型给出最终答复。
//!
//! 循环放在宿主侧而不是渲染端，三个理由：
//! - 只读工具在三档权限里都自动放行，循环里没有任何需要用户点确认的分支，所以不必
//!   依赖 UI 才能推进 —— 远程助手（`stores/remote-assistant/pipeline.ts`）与自动化任务
//!   的宿主兜底执行（`host_exec.rs`）能直接复用同一套。
//! - 中止只要 abort 掉一个 `JoinHandle`，与 `llm_chat_stop` 同构。
//! - 工具执行只有一处实现（`tools::execute`），不会随入口分裂出两份授权逻辑。
//!
//! 两个必须显式处理的协议细节：
//! - **`arguments` 可能不是合法 JSON**（模型幻觉、分片拼接出错都可能导致）。不能崩：
//!   解析失败就回一条错误 `tool` 消息，模型看到自己的参数不合法会重发。
//! - **触顶后要收尾回合**。直接掐断会让最后一段工具调用悬在半空、消息流没有结论；
//!   追加一次 `tool_choice: "none"` 的请求，模型看得见工具清单但不能再调，只能给结论。

use std::collections::HashMap;
use std::time::Duration;

use serde_json::{json, Value};

use crate::host::HostContext;
use crate::llm::agent::tools::{execute, tool_schemas};
use crate::llm::events::{
    emit_delta, emit_done, emit_error, emit_thinking, emit_tool_call, emit_tool_result,
};
use crate::llm::sse::{
    content_from_completion, drain_sse_into, tool_calls_from_completion, DeltaBatcher, SseEvent,
    ToolCall, ToolCallAccumulator,
};
use crate::llm::transport::{is_sse_response, send_chat_request, ChatRequest, ToolMode};
use crate::log;
use crate::workspace_fs::WorkspaceFsAccess;

/// 与纯聊天路径同源的空闲超时：连接挂着但长时间无字节，按错误终止。
const IDLE_TIMEOUT_SECS: u64 = 60;

/// 工具回合的默认上限。
///
/// 12 轮不是随手取的：只读三件套下，一个「这个功能在哪实现 / 为什么这么写」的典型问题
/// 在 3-5 轮内收敛；12 轮覆盖了「先 git_log 摸现状 → list_dir 定位 → read_file 读两三个
/// 文件 → 交叉验证」的长路径，同时把最坏情况（模型在两个工具间反复横跳）的成本钉在
/// 12 × (1 次 HTTP + N 次本地读) 以内。触顶不是失败 —— 会走收尾回合出结论。
pub const DEFAULT_MAX_ROUNDS: u32 = 12;

/// 回合硬上限：调用方可传更大的值，但不能没有 —— 一个永不收敛的 agent 回合会一直
/// 占着连接和上下文，比答错更糟。
pub const HARD_MAX_ROUNDS: u32 = 32;

/// 一次 agent 回合的入参。
pub(super) struct AgentTurn {
    pub(super) base_url: String,
    pub(super) model: String,
    pub(super) api_key_env: String,
    pub(super) messages: Vec<Value>,
    pub(super) reasoning_effort: String,
    pub(super) headers: HashMap<String, String>,
    pub(super) temperature: Option<f64>,
    pub(super) max_tokens: Option<u32>,
    pub(super) max_rounds: u32,
    pub(super) client_token: String,
}

/// 一轮模型响应的产物：本轮正文与本轮工具调用。
struct RoundOutcome {
    /// 本轮输出的正文（模型可能先说一句再调工具；这段也要回填，否则它看不到自己说过什么）。
    content: String,
    calls: Vec<ToolCall>,
}

/// 跑完一个 agent 回合。所有出口都保证发出 `llm-done` 或 `llm-error`。
pub(super) async fn run(host: &dyn HostContext, access: &WorkspaceFsAccess, turn: AgentTurn) {
    if let Err(error) = drive(host, access, &turn).await {
        log::error("llm-agent", format!("回合失败: {error}"));
        emit_error(host, &turn.client_token, error);
        return;
    }
    emit_done(host, &turn.client_token);
}

async fn drive(
    host: &dyn HostContext,
    access: &WorkspaceFsAccess,
    turn: &AgentTurn,
) -> Result<(), String> {
    let schemas = tool_schemas();
    let max_rounds = turn.max_rounds.clamp(1, HARD_MAX_ROUNDS);
    let params = crate::llm::InferenceParams {
        temperature: turn.temperature,
        max_tokens: turn.max_tokens,
    };
    let mut history: Vec<Value> = turn.messages.clone();
    let mut accumulator = ToolCallAccumulator::default();

    // 端点 / 模型 / 推理档位 / 采样参数在整回合里不变，只有 messages 每轮增长；
    // 请求参数因此只组装一次，循环里只切工具模式。
    let request = ChatRequest {
        base_url: &turn.base_url,
        model: &turn.model,
        api_key_env: &turn.api_key_env,
        reasoning_effort: &turn.reasoning_effort,
        headers: &turn.headers,
        params: &params,
        tools: ToolMode::None,
    };
    // `round < max_rounds` 是工具回合；最后一轮是收尾回合（`tool_choice: none`）。
    for round in 0..=max_rounds {
        let request = ChatRequest {
            tools: if round < max_rounds {
                ToolMode::Auto(&schemas)
            } else {
                ToolMode::Disable(&schemas)
            },
            ..request
        };
        let response = send_chat_request(request, history.clone()).await?;
        let outcome = drain_round(host, response, &turn.client_token, &mut accumulator).await?;

        // 没有工具调用 = 模型给出了最终答复，收尾。
        if outcome.calls.is_empty() {
            if round == max_rounds && outcome.content.trim().is_empty() {
                return Err(format!(
                    "工具回合用了满 {max_rounds} 轮仍未给出结论；可提高回合上限或缩小问题范围"
                ));
            }
            return Ok(());
        }
        if round == max_rounds {
            // 收尾回合本不该再拿到调用（tool_choice: none）。拿到了说明端点不认这个字段：
            // 再执行一轮只会无限循环，直接把这一轮挂起的调用回填成错误让模型收尾。
            return Err(format!(
                "端点未遵守 tool_choice=none，第 {max_rounds} 轮后仍在请求工具；已中止该回合"
            ));
        }

        // assistant 消息：正文 + tool_calls。content 用空串而非 null —— 部分端点对
        // `content: null` 直接 400，而「这一轮只有工具调用没说话」是常态。
        history.push(json!({
            "role": "assistant",
            "content": outcome.content,
            "tool_calls": outcome.calls.iter().map(wire_tool_call).collect::<Vec<_>>(),
        }));

        for call in &outcome.calls {
            let input = parse_arguments(&call.arguments);
            emit_tool_call(
                host,
                &turn.client_token,
                &call.id,
                &call.name,
                &input,
                round,
            );
            let output = execute(access, &call.name, &input);
            log::info(
                "llm-agent",
                format!(
                    "round={round} tool={} ok={}",
                    call.name,
                    output.error.is_none()
                ),
            );
            emit_tool_result(host, &turn.client_token, &call.id, &output);
            history.push(json!({
                "role": "tool",
                "tool_call_id": call.id,
                "content": output.content,
            }));
        }
    }
    unreachable!("循环必然在 max_rounds 轮内返回")
}

/// 解析模型的 `arguments`。非法 JSON 不是致命错误：回一条空对象让 `tools::execute`
/// 报「缺少参数 path」，模型据此重发；崩掉则整个回合白跑。
fn parse_arguments(raw: &str) -> Value {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return json!({});
    }
    serde_json::from_str(trimmed).unwrap_or_else(|error| {
        log::error("llm-agent", format!("arguments 不是合法 JSON: {error}"));
        json!({})
    })
}

/// `assistant.tool_calls` 的 wire 形状。
fn wire_tool_call(call: &ToolCall) -> Value {
    json!({
        "id": call.id,
        "type": "function",
        "function": {
            "name": call.name,
            // 必须是字符串（协议如此），空串表示「模型没给参数」，由 execute 报错。
            "arguments": call.arguments,
        },
    })
}

/// 消费一个回合的流，边下发正文 / 思考边把工具调用分片喂给累积器。
async fn drain_round(
    host: &dyn HostContext,
    response: reqwest::Response,
    client_token: &str,
    accumulator: &mut ToolCallAccumulator,
) -> Result<RoundOutcome, String> {
    let mut content = String::new();
    let mut content_batcher = DeltaBatcher::new();
    let mut thinking_batcher = DeltaBatcher::new();

    if !is_sse_response(&response) {
        // 非流式：一次性拿全文与全部调用（端点忽略 stream 时）。
        let body: Value =
            crate::http::read_json(response, crate::http::RESPONSE_READ_TIMEOUT).await?;
        if let Some(text) = content_from_completion(&body) {
            content.push_str(&text);
            emit_delta(host, client_token, text);
        }
        let calls = tool_calls_from_completion(&body);
        // 与流式路径对齐：正文攒够一个合批窗口也要发出去，否则调用工具期间正文是死的。
        if let Some(batch) = content_batcher.finish() {
            emit_delta(host, client_token, batch);
        }
        return Ok(RoundOutcome { content, calls });
    }

    let mut terminal: Option<SseEvent> = None;
    drain_sse_into(
        response.bytes_stream(),
        Duration::from_secs(IDLE_TIMEOUT_SECS),
        |event| match event {
            SseEvent::Delta(delta) => {
                content.push_str(&delta);
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
            SseEvent::ToolCalls(chunks) => {
                accumulator.push(&chunks);
                true
            }
            terminal_event => {
                terminal = Some(terminal_event);
                false
            }
        },
    )
    .await;
    // 终止事件之前必须把缓冲发出去，否则本轮最后一段正文会丢。
    if let Some(batch) = content_batcher.finish() {
        emit_delta(host, client_token, batch);
    }
    if let Some(batch) = thinking_batcher.finish() {
        emit_thinking(host, client_token, batch);
    }
    if let Some(SseEvent::Error(message)) = terminal {
        return Err(message);
    }
    Ok(RoundOutcome {
        content,
        calls: accumulator.take(),
    })
}
