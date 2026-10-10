//! 工作区 Git 操作（变更状态 / diff / 提交 / 分支），全部经宿主 git CLI 执行。
//!
//! 边界与安全：
//! - 只允许在**已经授权的根目录**内运行 git（复用 `WorkspaceFsAccess` 的授权账本）；
//!   渲染端不能拿任意路径来跑 `git -C` —— 路径先经 `resolve_existing` 解析成规范路径。
//! - 参数一律走 argv 数组（无 shell 拼接），路径/消息里的引号、空格、`--` 都不会被解释。
//! - `GIT_TERMINAL_PROMPT=0`：本模块是只读查询 + 明确请求的提交，绝不让 git 挂起等人输入。
//! - `core.quotepath=false`：路径按 UTF-8 原样输出，前端不用解码 `\303\251` 转义。
//! - `color.ui=never`：diff 不带 ANSI 色码，前端自行着色（`lib/unified-diff`）。
//!
//! 目标产物：`git status --porcelain` 的 XY 码 → 类型化变更条目；`--numstat` 补行级
//! 增删；`git diff` 给统一 diff 文本；`git commit` 提交全部暂存变更并回收短 hash。
//!
//! # 子模块
//!
//! - [`dto`]：对外 DTO；
//! - [`exec`]：有界 git 执行（`run_capture` / `run_git`）；
//! - [`path`]：仓库根解析与相对路径 / 版本号校验；
//! - [`porcelain`]：`git status --porcelain` / `--numstat` 的解析；
//! - [`ops`]：变更 / diff / 暂存 / 提交 / 分支命令实现；
//! - [`history`]：提交历史与单次提交 diff；
//! - [`commands`]：命令实现入口与入参。

mod commands;
mod dto;
mod exec;
mod history;
mod ops;
mod path;
mod porcelain;

#[cfg(test)]
mod tests;

pub use commands::{
    git_branch_list, git_changes, git_commit, git_current_branch, git_diff, git_log, git_show,
    git_stage, git_status, git_unstage, CommitArgs, DiffArgs, LogArgs, RootArg, ShowArgs,
    StageArgs,
};
pub use dto::{CommitResultDto, GitChangeDto, GitCommitDto, GitStatusDto};

// crate 内仍按旧路径 `crate::git::run_capture` 复用（`infra::worktree` 跑 prepare 脚本）。
pub(crate) use exec::run_capture;
