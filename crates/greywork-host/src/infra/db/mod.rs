//! 数据面：SQLite 会话存储（P0）。
//!
//! 设计约束（对齐「IPC 大 content 修正」）：
//! - 正文真库归位：ThreadMessage 全文以 JSON payload 存入 messages 表；
//!   渲染端不再是会话数据的唯一真源，localStorage 仅作首帧缓存。
//! - 单进程单写者：`std::sync::Mutex<Connection>`，command 为同步 fn（本地
//!   微秒级事务，不进 tokio）。
//! - 迁移链：`PRAGMA user_version` 顺序推进，新列/新表只追加迁移不回头改。
//! - 快照形状与前端 `PersistedSessions`（v2）1:1：会话行拆列存储，消息不透明
//!   （前端 ThreadMessage 类型演进不需要后端同步迁移）。
//! - `meta.initialized` 标记区分「空库（未接管）」与「真源（零会话）」：
//!   前端仅在未接管时用本地种子/缓存填充并回写，避免清空会话后重启又冒种子。
//!
//! 模块划分：DTO 在 [`dto`]；建库/迁移在 [`lifecycle`] / [`schema`]；按聚合拆
//! [`sessions`] / [`settings`] / [`automations`] / [`agents`] / [`team_runs`] / [`rag`]；
//! 命令薄壳在 [`commands`]。

use parking_lot::Mutex;
use rusqlite::Connection;

mod agents;
mod args;
mod automations;
mod dto;
mod lifecycle;
mod rag;
mod schema;
mod sessions;
mod settings;
mod team_runs;

#[cfg(test)]
mod tests;

pub use args::*;
pub use dto::*;

/// 全局数据库状态（setup 阶段打开，经 Tauri manage 注入）。
pub struct Db {
    conn: Mutex<Connection>,
}
