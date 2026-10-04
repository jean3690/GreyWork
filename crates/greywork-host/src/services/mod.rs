//! L2 services：外部服务集成（LLM / RAG / ACP / MCP / 市场 / 更新 / 办公 / 调度 / 系统信息）。
//!
//! 本层依赖 L0 core 与 L1 infra，向上为 L3 channels / L4 app 提供能力。

pub mod acp_host;
pub mod acp_process;
pub mod bundled_skills;
pub mod cron;
pub mod host_exec;
pub mod llm;
pub mod mcp;
pub mod mcp_registry;
pub mod office;
pub mod plugin_market;
pub mod rag;
pub mod scheduler;
pub mod skills_market;
pub mod sys;
pub mod update;
pub mod web_fetch;
