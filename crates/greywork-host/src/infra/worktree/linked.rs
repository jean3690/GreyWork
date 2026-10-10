//! `.agents/linked`：把源里被 git 忽略的共享文件以符号链接挂进新快照。

use std::path::Path;

use super::git::run_git;
use super::AGENTS_DIR;

/// 共享文件清单文件名。
const LINKED_FILE: &str = "linked";

/// 逐行读 `.agents/linked`：去空白、跳过空行与 `#` 注释。
///
/// 从**源**读而不是从快照读：清单若尚未提交，git worktree 里根本没有这个文件。
fn read_linked_entries(source: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(source.join(AGENTS_DIR).join(LINKED_FILE)) else {
        return Vec::new();
    };
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_string)
        .collect()
}

/// 条目是否是安全的**相对**路径：不含 `..`、绝对路径前缀或根目录。
///
/// 这是防逃逸的第一道闸：`../../etc` 这类条目会让符号链接指到源树之外。
/// 用 `Component` 而不是字符串前缀判断 —— Windows 的 `C:\` 前缀与 `/` 根目录都要拦。
pub(super) fn is_safe_relative(entry: &str) -> bool {
    use std::path::Component;
    let path = Path::new(entry);
    if path.is_absolute() {
        return false;
    }
    !path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::Prefix(_) | Component::RootDir
        )
    })
}

/// 创建符号链接：Unix 一条路径；Windows 按源是目录还是文件分流。
#[cfg(unix)]
fn create_symlink(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(src, dst)
}

#[cfg(windows)]
fn create_symlink(src: &Path, dst: &Path) -> std::io::Result<()> {
    if src.is_dir() {
        std::os::windows::fs::symlink_dir(src, dst)
    } else {
        std::os::windows::fs::symlink_file(src, dst)
    }
}

/// 按 `.agents/linked` 把源仓库里的共享文件以符号链接挂进新快照。
///
/// 契约（与 Delta 一致，也是正确性的前提）：
/// - 条目必须是安全相对路径（见 `is_safe_relative`）；
/// - 条目必须被 git 忽略 —— 否则链接会以「新增文件」出现在 git status / 变更视图里；
/// - 只链接源里**已存在**的文件/目录，绝不创建源文件。
///
/// 任一条不满足就跳过并告警，**绝不让 provision 整体失败**：快照本身是可用的，
/// 一个配置失误的清单不该让整个隔离环境起不来。Windows 上创建符号链接需要开发者模式或
/// 管理员权限，失败时同样只告警（功能降级，不是错误）。
pub(super) fn apply_linked(source: &Path, target: &Path) {
    for entry in read_linked_entries(source) {
        if !is_safe_relative(&entry) {
            crate::log::warn(
                "worktree",
                format!(".agents/linked 条目不是安全的相对路径，已跳过: {entry}"),
            );
            continue;
        }
        // 必须被 git 忽略：链接出现在 git status 里会污染 agent 的变更视图。
        if run_git(source, &["check-ignore", "-q", "--", entry.as_str()]).is_err() {
            crate::log::warn(
                "worktree",
                format!(".agents/linked 条目未被 git 忽略，已跳过: {entry}"),
            );
            continue;
        }
        let src = source.join(&entry);
        if !src.exists() {
            crate::log::warn(
                "worktree",
                format!(".agents/linked 条目在源中不存在，已跳过: {entry}"),
            );
            continue;
        }
        let dst = target.join(&entry);
        if dst.exists() {
            continue; // 快照里已有同名项（被忽略就不该有），不覆盖
        }
        if let Some(parent) = dst.parent() {
            if let Err(error) = std::fs::create_dir_all(parent) {
                crate::log::warn(
                    "worktree",
                    format!(".agents/linked 创建父目录失败 {entry}: {error}"),
                );
                continue;
            }
        }
        if let Err(error) = create_symlink(&src, &dst) {
            crate::log::warn(
                "worktree",
                format!(".agents/linked 创建符号链接失败 {entry}: {error}"),
            );
        }
    }
}
