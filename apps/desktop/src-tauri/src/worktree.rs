//! 独立工作树执行外壳（runMode=worktree 的宿主侧）。
//!
//! 语义：`worktree_provision(source)` 把 ACP 工作区挪到一份**隔离快照**里——
//! - git 仓库 → 真实 `git worktree add --detach`（与新工作树共享对象库，不污染用户工作区）；
//! - 非 git 目录 → 演示兜底：整目录复制成独立副本（kind="copy"）；
//! - source 本身是应用数据根 `~/.greyWork` → 无需隔离（kind="direct"，原样返回）。
//!
//! 目标一律放在应用私有根 `~/.greyWork/worktrees/<slug>-<hash>` 下：
//! - `~/.greyWork` 是内置授权根，`acp_start` 的 `validate_existing` 天然放行、沙盒可直接绑定；
//! - 目录名对同一 source 是**确定性**的（净名 slug + 源路径短哈希），会话重连时
//!   `binding.cwd === workspace` 的比对不受影响。
//!
//! `worktree_release(root)` 负责回收：git 快照走 `git worktree remove`（标记文件里记录源，
//! 失败则退回整目录删除，worktree 本就是可丢弃快照），copy 直接删目录；只允许删
//! `worktrees` 基目录之下的条目，杜绝把用户目录或数据根当成快照删掉。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
// AppHandle::path() 来自这个 trait（同 plugin_window / plugin_market 的写法）。
use tauri::Manager;

use crate::store_fs;
use crate::workspace_fs::WorkspaceFsAccess;

const GIT: &str = "git";
const WORKTREES_SUB_DIR: &str = "worktrees";
const MARKER_FILE: &str = ".greywork-worktree.json";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeProvisionDto {
    pub root: String,
    /// git：真实 worktree / copy：目录复制兜底 / direct：数据根直通（无隔离）。
    pub kind: String,
    pub source: String,
}

/// 列表项：一个已派生的隔离快照（设置页「运行模式」的回收面板消费）。
///
/// `direct` 不会出现在列表里 —— provision 判定「源就是数据根」时直接原样返回、
/// 不落任何快照，因此没有可供列出与回收的目录。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeEntryDto {
    pub root: String,
    /// git：真实 worktree / copy：目录复制兜底。
    pub kind: String,
    pub source: String,
    /// 快照目录占用字节。git 快照只含检出文件：对象库与源仓库共享，故不含仓库历史。
    pub bytes: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeMarker {
    kind: String,
    source: String,
}

/* ===== 底层执行 ===== */

/// 在指定目录里执行 git；失败返回 stderr（去尾空白）。绝不弹出交互提示。
fn run_git(root: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = std::process::Command::new(GIT);
    crate::process_guard::hide_console_std(&mut cmd);
    cmd.current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .args(["-c", "core.quotepath=false"])
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

/// 源目录是否在某个 git 仓库里（.git 文件或目录都算）。
fn is_git_repo(source: &Path) -> bool {
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

/// 确定性目标目录：`<base>/<slug>-<sha256(源路径)[:12]>`。
fn deterministic_target(base: &Path, source: &Path) -> Result<PathBuf, String> {
    let mut hasher = Sha256::new();
    hasher.update(crate::path_safety::comparable_text(&source.to_string_lossy()).as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    Ok(base.join(format!("{}-{}", slug(source), &digest[..12])))
}

/// 递归复制目录快照：跳过 `.git`、`.greyWork`（应用私有数据）与**符号链接**
/// （不追随链接，避免复制时逃出源树）。
fn copy_dir(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|error| format!("创建快照目录失败: {error}"))?;
    for entry in std::fs::read_dir(src).map_err(|error| format!("读取源目录失败: {error}"))?
    {
        let entry = entry.map_err(|error| format!("读取目录项失败: {error}"))?;
        let name = entry.file_name();
        if name == ".git" || name == store_fs::GREY_WORK_DIR {
            continue;
        }
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|error| format!("读取目录项元数据失败: {error}"))?;
        if metadata.is_symlink() {
            continue;
        }
        let target = dst.join(&name);
        if metadata.is_dir() {
            copy_dir(&path, &target)?;
        } else if metadata.is_file() {
            std::fs::copy(&path, &target).map_err(|error| format!("复制文件失败: {error}"))?;
        }
    }
    Ok(())
}

/// 递归累加目录占用字节。与 `copy_dir` 同一条纪律：**不追随符号链接**，
/// 免得顺着链接走出快照、或踩进自引用成环。读不到的条目按 0 计 —— 体积是展示项，
/// 不因为它报错就整个列表失败。
fn dir_bytes(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| {
            let path = entry.path();
            match std::fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.is_dir() => dir_bytes(&path),
                Ok(metadata) if metadata.is_file() => metadata.len(),
                _ => 0,
            }
        })
        .sum()
}

