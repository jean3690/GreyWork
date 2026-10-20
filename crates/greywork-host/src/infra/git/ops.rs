//! 变更 / diff / 暂存 / 提交 / 分支命令实现。

use std::path::Path;

use crate::core::ports::WorkspaceFs;

use super::dto::{CommitResultDto, GitChangeDto, GitStatusDto};
use super::exec::run_git;
use super::path::{resolve_root, validate_rel_path};
use super::porcelain::{
    collect_numstat, collect_records, collect_status, letter_to_status, numstat_of,
};

/// 变更状态列表（status），供变更面板展示。
pub(super) fn status(access: &dyn WorkspaceFs, root: &str) -> Result<Vec<GitStatusDto>, String> {
    collect_status(&resolve_root(access, root)?)
}

/// status + 每文件**分侧**的行级增删。
pub(super) fn changes(access: &dyn WorkspaceFs, root: &str) -> Result<Vec<GitChangeDto>, String> {
    let root = resolve_root(access, root)?;
    let records = collect_records(&root)?;
    let unstaged = collect_numstat(&root, false)?;
    let staged = collect_numstat(&root, true)?;
    Ok(records
        .into_iter()
        .map(|record| {
            let (work_add, work_del) = numstat_of(&unstaged, &record.path);
            let (staged_add, staged_del) = numstat_of(&staged, &record.path);
            GitChangeDto {
                path: record.path,
                old_path: record.old_path,
                // `??`（未跟踪）只在 worktree 侧有意义：index 侧的 `?` 不是「已暂存」。
                index: if record.index == '?' {
                    None
                } else {
                    letter_to_status(record.index)
                },
                worktree: letter_to_status(record.worktree),
                staged_add,
                staged_del,
                add: work_add,
                del: work_del,
            }
        })
        .collect())
}

/// 统一 diff：`staged` 为真看 index（已暂存）侧，否则看 worktree（未暂存）侧；
/// `path` 缺省为全量。
///
/// **两侧不再拼接**：变更面板现在按「已暂存 / 未暂存」分区展示，拼在一起就分不清
/// 哪段属于哪一侧了（旧实现把两段 diff 直接接起来，正是这个问题的来源）。
pub(super) fn diff(
    access: &dyn WorkspaceFs,
    root: &str,
    path: Option<&str>,
    staged: bool,
) -> Result<String, String> {
    let root = resolve_root(access, root)?;
    let mut args: Vec<&str> = vec!["diff"];
    if staged {
        args.push("--cached");
    }
    if let Some(path) = path {
        validate_rel_path(path)?;
        args.push("--");
        args.push(path);
    }
    run_git(&root, &args)
}

/// index 里有没有已暂存的改动。
///
/// 用「`--name-only` 输出是否为空」判断，而不是去匹配 git 的英文报错
/// （`no changes added to commit` 这类文案随版本变，也被 locale 影响）。
fn has_staged_changes(root: &Path) -> Result<bool, String> {
    Ok(!run_git(root, &["diff", "--cached", "--name-only"])?
        .trim()
        .is_empty())
}

/// 暂存：`all` 走 `add -A`，否则只 add 指定路径（**必须带 `--`**，防 `-` 开头被当选项）。
pub(super) fn stage(
    access: &dyn WorkspaceFs,
    root: &str,
    paths: &[String],
    all: bool,
) -> Result<(), String> {
    let root = resolve_root(access, root)?;
    if all {
        run_git(&root, &["add", "-A"]).map_err(|error| format!("暂存变更失败: {error}"))?;
        return Ok(());
    }
    if paths.is_empty() {
        return Err("没有指定要暂存的文件".into());
    }
    let mut args: Vec<&str> = vec!["add", "--"];
    for path in paths {
        validate_rel_path(path)?;
        args.push(path);
    }
    run_git(&root, &args).map_err(|error| format!("暂存变更失败: {error}"))?;
    Ok(())
}

/// 取消暂存。
///
/// 两个坑：
/// - **未提交仓库（unborn HEAD）没有 HEAD 可 reset**，`git restore --staged` 会报
///   `could not resolve HEAD`；这种仓库回落 `git rm --cached -r`（本来就什么都还没进过提交，
///   「取消暂存」等价于「从索引里拿掉」）。
/// - **重命名要成对处理**：只 reset 新路径会留下一条「旧路径已删除」的索引条目，
///   界面上就是一个删不掉的幽灵变更。
pub(super) fn unstage(
    access: &dyn WorkspaceFs,
    root: &str,
    paths: &[String],
    all: bool,
) -> Result<(), String> {
    let root = resolve_root(access, root)?;
    let has_head = run_git(&root, &["rev-parse", "--verify", "HEAD"]).is_ok();
    let mut targets: Vec<String> = Vec::new();
    if !all {
        if paths.is_empty() {
            return Err("没有指定要取消暂存的文件".into());
        }
        targets = expand_renames(&root, paths)?;
    }

    let mut args: Vec<&str> = if has_head {
        vec!["restore", "--staged"]
    } else {
        vec!["rm", "--cached", "-r", "-q"]
    };
    args.push("--");
    if all {
        args.push(".");
    } else {
        for path in &targets {
            args.push(path);
        }
    }
    run_git(&root, &args).map_err(|error| format!("取消暂存失败: {error}"))?;
    Ok(())
}

/// 把要取消暂存的路径补成「新路径 + 重命名前的旧路径」，并按同一套规则校验。
fn expand_renames(root: &Path, paths: &[String]) -> Result<Vec<String>, String> {
    let records = collect_records(root)?;
    let mut out: Vec<String> = Vec::new();
    for path in paths {
        validate_rel_path(path)?;
        out.push(path.clone());
        if let Some(record) = records.iter().find(|record| &record.path == path) {
            if let Some(old) = &record.old_path {
                out.push(old.clone());
            }
        }
    }
    Ok(out)
}

/// 提交。`all: true` = 先 `add -A` 再提交（旧的「提交全部」行为）；
/// `all: false` = 只提交已暂存的内容，索引为空时给出中文文案而不是 git 的英文报错。
pub(super) fn commit(
    access: &dyn WorkspaceFs,
    root: &str,
    message: &str,
    all: bool,
) -> Result<CommitResultDto, String> {
    let root = resolve_root(access, root)?;
    let message = message.trim();
    if message.is_empty() {
        return Err("提交信息不能为空".into());
    }
    if all {
        run_git(&root, &["add", "-A"]).map_err(|error| format!("暂存变更失败: {error}"))?;
    } else if !has_staged_changes(&root)? {
        return Err("没有已暂存的变更".into());
    }
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

pub(super) fn current_branch(access: &dyn WorkspaceFs, root: &str) -> Result<String, String> {
    Ok(
        run_git(&resolve_root(access, root)?, &["branch", "--show-current"])?
            .trim()
            .to_string(),
    )
}

pub(super) fn branch_list(access: &dyn WorkspaceFs, root: &str) -> Result<Vec<String>, String> {
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
