//! 底层 git 执行，以及快照的 slug / 指纹 / 目标目录 / 分支命名。

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

const GIT: &str = "git";

/// 在指定目录里执行 git；失败返回 stderr（去尾空白）。绝不弹出交互提示。
pub(super) fn run_git(root: &Path, args: &[&str]) -> Result<String, String> {
    run_git_env(root, args, &[])
}

/// 与 `run_git` 同形，但可追加环境变量。回合快照用它把 `GIT_INDEX_FILE` 指到临时索引，
/// 从而在不碰真实 index 的前提下构建整棵工作树的 tree。
pub(super) fn run_git_env(
    root: &Path,
    args: &[&str],
    envs: &[(&str, &str)],
) -> Result<String, String> {
    let mut cmd = std::process::Command::new(GIT);
    crate::process_guard::hide_console_std(&mut cmd);
    cmd.current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .args(["-c", "core.quotepath=false"]);
    for (key, value) in envs {
        cmd.env(key, value);
    }
    cmd.args(args);
    let output = cmd
        .output()
        .map_err(|error| format!("无法启动 git: {error}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr)
            .trim_end()
            .to_string();
        let stdout = String::from_utf8_lossy(&output.stdout)
            .trim_end()
            .to_string();
        if stderr.is_empty() {
            Err(stdout)
        } else {
            Err(stderr)
        }
    }
}

/// 源目录是否在某个 git 仓库里（.git 文件或目录都算）。
pub(super) fn is_git_repo(source: &Path) -> bool {
    source.join(".git").is_file() || source.join(".git").is_dir()
}

/// 净名slug：取源目录文件名的安全形态（只留字母数字 `_` `-`），空则回落 `ws`。
fn slug(source: &Path) -> String {
    let raw = source
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_default();
    let cleaned: String = raw
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('-');
    if trimmed.is_empty() {
        "ws".to_string()
    } else {
        trimmed.to_string()
    }
}

/// 源路径指纹：`sha256(可比路径)[:12]`。目录名与分支名共用同一份指纹，
/// 保证「同一个源 → 同一个快照目录、同一个分支」。
fn source_fingerprint(source: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(crate::path_safety::comparable_text(&source.to_string_lossy()).as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    digest[..12].to_string()
}

/// 确定性目标目录：`<base>/<slug>-<指纹>`。
pub(super) fn deterministic_target(base: &Path, source: &Path) -> Result<PathBuf, String> {
    Ok(base.join(format!("{}-{}", slug(source), source_fingerprint(source))))
}

/// 快照工作树所在的分支名：`greywork/<slug>-<指纹>`，与快照目录同名。
///
/// worktree 与源仓库**共享 `refs/heads/*`**，所以这个分支天然就落在用户仓库里——
/// 无需任何 remote 即可把 agent 的提交交回（`git branch` / `git log` 直接可见）。
/// 命名确定性也让「release 后再 provision」能复用到同一分支（见 `add_worktree_branch`）。
pub(super) fn worktree_branch(source: &Path) -> String {
    format!("greywork/{}-{}", slug(source), source_fingerprint(source))
}

/// 在快照目录建工作树，落在 `branch` 上。
///
/// 先尝试用 `-b` **新建**分支；若分支已存在（多半是上一次 release 留下的），
/// 退回「挂到已存在分支」以**复用**它、保留分支上已有的提交。
/// 两条路径都失败（例如分支正被另一个 worktree 检出）才交给调用方回落复制。
///
/// **绝不使用 `-B`**：`-B` 会把已存在分支重置到源当前 HEAD，静默丢弃用户
/// 可能已合并或待处理的提交。
pub(super) fn add_worktree_branch(source: &Path, branch: &str, target: &str) -> Result<(), String> {
    match run_git(source, &["worktree", "add", "-b", branch, target]) {
        Ok(_) => Ok(()),
        Err(create_error) => run_git(source, &["worktree", "add", target, branch])
            .map(|_| ())
            .map_err(|attach_error| {
                format!("worktree add 失败（新建: {create_error}；复用: {attach_error}）")
            }),
    }
}