/// 写 provision 标记（kind + 源路径），供 release 正确回收。
fn write_marker(target: &Path, marker: &WorktreeMarker) -> Result<(), String> {
    let bytes = serde_json::to_vec(marker).map_err(|error| format!("序列化标记失败: {error}"))?;
    std::fs::write(target.join(MARKER_FILE), bytes).map_err(|error| format!("写标记失败: {error}"))
}

fn read_marker(target: &Path) -> Option<WorktreeMarker> {
    let bytes = std::fs::read(target.join(MARKER_FILE)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn strip(raw: &Path) -> String {
    crate::path_safety::strip_verbatim_prefix(&raw.to_string_lossy())
}

/* ===== 核心逻辑（home 由命令/测试各自提供） ===== */

fn provision(
    access: &WorkspaceFsAccess,
    home: &Path,
    source_raw: &str,
) -> Result<WorktreeProvisionDto, String> {
    let source = access.resolve_existing(source_raw)?;
    if !source.is_dir() {
        return Err("worktree 源必须是目录".into());
    }
    let default_root = store_fs::default_root(home)?;
    let worktrees_base = default_root.join(WORKTREES_SUB_DIR);
    // 数据根本身没有可隔离的工作区：直通，不做任何复制/目录创建。
    if crate::path_safety::same_path(&source, &default_root) {
        return Ok(WorktreeProvisionDto {
            root: strip(&source),
            kind: "direct".to_string(),
            source: strip(&source),
        });
    }

    let target = deterministic_target(&worktrees_base, &source)?;
    let stripped = strip(&source);

    // 幂等：已 provision 过就直接复用（目录名对同一 source 确定）。
    if target.join(MARKER_FILE).is_file() {
        let kind = read_marker(&target)
            .map(|marker| marker.kind)
            .unwrap_or_else(|| "copy".to_string());
        return Ok(WorktreeProvisionDto {
            root: strip(&target),
            kind,
            source: stripped,
        });
    }
    if target.exists() {
        // 目录存在但没标记：多半是废快照。不自动删除（避免误删用户数据），提示先 release。
        return Err(format!(
            "快照目录已存在但没有 provision 标记，请先 worktree_release 再重试: {}",
            target.display()
        ));
    }

    std::fs::create_dir_all(&worktrees_base)
        .map_err(|error| format!("创建 worktrees 基目录失败: {error}"))?;

    // git 仓库走真实 worktree；空仓库 / add 失败一律回落复制兜底（kind="copy"）。
    let kind = if is_git_repo(&source) {
        match run_git(
            &source,
            &[
                "worktree",
                "add",
                "--detach",
                target.to_str().unwrap_or_default(),
            ],
        ) {
            Ok(_) => "git",
            Err(error) => {
                crate::log::warn(
                    "worktree",
                    format!("git worktree add 失败（回落复制兜底）: {error}"),
                );
                copy_dir(&source, &target)?;
                "copy"
            }
        }
    } else {
        copy_dir(&source, &target)?;
        "copy"
    };
    write_marker(
        &target,
        &WorktreeMarker {
            kind: kind.to_string(),
            source: source.to_string_lossy().into_owned(),
        },
    )?;
    Ok(WorktreeProvisionDto {
        root: strip(&target),
        kind: kind.to_string(),
        source: stripped,
    })
}

fn release(access: &WorkspaceFsAccess, home: &Path, root_raw: &str) -> Result<(), String> {
    let root = access.resolve_existing(root_raw)?;
    let default_root = store_fs::default_root(home)?;
    let worktrees_base = default_root.join(WORKTREES_SUB_DIR);
    // 只允许回收基目录之下的快照，绝不删除数据根 / 用户目录本身。
    if !root.starts_with(&worktrees_base) {
        return Err("只允许释放 ~/.greyWork/worktrees 下的隔离快照".into());
    }
    if !root.exists() {
        return Ok(()); // 幂等：已回收视为成功
    }
    let kind = read_marker(&root)
        .map(|marker| marker.kind)
        .unwrap_or_else(|| "copy".to_string());
    if kind == "git" {
        let marker = read_marker(&root);
        let removed_via_git = marker
            .as_ref()
            .map(|marker| {
                let source = Path::new(&marker.source);
                if source.is_dir() && is_git_repo(source) {
                    // 必须在仓库内（源）执行，git 不允许移除「当前工作树」。
                    run_git(
                        source,
                        &[
                            "worktree",
                            "remove",
                            "--force",
                            "--force",
                            root.to_str().unwrap_or_default(),
                        ],
                    )
                    .is_ok()
                } else {
                    false
                }
            })
            .unwrap_or(false);
        if !removed_via_git {
            crate::log::warn(
                "worktree",
                format!(
                    "git worktree remove 失败或源缺失，退回整目录删除: {}",
                    root.display()
                ),
            );
        }
    }
    // git worktree remove 成功时目录**已经被它删掉**，这里只兜底其余情况（copy、
    // git 删除失败退回整目录删）。顺带守住与开头同一个不变量：目录已不在就是已回收，
    // 不因为「别人先删了」报错。
    if !root.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(&root).map_err(|error| format!("删除快照目录失败: {error}"))
}

/// 列出 `<数据根>/worktrees` 下的隔离快照。
///
/// 只认写过 provision 标记的目录：基目录里没有标记的东西（用户手放的、上次崩溃留下的
/// 半成品）不列 —— 列出来也只会给 UI 一个 `release` 会拒收的条目。
fn list(home: &Path) -> Result<Vec<WorktreeEntryDto>, String> {
    let worktrees_base = store_fs::default_root(home)?.join(WORKTREES_SUB_DIR);
    if !worktrees_base.is_dir() {
        return Ok(Vec::new()); // 一次都没派过：空列表，不是错误
    }
    let entries = std::fs::read_dir(&worktrees_base)
        .map_err(|error| format!("读取 worktrees 目录失败: {error}"))?;
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let target = entry.path();
        if !target.is_dir() {
            continue;
        }
        let Some(marker) = read_marker(&target) else {
            continue;
        };
        found.push(WorktreeEntryDto {
            // 与 provision 的返回值同形（都过 strip），前端才能把 root 原样回传给 release。
            root: strip(&target),
            kind: marker.kind,
            source: strip(Path::new(&marker.source)),
            bytes: dir_bytes(&target),
        });
    }
    // 目录名对同一源是确定的，排序只为让列表在 UI 里稳定不抖动。
    found.sort_by(|left, right| left.root.cmp(&right.root));
    Ok(found)
}

/* ===== Tauri 命令 ===== */

#[tauri::command]
pub fn worktree_provision(
    app: tauri::AppHandle,
    access: tauri::State<'_, WorkspaceFsAccess>,
    source: String,
) -> Result<WorktreeProvisionDto, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("读取主目录失败: {error}"))?;
    provision(&access, &home, &source)
}

