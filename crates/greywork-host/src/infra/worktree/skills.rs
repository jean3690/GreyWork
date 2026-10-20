//! `.agents/skills`：把已安装的技能带进隔离快照（默认全量）。

use std::fs::read_dir;
use std::path::Path;

use super::git::run_git;
use super::linked::is_safe_relative;
use super::{create_symlink, AGENTS_DIR};

const SKILLS_SUBDIR: &str = "skills";

/// 把 `source/.agents/skills` 下的每个子目录 / 文件链接（或复制兜底？）到 `target/.agents/skills/<entry>`。
///
/// 策略：
/// - 源不存在 → 直接跳过；
/// - 目标已存在 `.agents/skills` → 跳过（已有，幂等）；
/// - 目标父目录 `.agents` 不存在 → 创建；
/// - 对每个条目：先用 `validate_safe_path` 做安全校验，不含 `..`、绝对路径；
/// - 如果是 git 仓库，要求条目**被 git 忽略**（防止符号链接本身或其内容扰乱工作树状态）；
///   仅在源目录在 git 仓库时做这条判定（非 git 源也能正常跑）；
/// - 链接已存在 → 跳过；
/// - 创建符号链接失败 → 记录 warn 并**跳过单个条目**（绝不让 provision 整体失败）。
pub(super) fn apply_skills(
    source: &Path,
    target: &Path,
    source_is_git: bool,
    selected: Option<&[String]>,
) {
    let source_skills = source.join(AGENTS_DIR).join(SKILLS_SUBDIR);
    if !source_skills.exists() {
        return;
    }
    let target_skills = target.join(AGENTS_DIR).join(SKILLS_SUBDIR);
    if target_skills.exists() {
        return;
    }
    if let Err(error) = std::fs::create_dir_all(&target_skills) {
        crate::log::warn(
            "worktree",
            format!("创建 .agents/skills 目录失败，跳过 skills 带入: {error}"),
        );
        return;
    }

    // 勾选集（None = 全量；Some(list) = 只带 list，空列表就是都不带）。
    let allow: Option<Vec<String>> = selected.map(|list| list.to_vec());

    let Ok(entries) = read_dir(&source_skills) else {
        return;
    };
    for entry in entries.flatten() {
        let name = match entry.file_name().into_string() {
            Ok(s) => s,
            Err(_) => continue,
        };
        if !is_safe_relative(&name) {
            crate::log::warn(
                "worktree",
                format!(".agents/skills 条目不是安全的相对路径，已跳过: {name}"),
            );
            continue;
        }
        if let Some(list) = &allow {
            if !list.iter().any(|wanted| wanted == &name) {
                continue;
            }
        }
        let rel = format!("{AGENTS_DIR}/{SKILLS_SUBDIR}/{name}");
        if source_is_git {
            // 必须被 git 忽略：符号链接在 git status 里会污染 agent 的变更视图。
            if run_git(source, &["check-ignore", "-q", "--", rel.as_str()]).is_err() {
                crate::log::warn(
                    "worktree",
                    format!(".agents/skills 条目未被 git 忽略，已跳过: {name}"),
                );
                continue;
            }
        }
        let src = source_skills.join(&name);
        let dst = target_skills.join(&name);
        if dst.exists() {
            continue;
        }
        if let Err(error) = create_symlink(&src, &dst) {
            crate::log::warn(
                "worktree",
                format!(".agents/skills 创建符号链接失败 {name}: {error}"),
            );
        }
    }
}
