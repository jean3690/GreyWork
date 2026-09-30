//! GreyWork 宿主领域逻辑（**不依赖 Tauri**）。
//!
//! 桌面壳（`apps/desktop/src-tauri`）与 headless 服务端（`apps/server`）共用本 crate，
//! 避免命令面出现两份会漂移的实现。
//!
//! 边界约定：本 crate 只放「与具体宿主无关」的逻辑。任何需要宿主出口的能力
//! （事件广播、系统通知、路径来源）都应通过 `host::HostContext` 注入，而不是在本
//! crate 里直接引 tauri。目前仍留在桌面壳里的模块（`acp_host` / `channel_media` /
//! 各通道 / `sys` 等）会在后续阶段逐步搬进来 —— 它们现在还用 `AppHandle` 发事件。

pub mod acp_host;
pub mod acp_process;
pub mod bundled_skills;
pub mod channel_common;
pub mod channel_media;
pub mod commands;
pub mod cron;
pub mod csp;
pub mod db;
pub mod dingtalk;
pub mod discord;
pub mod feishu;
pub mod git;
pub mod host;
pub mod host_exec;
pub mod http;
pub mod llm;
pub mod log;
pub mod mcp;
pub mod mcp_registry;
pub mod office;
pub mod path_safety;
pub mod plugin_market;
pub mod process_guard;
pub mod qq;
pub mod sandbox;
pub mod scheduler;
pub mod sheet;
pub mod skills_market;
pub mod store_fs;
pub mod sys;
pub mod telegram;
pub mod text;
pub mod update;
pub mod web_fetch;
pub mod wechat;
pub mod wecom;
pub mod workspace_fs;
pub mod worktree;
