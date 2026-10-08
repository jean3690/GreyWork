//! 隔离工作树的桌面命令入口；实现收在 `greywork_host::worktree`（与 headless 服务端共用）。

use std::sync::Arc;

use tauri::State;

use greywork_host::host::HostContext;
use greywork_host::workspace_fs::WorkspaceFsAccess;

pub use greywork_host::worktree::{WorktreeEntryDto, WorktreeProvisionDto};

#[tauri::command]
pub fn worktree_provision(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    access: State<'_, Arc<WorkspaceFsAccess>>,
    source: String,
    prepare: Option<bool>,
) -> Result<WorktreeProvisionDto, String> {
    greywork_host::worktree::worktree_provision(
        host_ctx.inner().as_ref(),
        &**access,
        source,
        prepare.unwrap_or(false),
    )
}

#[tauri::command]
pub fn worktree_release(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    access: State<'_, Arc<WorkspaceFsAccess>>,
    root: String,
) -> Result<(), String> {
    greywork_host::worktree::worktree_release(host_ctx.inner().as_ref(), &**access, root)
}

/// 列出隔离快照。
#[tauri::command]
pub fn worktree_list(
    host_ctx: State<'_, Arc<dyn HostContext>>,
) -> Result<Vec<WorktreeEntryDto>, String> {
    greywork_host::worktree::worktree_list(host_ctx.inner().as_ref())
}

/// 记一次工作区回合快照，返回其 ref 名。
#[tauri::command]
pub fn worktree_snapshot(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    access: State<'_, Arc<WorkspaceFsAccess>>,
    root: String,
) -> Result<String, String> {
    greywork_host::worktree::worktree_snapshot(host_ctx.inner().as_ref(), &**access, root)
}

/// 把工作区硬回退到某个快照 ref。
#[tauri::command]
pub fn worktree_restore(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    access: State<'_, Arc<WorkspaceFsAccess>>,
    root: String,
    reference: String,
) -> Result<(), String> {
    greywork_host::worktree::worktree_restore(host_ctx.inner().as_ref(), &**access, root, reference)
}
