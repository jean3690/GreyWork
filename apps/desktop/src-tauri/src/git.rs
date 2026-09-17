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

use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::workspace_fs::WorkspaceFsAccess;

const GIT: &str = "git";

/* ===== 类型化输出 DTO（camelCase 对齐前端 GitService 接口） ===== */

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusDto {
    pub path: String,
    pub status: String,
    pub staged: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChangeDto {
    pub path: String,
    pub status: String,
    pub staged: bool,
    pub add: u32,
    pub del: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitResultDto {
    pub hash: String,
    pub message: String,
    pub timestamp: String,
}

/* ===== 底层执行 ===== */

/// 在授权根内执行 git；失败返回 stderr（去尾空白）。绝不弹出交互提示。
fn run_git(root: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = std::process::Command::new(GIT);
    cmd.current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        // 只读操作不升级索引/引用（避免后台还挂着别的 git 时搬走锁文件）
        .env("GIT_OPTIONAL_LOCKS", "0")
        .args(["-c", "core.quotepath=false", "-c", "color.ui=never"])
        .args(args);
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

/// X/Y 两个位置码（staged/worktree）中的非空白码 → 类型化状态；空白 = 无改动。
fn letter_to_status(letter: char) -> Option<String> {
    Some(
        match letter {
            'M' | 'm' => "modified",
            'A' => "added",
            'D' => "deleted",
            'R' | 'r' | 'C' | 'c' => "renamed",
            'T' => "modified",
            'U' | '?' => "untracked",
            _ => return None,
        }
        .to_string(),
    )
}

/// 解析 `git status --porcelain` 的一行（非 -z：重命名显示为 `R  old -> new`）。
/// 返回 (路径, 状态, 是否 staged)；无法识别的情况返回 None。
fn parse_status_line(line: &str) -> Option<(String, String, bool)> {
    let line = line.as_bytes();
    if line.len() < 3 || line[2] != b' ' {
        return None;
    }
    let index = line[0] as char;
    let worktree = line[1] as char;
    let rest = std::str::from_utf8(&line[3..]).ok()?;
    let staged = !matches!(index, ' ' | '?' | '!');
    let status = letter_to_status(index).or_else(|| letter_to_status(worktree))?;
    // 重命名/复制：`R  old -> new`，当前路径取箭头后（工作区的真实位置）。
    let path = match rest.split_once(" -> ") {
        Some((_, new)) => new.trim().to_string(),
        None => rest.to_string(),
    };
    if path.is_empty() {
        return None;
    }
    Some((path, status, staged))
}

/// `git status --porcelain` 全部条目的类型化列表。
fn collect_status(root: &Path) -> Result<Vec<GitStatusDto>, String> {
    let out = run_git(root, &["status", "--porcelain"])?;
    let mut entries = Vec::new();
    for line in out.lines() {
        if let Some((path, status, staged)) = parse_status_line(line) {
            entries.push(GitStatusDto {
                path,
                status,
                staged,
            });
        }
    }
    Ok(entries)
}

/// 解析 `--numstat` 的一行（`added\tdeleted\tpath`；重命名路径含 `=>` 取后段）。
fn parse_numstat_line(line: &str) -> Option<(u32, u32, String)> {
    let mut parts = line.split('\t');
    let add = parts.next()?.parse().ok()?;
    let del = parts.next()?.parse().ok()?;
    let path = parts.next()?;
    let path = path
        .split_once("=>")
        .map(|(_, new)| new)
        .unwrap_or(path)
        .trim();
    if path.is_empty() {
        return None;
    }
    Some((add, del, path.to_string()))
}

fn collect_numstat(root: &Path, cached: bool) -> Result<Vec<(u32, u32, String)>, String> {
    let args: &[&str] = if cached {
        &["diff", "--cached", "--numstat"]
    } else {
        &["diff", "--numstat"]
    };
    let out = run_git(root, args)?;
    Ok(out.lines().filter_map(parse_numstat_line).collect())
}

/* ===== 命令实现 ===== */

fn resolve_root(access: &WorkspaceFsAccess, raw: &str) -> Result<PathBuf, String> {
    let path = access.resolve_existing(raw)?;
    let metadata =
        std::fs::metadata(&path).map_err(|error| format!("读取目录元数据失败: {error}"))?;
    if !metadata.is_dir() {
        return Err("git 根必须是目录".into());
    }
    Ok(path)
}

/// 变更状态列表（status），供变更面板展示。
fn status(access: &WorkspaceFsAccess, root: &str) -> Result<Vec<GitStatusDto>, String> {
    collect_status(&resolve_root(access, root)?)
}

/// status + 每文件行级增删（未暂存 + 已暂存两张 numstat 合并）。
fn changes(access: &WorkspaceFsAccess, root: &str) -> Result<Vec<GitChangeDto>, String> {
    let root = resolve_root(access, root)?;
    let statuses = collect_status(&root)?;
    let unstaged = collect_numstat(&root, false)?;
    let staged = collect_numstat(&root, true)?;
    let sum = |path: &str, cached: bool| -> (u32, u32) {
        let list = if cached { &staged } else { &unstaged };
        list.iter()
            .find(|(_, _, p)| p == path)
            .map(|(add, del, _)| (*add, *del))
            .unwrap_or((0, 0))
    };
    Ok(statuses
        .into_iter()
        .map(|entry| {
            let (staged_add, staged_del) = sum(&entry.path, true);
            let (work_add, work_del) = sum(&entry.path, false);
            GitChangeDto {
                path: entry.path,
                status: entry.status,
                staged: entry.staged,
                add: staged_add + work_add,
                del: staged_del + work_del,
            }
        })
        .collect())
}

/// 单文件或全量统一 diff（未暂存 + 已暂存拼在一起；`path` 缺省为全量）。
fn diff(access: &WorkspaceFsAccess, root: &str, path: Option<&str>) -> Result<String, String> {
    let root = resolve_root(access, root)?;
    let mut out = String::new();
    let (part_a, part_b): (&[&str], &[&str]) = match path {
        Some(path) => (&["diff", "--", path], &["diff", "--cached", "--", path]),
        None => (&["diff"], &["diff", "--cached"]),
    };
    out.push_str(&run_git(&root, part_a)?);
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(&run_git(&root, part_b)?);
    Ok(out)
}

/// 提交全部工作区变更（add -A 后 commit）。非 git 仓库 / 无变更时返回错误文案。
fn commit(
    access: &WorkspaceFsAccess,
    root: &str,
    message: &str,
) -> Result<CommitResultDto, String> {
    let root = resolve_root(access, root)?;
    let message = message.trim();
    if message.is_empty() {
        return Err("提交信息不能为空".into());
    }
    run_git(&root, &["add", "-A"]).map_err(|error| format!("暂存变更失败: {error}"))?;
    run_git(&root, &["commit", "-m", message]).map_err(|error| {
        if error.contains("nothing to commit") {
            "没有可提交的变更".into()
        } else {
            format!("提交失败: {error}")
        }
    })?;
    let hash = run_git(&root, &["rev-parse", "--short", "HEAD"])?
        .trim()
        .to_string();
    let timestamp = run_git(&root, &["show", "-s", "--format=%cI", "HEAD"])?
        .trim()
        .to_string();
    Ok(CommitResultDto {
        hash,
        message: message.to_string(),
        timestamp,
    })
}

fn current_branch(access: &WorkspaceFsAccess, root: &str) -> Result<String, String> {
    Ok(
        run_git(&resolve_root(access, root)?, &["branch", "--show-current"])?
            .trim()
            .to_string(),
    )
}

fn branch_list(access: &WorkspaceFsAccess, root: &str) -> Result<Vec<String>, String> {
    let out = run_git(
        &resolve_root(access, root)?,
        &["branch", "--format=%(refname:short)"],
    )?;
    Ok(out
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(String::from)
        .collect())
}

/* ===== Tauri 命令 ===== */

#[tauri::command]
pub fn git_status(
    access: tauri::State<'_, WorkspaceFsAccess>,
    root: String,
) -> Result<Vec<GitStatusDto>, String> {
    status(&access, &root)
}

#[tauri::command]
pub fn git_changes(
    access: tauri::State<'_, WorkspaceFsAccess>,
    root: String,
) -> Result<Vec<GitChangeDto>, String> {
    changes(&access, &root)
}

#[tauri::command]
pub fn git_diff(
    access: tauri::State<'_, WorkspaceFsAccess>,
    root: String,
    path: Option<String>,
) -> Result<String, String> {
    diff(&access, &root, path.as_deref())
}

#[tauri::command]
pub fn git_commit(
    access: tauri::State<'_, WorkspaceFsAccess>,
    root: String,
    message: String,
) -> Result<CommitResultDto, String> {
    commit(&access, &root, &message)
}

#[tauri::command]
pub fn git_current_branch(
    access: tauri::State<'_, WorkspaceFsAccess>,
    root: String,
) -> Result<String, String> {
    current_branch(&access, &root)
}

#[tauri::command]
pub fn git_branch_list(
    access: tauri::State<'_, WorkspaceFsAccess>,
    root: String,
) -> Result<Vec<String>, String> {
    branch_list(&access, &root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("系统时间早于 UNIX 纪元")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("greywork-git-{tag}-{nanos}"));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    fn access(root: &Path) -> WorkspaceFsAccess {
        WorkspaceFsAccess::new(root, root.parent().unwrap().join("gw-git-access-test.json"))
            .expect("创建授权状态")
    }

    /// git 可用性探测（测试前置条件）。
    fn git_available() {
        let output = Command::new("git")
            .arg("--version")
            .output()
            .expect("启动 git 探测");
        assert!(
            output.status.success(),
            "Rust 单测需要系统 git 可用：\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    /// 初始化并做一次初始提交，返回仓库根。
    fn init_repo(tag: &str) -> PathBuf {
        git_available();
        let root = temp_dir(tag);
        Command::new("git")
            .current_dir(&root)
            .args(["init", "-q", "-b", "main"])
            .status()
            .expect("git init");
        // 提交需要作者身份。这里写**仓库级**配置，而不是给单条命令挂 GIT_AUTHOR_* 环境变量：
        // 被测的 commit() 是独立进程调用，拿不到测试进程的 env；而 CI runner 没有全局
        // user.name/user.email，只在个别命令上设环境变量会让 commit() 报
        // "Author identity unknown"（本机能过只是因为跑测的人配过全局身份）。
        for (key, value) in [
            ("user.name", "GreyWork Test"),
            ("user.email", "test@greywork.local"),
        ] {
            Command::new("git")
                .current_dir(&root)
                .args(["config", key, value])
                .status()
                .expect("git config");
        }
        std::fs::write(root.join(".gitignore"), "*.log\n").expect("写 gitignore");
        std::fs::write(root.join("a.txt"), "one\n").expect("写 a");
        std::fs::write(root.join("b.txt"), "hello\n").expect("写 b");
        Command::new("git")
            .current_dir(&root)
            .args(["add", "-A"])
            .status()
            .expect("git add");
        Command::new("git")
            .current_dir(&root)
            .args(["commit", "-m", "init"])
            .status()
            .expect("git commit");
        root
    }

    #[test]
    fn status_parses_letters_and_unstaged_renames() {
        assert_eq!(parse_status_line("M  a.txt").unwrap().1, "modified");
        assert_eq!(parse_status_line(" M a.txt").unwrap().1, "modified");
        assert_eq!(parse_status_line("A  a.txt").unwrap().1, "added");
        assert_eq!(parse_status_line("?? a.txt").unwrap().1, "untracked");
        assert_eq!(parse_status_line("R  old -> new.txt").unwrap().0, "new.txt");
        let (_, _, staged) = parse_status_line("M  a.txt").unwrap();
        assert!(staged);
        let (_, _, staged) = parse_status_line(" M a.txt").unwrap();
        assert!(!staged);
        assert!(parse_status_line("not a status").is_none());
    }

    #[test]
    fn numstat_parses_counts_and_rename_target() {
        assert_eq!(
            parse_numstat_line("3\t1\tpath/with space.txt").unwrap(),
            (3, 1, "path/with space.txt".into())
        );
        assert_eq!(
            parse_numstat_line("2\t0\told => new.txt").unwrap(),
            (2, 0, "new.txt".into())
        );
        assert!(parse_numstat_line("x\ty\tz").is_none());
    }

    #[test]
    fn changes_reports_modified_added_and_counts() {
        let root = init_repo("changes");
        std::fs::write(root.join("a.txt"), "one\ntwo\n").expect("改 a");
        std::fs::write(root.join("new.txt"), "n\n").expect("写新文件");
        let access = access(&root);
        let result = changes(&access, &root.to_string_lossy()).expect("采集变更");
        let a = result
            .iter()
            .find(|e| e.path == "a.txt")
            .expect("a 在变更里");
        assert_eq!(a.status, "modified");
        assert!(!a.staged);
        assert_eq!(a.add, 1);
        assert_eq!(a.del, 0);
        let n = result
            .iter()
            .find(|e| e.path == "new.txt")
            .expect("new 在变更里");
        assert_eq!(n.status, "untracked");
        // untracked 不进 `git diff --numstat`（那是对已跟踪内容的统计），行数给 0，
        // 新增语义靠「新增(U)」徽标表达 —— 照实呈现，不猜行数。
        assert_eq!(n.add, 0);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn status_marks_staged_changes() {
        let root = init_repo("staged");
        std::fs::write(root.join("a.txt"), "one\none\n").expect("改 a");
        Command::new("git")
            .current_dir(&root)
            .args(["add", "a.txt"])
            .status()
            .expect("git add");
        let access = access(&root);
        let entries = status(&access, &root.to_string_lossy()).expect("采集状态");
        let a = entries
            .iter()
            .find(|e| e.path == "a.txt")
            .expect("a 在状态里");
        assert_eq!(a.status, "modified");
        assert!(a.staged);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn diff_returns_unified_text_and_touches_both_indexes() {
        let root = init_repo("diff-arg");
        std::fs::write(root.join("a.txt"), "one\ntwo\n").expect("改 a");
        std::fs::write(root.join("b.txt"), "hello\nworld\n").expect("改 b");
        Command::new("git")
            .current_dir(&root)
            .args(["add", "b.txt"])
            .status()
            .expect("git add");
        let access = access(&root);
        let full = diff(&access, &root.to_string_lossy(), None).expect("全量 diff");
        assert!(full.contains("a.txt"));
        assert!(full.contains("b.txt"));
        let single = diff(&access, &root.to_string_lossy(), Some("a.txt")).expect("单文件 diff");
        assert!(single.contains("a.txt"));
        assert!(!single.contains("b.txt"));
        let staged = diff(&access, &root.to_string_lossy(), Some("b.txt")).expect("b diff");
        assert!(staged.contains("b.txt"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn commit_makes_hash_and_clears_changes() {
        let root = init_repo("commit");
        std::fs::write(root.join("a.txt"), "one\none\none\n").expect("改 a");
        let access = access(&root);
        let result = commit(&access, &root.to_string_lossy(), "改动 a").expect("提交");
        assert_eq!(result.message, "改动 a");
        assert!(!result.hash.is_empty());
        assert!(!result.timestamp.is_empty());
        let remaining = status(&access, &root.to_string_lossy()).expect("提交后状态");
        assert!(remaining.is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn commit_rejects_blank_message() {
        let root = init_repo("blank-msg");
        let access = access(&root);
        assert!(commit(&access, &root.to_string_lossy(), "   ").is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn branches_and_current_branch() {
        let root = init_repo("branch");
        Command::new("git")
            .current_dir(&root)
            .args(["checkout", "-q", "-b", "feature/x"])
            .status()
            .expect("切分支");
        let access = access(&root);
        assert_eq!(
            current_branch(&access, &root.to_string_lossy()).expect("当前分支"),
            "feature/x"
        );
        let list = branch_list(&access, &root.to_string_lossy()).expect("分支列表");
        assert!(list.contains(&"feature/x".to_string()));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn non_git_directory_is_a_clear_error() {
        let root = temp_dir("not-a-repo");
        let access = access(&root);
        let result = status(&access, &root.to_string_lossy());
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn sibling_directory_is_rejected_by_authorization() {
        git_available();
        let root = temp_dir("auth");
        let outside = temp_dir("auth-outside");
        std::fs::write(outside.join("x.txt"), "x").expect("写外部文件");
        let access = access(&root);
        let result = status(&access, &outside.to_string_lossy());
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }
}
