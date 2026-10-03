//! LLM 直连（openai-compatible `/chat/completions` 流式）。
//!
//! 设计约束：
//! - 密钥只在 Rust 宿主从环境变量解析；渲染端仅传变量名，密钥永不进入前端。
//! - 流式增量经 `llm://event` 转发，kind：`llm-delta` / `llm-done` / `llm-error`。
//!   事件信封与 acp_host 同构，前端按 kind 分流。
//! - 服务端若忽略 `stream:true` 返回整段 JSON，按非流式路径一次性下发。
//! - Anthropic / Ollama 均提供 openai-compatible 端点，Phase 1 统一走该线格式。

mod chat;
mod dto;
mod embeddings;
mod models;
mod sse;
mod transcribe;
mod transport;

#[cfg(test)]
mod tests;

pub use chat::{chat_complete, llm_chat_start, llm_chat_stop, LlmHost};
pub use dto::{
    ChatStartArgs, ChatStopArgs, InferenceParams, ListModelsArgs, LlmChatMessage, TranscribeArgs,
    TranscribeResult,
};
pub use embeddings::{llm_embed, LlmEmbedder};
pub use models::llm_list_models;
pub use transcribe::llm_transcribe;

pub use crate::core::ports::{EmbedArgs, EmbedResult};

pub(crate) use transport::{env_set_hint, resolve_header_placeholders, truncate};
