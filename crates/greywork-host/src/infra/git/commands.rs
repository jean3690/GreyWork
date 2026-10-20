//! 命令实现入口与入参。

use crate::core::ports::WorkspaceFs;

use super::dto::{CommitResultDto, GitChangeDto, GitCommitDto, GitStatusDto};
use super::history::{log_history, show_commit};
use super::ops::{branch_list, changes, commit, current_branch, diff, stage, status, unstage};

pub fn git_status(access: &dyn WorkspaceFs, root: String) -> Result<Vec<GitStatusDto>, String> {
    status(access, &root)
}

pub fn git_changes(access: &dyn WorkspaceFs, root: String) -> Result<Vec<GitChangeDto>, String> {
    changes(access, &root)
}

/// `staged` 缺省视为 false（看未暂存侧）：旧前端只传 root/path 时不会因为少一个字段而整条命令失败。
pub fn git_diff(
    access: &dyn WorkspaceFs,
    root: String,
    path: Option<String>,
    staged: Option<bool>,
) -> Result<String, String> {
    diff(access, &root, path.as_deref(), staged.unwrap_or(false))
}

/// 暂存指定路径；`all` 为真时暂存全部。
pub fn git_stage(
    access: &dyn WorkspaceFs,
    root: String,
    paths: Vec<String>,
    all: bool,
) -> Result<(), String> {
    stage(access, &root, &paths, all)
}

/// 取消暂存指定路径；`all` 为真时取消全部。
pub fn git_unstage(
    access: &dyn WorkspaceFs,
    root: String,
    paths: Vec<String>,
    all: bool,
) -> Result<(), String> {
    unstage(access, &root, &paths, all)
}

/// 提交；`all` 为真时先 `add -A`（旧的「提交全部」），否则只提交已暂存的内容。
pub fn git_commit(
    access: &dyn WorkspaceFs,
    root: String,
    message: String,
    all: Option<bool>,
) -> Result<CommitResultDto, String> {
    commit(access, &root, &message, all.unwrap_or(false))
}

pub fn git_current_branch(access: &dyn WorkspaceFs, root: String) -> Result<String, String> {
    current_branch(access, &root)
}

pub fn git_branch_list(access: &dyn WorkspaceFs, root: String) -> Result<Vec<String>, String> {
    branch_list(access, &root)
}

/// 提交历史；`limit` 缺省 50、`skip` 缺省 0（分页）。
pub fn git_log(
    access: &dyn WorkspaceFs,
    root: String,
    limit: Option<u32>,
    skip: Option<u32>,
) -> Result<Vec<GitCommitDto>, String> {
    log_history(access, &root, limit, skip)
}

/// 单次提交的 diff；`path` 缺省为整次提交。
pub fn git_show(
    access: &dyn WorkspaceFs,
    root: String,
    hash: String,
    path: Option<String>,
) -> Result<String, String> {
    show_commit(access, &root, &hash, path.as_deref())
}

/// 仅需仓库根的命令（status / changes / current_branch / branch_list）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootArg {
    pub root: String,
}

/// `git_diff` 入参；`path` / `staged` 缺省即「未暂存侧的全量 diff」。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffArgs {
    pub root: String,
    pub path: Option<String>,
    pub staged: Option<bool>,
}

/// 暂存 / 取消暂存。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageArgs {
    pub root: String,
    pub paths: Vec<String>,
    pub all: bool,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitArgs {
    pub root: String,
    pub message: String,
    pub all: Option<bool>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogArgs {
    pub root: String,
    pub limit: Option<u32>,
    pub skip: Option<u32>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShowArgs {
    pub root: String,
    pub hash: String,
    pub path: Option<String>,
}
