//! LLM 命令的桌面薄包装；实现收在 `greywork_host::llm`（与 headless 服务端共用）。

use std::collections::HashMap;
use std::sync::Arc;

use greywork_host::host::HostContext;
use greywork_host::llm::{LlmChatMessage, LlmHost};
use tauri::State;

/// 发起一轮流式对话；返回请求 id（用于 llm_chat_stop 中止）。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn llm_chat_start(
    host: State<'_, Arc<dyn HostContext>>,
    state: State<'_, LlmHost>,
    base_url: String,
    model: String,
    api_key_env: String,
    messages: Vec<LlmChatMessage>,
    reasoning_effort: String,
    headers: Option<HashMap<String, String>>,
    client_token: Option<String>,
) -> Result<u64, String> {
    greywork_host::llm::llm_chat_start(
        host.inner().clone(),
        &state,
        base_url,
        model,
        api_key_env,
        messages,
        reasoning_effort,
        headers,
        client_token,
    )
    .await
}

/// 中止进行中的流任务并回收句柄。
#[tauri::command]
pub async fn llm_chat_stop(state: State<'_, LlmHost>, request_id: u64) -> Result<(), String> {
    greywork_host::llm::llm_chat_stop(&state, request_id).await
}
