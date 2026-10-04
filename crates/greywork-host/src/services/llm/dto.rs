//! LLM 命令入参与数据形状。

use std::collections::HashMap;

use serde::Deserialize;
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

/// 采样参数（temperature / max_tokens）：仅显式设置才写进请求体。
///
/// 本地模型常见的「确定性 / 限长」诉求靠这两项，但对不支持的端点写进去等于拒收整个请求，
/// 所以缺省一律不传（与 `reasoning_effort` 的 auto 同款策略）。
#[derive(Debug, Default, Clone, Copy)]
pub struct InferenceParams {
    pub temperature: Option<f64>,
    pub max_tokens: Option<u32>,
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

/// `llm_embed` 的入参 / 结果形状定义在端口层（见 [`crate::core::ports`]），此处再导出，
/// 保持 `llm::EmbedArgs` / `llm::EmbedResult` 旧路径可用。
pub use crate::core::ports::{EmbedArgs, EmbedResult};

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