#[tauri::command]
pub fn worktree_release(
    app: tauri::AppHandle,
    access: tauri::State<'_, WorkspaceFsAccess>,
    root: String,
) -> Result<(), String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("读取主目录失败: {error}"))?;
    release(&access, &home, &root)
}

/// 列出隔离快照。不取 WorkspaceFsAccess：入参只有 home，扫的是应用自己的
/// `~/.greyWork/worktrees`，没有任何用户可控路径参与，无需授权校验。
#[tauri::command]
pub fn worktree_list(app: tauri::AppHandle) -> Result<Vec<WorktreeEntryDto>, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("读取主目录失败: {error}"))?;
    list(&home)
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
        let dir = std::env::temp_dir().join(format!("greywork-worktree-{tag}-{nanos}"));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    /// 授权根是 home：源项目放 home 下，worktree 目标在 home/.greyWork 下，都覆盖在根内。
    fn home_fixture(tag: &str) -> (PathBuf, WorkspaceFsAccess) {
        let home = temp_dir(tag);
        let access = WorkspaceFsAccess::new(&home, home.join("gw-worktree-access-test.json"))
            .expect("创建授权状态");
        (home, access)
    }

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

    fn init_repo(root: &Path) {
        git_available();
        Command::new("git")
            .current_dir(root)
            .args(["init", "-q", "-b", "main"])
            .status()
            .expect("git init");
        for (key, value) in [
            ("user.name", "GreyWork Test"),
            ("user.email", "test@greywork.local"),
        ] {
            Command::new("git")
                .current_dir(root)
                .args(["config", key, value])
                .status()
                .expect("git config");
        }
        std::fs::write(root.join("a.txt"), "one\n").expect("写 a");
        Command::new("git")
            .current_dir(root)
            .args(["add", "-A"])
            .status()
            .expect("git add");
        Command::new("git")
            .current_dir(root)
            .args(["commit", "-m", "init"])
            .status()
            .expect("git commit");
    }

    /// 普通目录快照：复制兜底。
    #[test]
    fn plain_dir_uses_copy_fallback() {
        let (home, access) = home_fixture("copy-src");
        let root = home.join("project");
        std::fs::create_dir_all(&root).expect("建源目录");
        std::fs::write(root.join("x.txt"), "x\n").expect("写文件");
        std::fs::create_dir(root.join("sub")).expect("建子目录");
        std::fs::write(root.join("sub/y.txt"), "y\n").expect("写子文件");
        let dto = provision(&access, &home, &root.to_string_lossy()).expect("provision");
        assert_eq!(dto.kind, "copy");
        let target = PathBuf::from(&dto.root);
        assert!(target.join("x.txt").is_file());
        assert!(target.join("sub/y.txt").is_file());
        assert_eq!(
            target,
            home.join(".greyWork/worktrees")
                .join(deterministic_target_name(&root).unwrap())
        );
        // 幂等：同一 source 返回同一目录
        let again = provision(&access, &home, &root.to_string_lossy()).expect("再次 provision");
        assert_eq!(again.root, dto.root);
        release(&access, &home, &dto.root).expect("release");
        assert!(!target.exists());
        let _ = std::fs::remove_dir_all(home);
    }

    /// 复制快照不带走 .git / .greyWork（应用私有数据与 git 元数据都不该进快照）。
    #[test]
    fn copy_skips_git_and_app_data() {
        let (home, access) = home_fixture("copy-skip");
        let root = home.join("project");
        std::fs::create_dir_all(&root).expect("建源目录");
        std::fs::write(root.join(".git"), "# 假 gitdir").expect("写 .git");
        std::fs::write(root.join(".greyWork"), "app data").expect("写 .greyWork");
        std::fs::write(root.join("keep.txt"), "k\n").expect("写保留文件");
        let dto = provision(&access, &home, &root.to_string_lossy()).expect("provision");
        let target = PathBuf::from(&dto.root);
        assert!(target.join("keep.txt").is_file());
        assert!(!target.join(".git").exists());
        assert!(!target.join(".greyWork").exists());
        let _ = std::fs::remove_dir_all(home);
    }

    /// git 仓库：真实 worktree。
    #[test]
    fn git_repo_creates_real_worktree() {
        let (home, access) = home_fixture("git-repo");
        let repo = home.join("repo");
        std::fs::create_dir_all(&repo).expect("建仓库目录");
        init_repo(&repo);
        std::fs::write(repo.join("new.txt"), "n\n").expect("写未提交文件");
        let dto = provision(&access, &home, &repo.to_string_lossy()).expect("provision");
        assert_eq!(dto.kind, "git");
        let target = PathBuf::from(&dto.root);
        assert!(target.is_dir());
        // 真实 worktree 的特征：目录里有 .git 文件（指向共享对象库）
        assert!(target.join(".git").is_file());
        // 源仓库的未提交文件不会出现在新 worktree 里（独立 checkout）
        assert!(!target.join("new.txt").exists());
        // 幂等
        let again = provision(&access, &home, &repo.to_string_lossy()).expect("再次 provision");
        assert_eq!(again.root, dto.root);
        // release 后 git 不再认识这个 worktree
        release(&access, &home, &dto.root).expect("release");
        assert!(!target.exists());
        let list = Command::new("git")
            .current_dir(&repo)
            .args(["worktree", "list"])
            .output()
            .expect("worktree list");
        assert!(!String::from_utf8_lossy(&list.stdout).contains(target.to_str().unwrap()));
        let _ = std::fs::remove_dir_all(home);
    }

    /// 数据根直通：不给 ~/.greyWork 造分身，且不可被 release 删除。
    #[test]
    fn default_root_passes_through() {
        let home = temp_dir("direct-home");
        let base = store_fs::default_root(&home).expect("default root");
        let access = WorkspaceFsAccess::new(&base, base.join("gw-access.json")).expect("授权");
        let dto = provision(&access, &home, &base.to_string_lossy()).expect("provision");
        assert_eq!(dto.kind, "direct");
        assert_eq!(dto.root, base.to_string_lossy());
        // 直通不落快照，故不出现在列表里（WorktreeEntryDto 文档承诺的不变量）。
        assert!(list(&home).expect("list").is_empty());
        assert!(release(&access, &home, &base.to_string_lossy()).is_err());
        let _ = std::fs::remove_dir_all(home);
    }

    /// 授权边界：源在授权根之外必须被拒绝。
    #[test]
    fn unauthorized_source_is_rejected() {
        let (home, access) = home_fixture("auth");
        let outside = temp_dir("auth-outside");
        let result = provision(&access, &home, &outside.to_string_lossy());
        assert!(result.is_err(), "worktree 不应暴露未授权源");
        let _ = std::fs::remove_dir_all(home);
        let _ = std::fs::remove_dir_all(outside);
    }

    /// 目标目录名对同一源确定：slug+hash 不许漂移（会话恢复依赖它）。
    #[test]
    fn deterministic_path_for_same_source() {
        let (home, _access) = home_fixture("det");
        let root = home.join("project");
        std::fs::create_dir_all(&root).expect("建源目录");
        let name_a = deterministic_target_name(&root).expect("目标名 a");
        let name_b = deterministic_target_name(&root).expect("目标名 b");
        assert_eq!(name_a, name_b);
        let other = home.join("other");
        std::fs::create_dir_all(&other).expect("建其他目录");
        assert_ne!(
            deterministic_target_name(&root).unwrap(),
            deterministic_target_name(&other).unwrap()
        );
        let _ = std::fs::remove_dir_all(home);
    }

    /// worktree 根必须落在授权根 home 下；hack 一个指向根外路径的 release 要被拒。
    #[test]
    fn release_rejects_outside_worktree_base() {
        let (home, access) = home_fixture("release-out");
        let outside = temp_dir("release-outside");
        std::fs::write(outside.join("x.txt"), "x").expect("写外部文件");
        let root = home.join("project");
        std::fs::create_dir_all(&root).expect("建源目录");
        let dto = provision(&access, &home, &root.to_string_lossy()).expect("provision");
        // 同一授权根内、但不在 worktrees 基目录下的路径：拒绝（防删用户目录）
        let wrong = home.join("sessions");
        std::fs::create_dir_all(&wrong).expect("建目录");
        assert!(release(&access, &home, &wrong.to_string_lossy()).is_err());
        release(&access, &home, &dto.root).expect("正常 release");
        let _ = std::fs::remove_dir_all(home);
        let _ = std::fs::remove_dir_all(outside);
    }

    /// 一次都没派过隔离快照时列出空表（而不是报错）——设置页据此渲染「暂无快照」。
    #[test]
    fn list_empty_base_returns_empty() {
        let (home, _access) = home_fixture("list-empty");
        assert!(list(&home).expect("list").is_empty());
        let _ = std::fs::remove_dir_all(home);
    }

    /// provision 两个源后列出两条：kind / source / bytes 与快照实际内容对得上。
    #[test]
    fn list_reports_provisioned_snapshots() {
        let (home, access) = home_fixture("list-rows");
        let plain = home.join("project");
        std::fs::create_dir_all(&plain).expect("建源目录");
        std::fs::write(plain.join("x.txt"), "0123456789").expect("写文件");
        let repo = home.join("repo");
        std::fs::create_dir_all(&repo).expect("建仓库目录");
        init_repo(&repo);

        let copied =
            provision(&access, &home, &plain.to_string_lossy()).expect("provision 普通目录");
        let git_dto = provision(&access, &home, &repo.to_string_lossy()).expect("provision 仓库");

        let rows = list(&home).expect("list");
        assert_eq!(rows.len(), 2);
        // root 与 provision 返回值同形（都过 strip），前端才能原样回传 release
        let copy_row = rows
            .iter()
            .find(|row| row.root == copied.root)
            .expect("副本行");
        assert_eq!(copy_row.kind, "copy");
        assert_eq!(copy_row.source, strip(&plain));
        // 快照里除 x.txt 外还有一颗 provision 标记文件，故是「不小于」而非相等。
        assert!(copy_row.bytes >= 10, "副本至少含 x.txt 的 10 字节");
        let git_row = rows
            .iter()
            .find(|row| row.root == git_dto.root)
            .expect("git 行");
        assert_eq!(git_row.kind, "git");
        assert_eq!(git_row.source, strip(&repo));
        assert!(git_row.bytes > 0, "git 快照至少含检出的 a.txt");
        // root 升序稳定
        assert!(rows[0].root <= rows[1].root);
        let _ = std::fs::remove_dir_all(home);
    }

    /// 基目录里没有 provision 标记的目录不列 —— 不臆造 release 会拒收的条目。
    #[test]
    fn list_skips_unmarked_dirs() {
        let (home, _access) = home_fixture("list-stray");
        let base = store_fs::default_root(&home)
            .expect("default root")
            .join(WORKTREES_SUB_DIR);
        std::fs::create_dir_all(base.join("manual")).expect("建无标记目录");
        std::fs::write(base.join("loose.txt"), "not a dir").expect("建散文件");
        assert!(list(&home).expect("list").is_empty());
        let _ = std::fs::remove_dir_all(home);
    }

    /// release 后该条不再出现（回收面板刷新即可看到行消失）。
    #[test]
    fn list_drops_released_entry() {
        let (home, access) = home_fixture("list-release");
        let plain = home.join("project");
        std::fs::create_dir_all(&plain).expect("建源目录");
        std::fs::write(plain.join("x.txt"), "x\n").expect("写文件");
        let dto = provision(&access, &home, &plain.to_string_lossy()).expect("provision");
        assert_eq!(list(&home).expect("list").len(), 1);

        release(&access, &home, &dto.root).expect("release");

        assert!(list(&home).expect("list").is_empty());
        let _ = std::fs::remove_dir_all(home);
    }

    fn deterministic_target_name(source: &Path) -> Result<String, String> {
        deterministic_target(Path::new("/unused"), source)
            .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
    }
}
