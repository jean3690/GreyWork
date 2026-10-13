//! 生命周期：`provision` / `release` / `list`。

use std::path::Path;

use crate::core::ports::WorkspaceFs;
use crate::store_fs;

use super::dto::{
    has_marker, read_marker, write_marker, WorktreeEntryDto, WorktreeMarker, WorktreeProvisionDto,
};
use super::git::{
    add_worktree_branch, deterministic_target, is_git_repo, run_git, worktree_branch,
};
use super::linked::apply_linked;
use super::prepare::run_prepare;
use super::skills::apply_skills;
use super::{canonical_home, strip, WORKTREES_SUB_DIR};

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

pub(super) fn provision(
    access: &dyn WorkspaceFs,
    home: &Path,
    source_raw: &str,
    prepare: bool,
    skills: Option<Vec<String>>,
) -> Result<WorktreeProvisionDto, String> {
    let source = access.resolve_existing(source_raw)?;
    if !source.is_dir() {
        return Err("worktree 源必须是目录".into());
    }
    let home = canonical_home(home);
    let default_root = store_fs::default_root(&home)?;
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
    // 快照目录绝不能落在源目录内部：源恰好是数据根时（`~/.greyWork` 内有 `worktrees/`），
    // `copy_dir` 会顺着刚建出来的目标目录一路递归到爆栈。这条不变量挡在复制之前。
    if target.starts_with(&source) {
        return Err(format!(
            "快照目录会落在源目录内部，无法隔离: {}",
            target.display()
        ));
    }
    let stripped = strip(&source);

    // 幂等：已 provision 过就直接复用（目录名对同一 source 确定）。
    if has_marker(&target) {
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
    // 交给 git 的路径要先 strip：Windows 上 `canonicalize` 带来的 `\\?\` 前缀 git 不认，
    // 会让 `worktree add` 失败、静默回落成 copy（snapshot 仍是快照，但不是真 worktree）。
    let target_plain = strip(&target);
    let kind = if is_git_repo(&source) {
        // 在命名分支上检出（而非 `--detach`）：分支进源仓库共享 refs，agent 的提交在
        // release 之后仍可达、可 merge。`--detach` 的提交会随 worktree 一起被丢弃。
        let branch = worktree_branch(&source);
        match add_worktree_branch(Path::new(&stripped), &branch, target_plain.as_str()) {
            Ok(()) => "git",
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
    // `.agents/linked`：把源里被 git 忽略的共享文件以符号链接挂进新快照。
    // 只在源是 git 仓库时有意义（清单本身依赖 git 忽略判定），非 git 源直接跳过。
    let source_is_git = is_git_repo(&source);
    if source_is_git {
        apply_linked(&source, &target);
    }
    // `.agents/skills`：把已安装的技能带进快照（默认全量）。已存在则跳过（幂等），
    // 并与 `linked` 同样在 git 仓库时要求其条目被 git 忽略以减少工作树污染。
    apply_skills(&source, &target, source_is_git, skills.as_deref());
    // `.agents/prepare`：由调用方按权限档决定是否执行（只读档不跑）。先 linked 后 prepare，
    // 好让脚本能用到刚挂进来的共享文件（如 .env）。
    if prepare {
        run_prepare(&target);
    }
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

pub(super) fn release(access: &dyn WorkspaceFs, home: &Path, root_raw: &str) -> Result<(), String> {
    let root = access.resolve_existing(root_raw)?;
    let home = canonical_home(home);
    let default_root = store_fs::default_root(&home)?;
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
                // 与 provision 同一条纪律：交给 git 的路径先 strip 掉 `\\?\`。
                let source_plain = strip(Path::new(&marker.source));
                let source = Path::new(&source_plain);
                if source.is_dir() && is_git_repo(source) {
                    // 必须在仓库内（源）执行，git 不允许移除「当前工作树」。
                    let target_plain = strip(&root);
                    run_git(
                        source,
                        &[
                            "worktree",
                            "remove",
                            "--force",
                            "--force",
                            target_plain.as_str(),
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
pub(super) fn list(home: &Path) -> Result<Vec<WorktreeEntryDto>, String> {
    let home = canonical_home(home);
    let worktrees_base = store_fs::default_root(&home)?.join(WORKTREES_SUB_DIR);
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
