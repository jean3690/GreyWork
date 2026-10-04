//! GreyWork 宿主领域逻辑（**不依赖 Tauri**）。
//!
//! 桌面壳（`apps/desktop/src-tauri`）与 headless 服务端（`apps/server`）共用本 crate，
//! 避免命令面出现两份会漂移的实现。
//!
//! 边界约定：本 crate 只放「与具体宿主无关」的逻辑。任何需要宿主出口的能力
//! （事件广播、系统通知、路径来源）都应通过 [`host::HostContext`] 注入，而不是在本
//! crate 里直接引 tauri。
//!
//! # 分层
//!
//! 代码按职责分五层存放，依赖只能自上而下（L0 ← L1 ← L2 ← L3 ← L4）：
//!
//! | 层 | 目录 | 职责 |
//! |---|---|---|
//! | L0 core | `core/` | 出口契约、端口 trait、纯原语 |
//! | L1 infra | `infra/` | 本机资源适配器（db / 工作区 / git / 进程 / 沙箱） |
//! | L2 services | `services/` | 外部服务集成（llm / rag / acp / mcp / 市场 / 办公…） |
//! | L3 channels | `channels/` | 聊天通道（common / media + 7 条通道） |
//! | L4 app | `app/` | 组合根、命令注册表 |
//!
//! # 对外路径（加法式 facade）
//!
//! 各层用**私有** `mod` 声明，再逐叶子 `pub use` 回根。因此外部调用方看到的仍是
//! 扁平的 `greywork_host::<mod>::<Type>`（如 `greywork_host::db::Db`、
//! `greywork_host::commands::CommandContext`、`greywork_host::wechat::WechatHost`），
//! 与分层前**完全一致** —— apps 无需同步改动。层内代码则可用 `crate::services::llm`
//! 这类带层的路径。

// 分层模块：L0 core / L1 infra / L2 services / L3 channels / L4 app。
mod app;
mod channels;
mod core;
mod infra;
mod services;

pub use app::commands;
pub use channels::{
    common as channel_common, dingtalk, discord, feishu, media as channel_media, qq, telegram,
    wechat, wecom,
};
pub use core::{csp, host, log, path_safety, ports, text};
pub use infra::{db, git, http, process_guard, sandbox, sheet, store_fs, workspace_fs, worktree};
pub use services::{
    acp_host, acp_process, bundled_skills, cron, host_exec, llm, mcp, mcp_registry, office,
    plugin_market, rag, scheduler, skills_market, sys, update, web_fetch,
};
