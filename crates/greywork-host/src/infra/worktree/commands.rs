//! 命令实现入口与入参。

use crate::core::ports::WorkspaceFs;
use crate::host::HostContext;

use super::dto::{WorktreeEntryDto, WorktreeProvisionDto};
use super::provision::{list, provision, release};
use super::snapshot::{restore, snapshot};

pub fn worktree_provision(
    host: &dyn HostContext,
    access: &dyn WorkspaceFs,
    source: String,
    prepare: bool,
) -> Result<WorktreeProvisionDto, String> {
    provision(access, &host.paths().home_dir, &source, prepare)
}

pub fn worktree_release(
    host: &dyn HostContext,
    access: &dyn WorkspaceFs,
    root: String,
) -> Result<(), String> {
    release(access, &host.paths().home_dir, &root)
}

/// 列出隔离快照。不取 WorkspaceFsAccess：入参只有 home，扫的是应用自己的
/// `~/.greyWork/worktrees`，没有任何用户可控路径参与，无需授权校验。
pub fn worktree_list(host: &dyn HostContext) -> Result<Vec<WorktreeEntryDto>, String> {
    list(&host.paths().home_dir)
}

/// 记一次工作区回合快照，返回其 ref 名（渲染层把它挂到对应消息上）。
pub fn worktree_snapshot(
    host: &dyn HostContext,
    access: &dyn WorkspaceFs,
    root: String,
) -> Result<String, String> {
    snapshot(access, &host.paths().home_dir, &root)
}

/// 把工作区硬回退到某个快照 ref（严格等于快照）。
pub fn worktree_restore(
    host: &dyn HostContext,
    access: &dyn WorkspaceFs,
    root: String,
    reference: String,
) -> Result<(), String> {
    restore(access, &host.paths().home_dir, &root, &reference)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvisionArgs {
    pub source: String,
    /// 是否执行 `.agents/prepare`。默认 **false**（fail-closed）：服务端会按 `tier`
    /// 覆盖本字段，只读档一律夹成 false（见 `apps/server` 的 `overlay_args`）。
    #[serde(default)]
    pub prepare: bool,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseArgs {
    pub root: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotArgs {
    pub root: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreArgs {
    pub root: String,
    /// `worktree_snapshot` 返回的 ref 名（`refs/greywork/snap/<id>`）。
    pub reference: String,
}
