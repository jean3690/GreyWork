//! 命令实现入口与入参。

use crate::core::ports::WorkspaceFs;
use crate::db::{Db, SessionsSnapshotDto};
use crate::host::HostContext;

use super::dto::{RelocateReportDto, RelocateRequestDto, SyncReportDto, WorkspaceDirDto};
use super::lock::StoreLock;
use super::paths::{
    default_root, prune_session_attachments, validate_authorized_folder,
    validate_authorized_workspaces,
};
use super::snapshot::{migrate_from_db, read_snapshot, relocate_sessions, write_snapshot};

/// 读全量会话快照（文件面；未就绪 → null）。含 SQLite → 文件一次性迁移。
pub fn store_sessions_load(
    host: &dyn HostContext,
    db: &Db,
    access: &dyn WorkspaceFs,
    workspaces: Vec<WorkspaceDirDto>,
) -> Result<Option<SessionsSnapshotDto>, String> {
    validate_authorized_workspaces(access, &workspaces)?;
    let root = default_root(&host.paths().home_dir)?;
    let _lock = StoreLock::acquire(&root)?;
    if let Some(migrated) = migrate_from_db(&root, db, &workspaces)? {
        return Ok(Some(migrated));
    }
    read_snapshot(&root, &workspaces)
}

/// 增量同步会话快照（调用方为渲染端 debounce 持久层）。
///
/// `deleted_session_ids` 是本次要落实的删除清单：只删它，绝不扫目录清扫，
/// 否则多实例并发时会互删对方新建的会话。
pub fn store_sessions_sync(
    host: &dyn HostContext,
    access: &dyn WorkspaceFs,
    snapshot: SessionsSnapshotDto,
    workspaces: Vec<WorkspaceDirDto>,
    deleted_session_ids: Vec<String>,
) -> Result<SyncReportDto, String> {
    validate_authorized_workspaces(access, &workspaces)?;
    let root = default_root(&host.paths().home_dir)?;
    let _lock = StoreLock::acquire(&root)?;
    write_snapshot(&root, &snapshot, &workspaces, &deleted_session_ids)
}

/// 工作区改绑文件夹后把既有会话文件搬到新目录。
pub fn store_sessions_relocate(
    host: &dyn HostContext,
    access: &dyn WorkspaceFs,
    request: RelocateRequestDto,
) -> Result<RelocateReportDto, String> {
    if let Some(folder) = request
        .from_folder
        .as_deref()
        .filter(|folder| !folder.is_empty())
    {
        validate_authorized_folder(access, folder)?;
    }
    if let Some(folder) = request
        .to_folder
        .as_deref()
        .filter(|folder| !folder.is_empty())
    {
        validate_authorized_folder(access, folder)?;
    }
    let root = default_root(&host.paths().home_dir)?;
    let _lock = StoreLock::acquire(&root)?;
    relocate_sessions(&root, &request)
}

/// 默认数据根（`~/.greyWork`）——前端产物默认落盘目录基准。
pub fn store_default_root(host: &dyn HostContext) -> Result<String, String> {
    // 这里没有 canonicalize（路径来自 home_dir），本来就不带 `\\?\`；照样过一遍是为了
    // 让「离开宿主的路径一律不带 verbatim 前缀」成为一条不用逐个核对的规则。
    default_root(&host.paths().home_dir)
        .map(|root| crate::path_safety::strip_verbatim_prefix(&root.to_string_lossy()))
}

/// 删除某会话的附件目录（会话被删除时调用）：只删 `<root>/attachments/<会话id>`，
/// 其余路径一律拒绝，且目录不存在时按已删处理。
pub fn attachments_prune_session(host: &dyn HostContext, session_id: String) -> Result<(), String> {
    let root = default_root(&host.paths().home_dir)?;
    prune_session_attachments(&root, &session_id)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsLoadArgs {
    pub workspaces: Vec<WorkspaceDirDto>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsSyncArgs {
    pub snapshot: SessionsSnapshotDto,
    pub workspaces: Vec<WorkspaceDirDto>,
    pub deleted_session_ids: Vec<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PruneSessionArgs {
    pub session_id: String,
}
