//! `llm://event` 的唯一出口。
//!
//! chat 与 agent 两条路径（以及将来的第三条）都从这里发事件，理由是 `clientToken`
//! 的注入语义必须只有一份：`llm://event` 是**全局广播**（会话流与远程助手回复可能并行），
//! 消费方凭这个令牌过滤出属于自己那一笔。两处各写一遍，迟早在「空令牌算不算旧调用方」
//! 这类边角上分叉。

use serde_json::{json, Value};

use crate::host::HostContext;

/// 事件信封：统一 kind + payload（与 acp_host 的 AcpEventEnvelope 同构）。
#[derive(serde::Serialize, Clone)]
struct LlmEventEnvelope {
    kind: &'static str,
    payload: Value,
}

/// 发一条 LLM 事件；带上调用方令牌（空令牌 = 旧调用方，事件不带该字段）。
pub(super) fn emit_llm(
    host: &dyn HostContext,
    client_token: &str,
    kind: &'static str,
    mut payload: Value,
) {
    if !client_token.is_empty() {
        if let Some(object) = payload.as_object_mut() {
            object.insert(
                "clientToken".into(),
                Value::String(client_token.to_string()),
            );
        }
    }
    crate::host::emit_json(host, "llm://event", LlmEventEnvelope { kind, payload });
}

/// 发一条正文增量。合批后仍走 `llm-delta` + `delta` 字段，前端契约不变（接收侧本就是累加）。
pub(super) fn emit_delta(host: &dyn HostContext, client_token: &str, delta: String) {
    emit_llm(host, client_token, "llm-delta", json!({ "delta": delta }));
}

/// 发一条思考链增量（DeepSeek-R1 / Qwen3 / Ollama 的 reasoning）。
/// 与正文分开一个 kind：前端渲染成「思考段」，与 ACP 的 AgentThoughtChunk 对齐。
pub(super) fn emit_thinking(host: &dyn HostContext, client_token: &str, delta: String) {
    emit_llm(
        host,
        client_token,
        "llm-thinking-delta",
        json!({ "delta": delta }),
    );
}

/// 发一条工具调用请求（模型决定调某个工具）。前端据此开一行工具时间线。
pub(super) fn emit_tool_call(
    host: &dyn HostContext,
    client_token: &str,
    id: &str,
    name: &str,
    input: &Value,
    round: u32,
) {
    emit_llm(
        host,
        client_token,
        "llm-tool-call",
        json!({
            "id": id,
            "name": name,
            "input": input,
            "round": round,
        }),
    );
}

/// 发一条工具执行结果（成功或失败）。`output` 是回给模型的那段文本的截断预览。
pub(super) fn emit_tool_result(
    host: &dyn HostContext,
    client_token: &str,
    id: &str,
    output: &crate::llm::agent::tools::ToolOutput,
) {
    emit_llm(
        host,
        client_token,
        "llm-tool-result",
        json!({
            "id": id,
            "ok": output.error.is_none(),
            "error": output.error,
            "summary": output.summary,
            "path": output.path,
            // 只送预览：完整输出可能上万字符，前端时间线不需要，而事件是全局广播的。
            "preview": crate::llm::truncate(&output.content, 400),
        }),
    );
}

/// 回合正常结束。
pub(super) fn emit_done(host: &dyn HostContext, client_token: &str) {
    emit_llm(host, client_token, "llm-done", json!({}));
}

/// 回合失败。`message` 直接进消息流（与既有 `llm-error` 契约一致）。
pub(super) fn emit_error(host: &dyn HostContext, client_token: &str, message: String) {
    emit_llm(
        host,
        client_token,
        "llm-error",
        json!({ "message": message }),
    );
}
