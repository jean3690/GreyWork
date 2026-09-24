//! 工作区 Git 操作的桌面命令入口；实现收在 `greywork_host::git`（与 headless 服务端共用）。

use tauri::State;

pub use greywork_host::git::{CommitResultDto, GitChangeDto, GitCommitDto, GitStatusDto};
use greywork_host::workspace_fs::WorkspaceFsAccess;

#[tauri::command]
pub fn git_status(
    access: State<'_, WorkspaceFsAccess>,
    root: String,
) -> Result<Vec<GitStatusDto>, String> {
    greywork_host::git::git_status(&access, root)
}

#[tauri::command]
pub fn git_changes(
    access: State<'_, WorkspaceFsAccess>,
    root: String,
) -> Result<Vec<GitChangeDto>, String> {
    greywork_host::git::git_changes(&access, root)
}

/// `staged` 缺省视为 false（看未暂存侧）：旧前端只传 root/path 时不会因为少一个字段而整条命令失败。
#[tauri::command]
pub fn git_diff(
    access: State<'_, WorkspaceFsAccess>,
    root: String,
    path: Option<String>,
    staged: Option<bool>,
) -> Result<String, String> {
    greywork_host::git::git_diff(&access, root, path, staged)
}

/// 暂存指定路径；`all` 为真时暂存全部。
#[tauri::command]
pub fn git_stage(
    access: State<'_, WorkspaceFsAccess>,
    root: String,
    paths: Vec<String>,
    all: bool,
) -> Result<(), String> {
    greywork_host::git::git_stage(&access, root, paths, all)
}

/// 取消暂存指定路径；`all` 为真时取消全部。
#[tauri::command]
pub fn git_unstage(
    access: State<'_, WorkspaceFsAccess>,
    root: String,
    paths: Vec<String>,
    all: bool,
) -> Result<(), String> {
    greywork_host::git::git_unstage(&access, root, paths, all)
}

/// 提交；`all` 为真时先 `add -A`（旧的「提交全部」），否则只提交已暂存的内容。
#[tauri::command]
pub fn git_commit(
    access: State<'_, WorkspaceFsAccess>,
    root: String,
    message: String,
    all: Option<bool>,
) -> Result<CommitResultDto, String> {
    greywork_host::git::git_commit(&access, root, message, all)
}

#[tauri::command]
pub fn git_current_branch(
    access: State<'_, WorkspaceFsAccess>,
    root: String,
) -> Result<String, String> {
    greywork_host::git::git_current_branch(&access, root)
}

#[tauri::command]
pub fn git_branch_list(
    access: State<'_, WorkspaceFsAccess>,
    root: String,
) -> Result<Vec<String>, String> {
    greywork_host::git::git_branch_list(&access, root)
}

/// 提交历史；`limit` 缺省 50、`skip` 缺省 0（分页）。
#[tauri::command]
pub fn git_log(
    access: State<'_, WorkspaceFsAccess>,
    root: String,
    limit: Option<u32>,
    skip: Option<u32>,
) -> Result<Vec<GitCommitDto>, String> {
    greywork_host::git::git_log(&access, root, limit, skip)
}

/// 单次提交的 diff；`path` 缺省为整次提交。
#[tauri::command]
pub fn git_show(
    access: State<'_, WorkspaceFsAccess>,
    root: String,
    hash: String,
    path: Option<String>,
) -> Result<String, String> {
    greywork_host::git::git_show(&access, root, hash, path)
}
