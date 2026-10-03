//! LLM 命令的桌面薄包装；实现收在 `greywork_host::llm`（与 headless 服务端共用）。

use std::collections::HashMap;
use std::sync::Arc;

use greywork_host::host::HostContext;
use greywork_host::llm::{
    EmbedArgs, EmbedResult, InferenceParams, ListModelsArgs, LlmChatMessage, LlmHost,
    TranscribeArgs, TranscribeResult,
};
use tauri::State;

use crate::workspace_fs::WorkspaceFsAccess;

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
    temperature: Option<f64>,
    max_tokens: Option<u32>,
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
        InferenceParams {
            temperature,
            max_tokens,
        },
        client_token,
    )
    .await
}

/// 中止进行中的流任务并回收句柄。
#[tauri::command]
pub async fn llm_chat_stop(state: State<'_, LlmHost>, request_id: u64) -> Result<(), String> {
    greywork_host::llm::llm_chat_stop(&state, request_id).await
}

/// 拉取模型清单（设置页模型下拉 + 连通性自检）。
#[tauri::command]
pub async fn llm_list_models(
    base_url: String,
    api_key_env: Option<String>,
    headers: Option<HashMap<String, String>>,
) -> Result<Vec<String>, String> {
    greywork_host::llm::llm_list_models(ListModelsArgs {
        base_url,
        api_key_env,
        headers,
    })
    .await
}

/// 批量取向量（本地 RAG）。
#[tauri::command]
pub async fn llm_embed(
    base_url: String,
    model: String,
    api_key_env: Option<String>,
    headers: Option<HashMap<String, String>>,
    input: Vec<String>,
) -> Result<EmbedResult, String> {
    greywork_host::llm::llm_embed(EmbedArgs {
        base_url,
        model,
        api_key_env,
        headers,
        input,
    })
    .await
}

/// 语音转写：音频以授权路径给出（附件落在授权根内）。
#[tauri::command]
pub async fn llm_transcribe(
    access: State<'_, WorkspaceFsAccess>,
    base_url: String,
    model: String,
    api_key_env: Option<String>,
    headers: Option<HashMap<String, String>>,
    path: String,
    language: Option<String>,
) -> Result<TranscribeResult, String> {
    greywork_host::llm::llm_transcribe(
        &*access,
        TranscribeArgs {
            base_url,
            model,
            api_key_env,
            headers,
            path,
            language,
        },
    )
    .await
}
