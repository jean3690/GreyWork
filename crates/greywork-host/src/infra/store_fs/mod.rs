//! 会话文件存储（P0 数据面 v3）。
//!
//! 目标布局（用户确认）：
//! - 默认（无工作区）：`~/.greyWork/sessions/<会话id>.json`
//! - 绑定工作区：`<工作区文件夹>/.greyWork/sessions/<会话id>.json`
//! - 活动会话：`~/.greyWork/active.json`；就绪标记：`~/.greyWork/.ready`
//!
//! 语义与旧 SQLite 会话面 1:1 对齐：
//! - `read` 在未就绪时返回 None → 前端以本地缓存/种子为真源并回写（避免清空后复活种子）；
//! - 迁移：SQLite 已接管（meta.initialized）而文件面未就绪时，把库快照一次性导出成文件。
//!
//! sync 为**增量**替换（v3.1，多实例安全）：
//! - 内容逐字节相同 → 跳过写（不刷 mtime，省掉整目录重写）；
//! - 磁盘 `updatedAt` 严格更新 → 判为冲突，**不覆盖**，回报给前端由它按条合并；
//! - 删除只按调用方显式给出的 `deletedSessionIds` 执行 —— 不再扫目录把「不在快照里的
//!   文件」当垃圾清掉，否则两个实例同时开着时，A 的全量同步会删掉 B 刚建的会话。
//! - 所有命令在 `~/.greyWork/.lock` 上互斥（目录锁 + 陈旧接管），保证跨进程串行。
//!
//! 消息负载不透明（ThreadMessage 全文 JSON 往返，零解析）。
//!
//! # 子模块
//!
//! - [`dto`]：对外 DTO；
//! - [`lock`]：跨进程存储锁（目录锁 + 陈旧接管）；
//! - [`paths`]：路径 / 目录解析与文件工具（含附件目录、活动会话、就绪标记）；
//! - [`snapshot`]：读 / 写 / 搬迁 / 迁移；
//! - [`commands`]：命令实现入口与入参。

mod commands;
mod dto;
mod lock;
mod paths;
mod snapshot;

#[cfg(test)]
mod tests;

pub use commands::{
    attachments_prune_session, store_default_root, store_sessions_load, store_sessions_relocate,
    store_sessions_sync, PruneSessionArgs, SessionsLoadArgs, SessionsSyncArgs,
};
pub use dto::{ConflictDto, RelocateReportDto, RelocateRequestDto, SyncReportDto, WorkspaceDirDto};
pub use paths::{default_root, prune_session_attachments};
pub use snapshot::{migrate_from_db, read_snapshot, relocate_sessions, write_snapshot};

pub const GREY_WORK_DIR: &str = ".greyWork";
pub const SESSIONS_SUB_DIR: &str = "sessions";
/// 会话附件目录（渲染端 `state/attachment-library.ts` 按同一布局写入）。
pub const ATTACHMENTS_SUB_DIR: &str = "attachments";
