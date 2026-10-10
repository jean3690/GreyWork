//! 提交历史与单次提交 diff。

use crate::core::ports::WorkspaceFs;

use super::dto::GitCommitDto;
use super::exec::run_git;
use super::path::{resolve_root, validate_rel_path};

/// 单次 `git log` 的默认 / 最大条数。
///
/// 上限不是怕 git 慢，而是怕渲染端一次塞进几千条（虚拟列表也扛不住首帧构建）。
/// 需要更多就分页（`skip`）。
const LOG_LIMIT_DEFAULT: u32 = 50;
const LOG_LIMIT_MAX: u32 = 200;

/// 字段分隔符（US，0x1F）与记录分隔符（RS，0x1E）：提交主题可含任意可见字符，
/// 用控制字符当分隔才能避免被「主题里恰好有个逗号/竖线」切错。
pub(super) const LOG_FIELD_SEP: char = '\u{1f}';
pub(super) const LOG_RECORD_SEP: char = '\u{1e}';

/// git log 的输出模板：hash / 短 hash / 作者 / 邮箱 / 提交日期 / 主题 / 引用。
/// 分隔符用 git 的 `%x1f`（US，字段）/ `%x1e`（RS，记录）转义写出。
const LOG_FORMAT: &str = "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%cI%x1f%s%x1f%D%x1e";

/// 解析 `log_format()` 的输出。
///
/// **末尾 refs 定长、中间 subject 用 join 兜底**：`%s`（主题）理论上可含 US，若按位置
/// 取字段会错位。取「前 5 个前缀字段 + 末尾 refs，中间剩下的整体当 subject」——只有主题
/// 含 RS 时才会真错位，那比含 US 更罕见。字段不足 6 个视为坏记录跳过。
pub(super) fn parse_log_records(out: &str) -> Vec<GitCommitDto> {
    out.split(LOG_RECORD_SEP)
        .filter_map(|record| {
            // git 在每条记录后补一个 `\n`，切分后下一条会带前导换行。
            let record = record.trim_matches('\n');
            if record.is_empty() {
                return None;
            }
            let parts: Vec<&str> = record.split(LOG_FIELD_SEP).collect();
            if parts.len() < 6 {
                return None;
            }
            let refs = parts[parts.len() - 1].trim().to_string();
            let subject = parts[5..parts.len() - 1].join(&LOG_FIELD_SEP.to_string());
            Some(GitCommitDto {
                hash: parts[0].to_string(),
                short_hash: parts[1].to_string(),
                author: parts[2].to_string(),
                email: parts[3].to_string(),
                timestamp: parts[4].to_string(),
                subject,
                refs,
            })
        })
        .collect()
}

/// 提交历史（新 → 旧）。
///
/// 未提交仓库（unborn HEAD）没有 HEAD 可遍历，`git log` 会报 `does not have any commits
/// yet`；这不是错误，返回空列表让界面显示「暂无提交」，与「仓库干净」区分开的是列表本身。
pub(super) fn log_history(
    access: &dyn WorkspaceFs,
    root: &str,
    limit: Option<u32>,
    skip: Option<u32>,
) -> Result<Vec<GitCommitDto>, String> {
    let root = resolve_root(access, root)?;
    if run_git(&root, &["rev-parse", "--verify", "HEAD"]).is_err() {
        return Ok(Vec::new());
    }
    let limit = limit.unwrap_or(LOG_LIMIT_DEFAULT).clamp(1, LOG_LIMIT_MAX);
    let skip = skip.unwrap_or(0);
    let max_count = format!("--max-count={limit}");
    let skip_arg = format!("--skip={skip}");
    let out = run_git(&root, &["log", &max_count, &skip_arg, LOG_FORMAT])?;
    Ok(parse_log_records(&out))
}

/// 校验版本号参数：只接受十六进制 hash（短 hash 也是），且不以 `-` 开头。
///
/// 参数走 argv 数组不会被 shell 解释，但 `-` 开头会被 git 当选项；限定为 hex 顺带挡掉
/// 一切「看起来像选项」的输入。渲染端传的是 `git_log` 回的 hash，本就是 hex。
pub(super) fn validate_rev(rev: &str) -> Result<(), String> {
    if rev.is_empty() || rev.starts_with('-') {
        return Err(format!("非法版本号: {rev}"));
    }
    if !rev.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("非法版本号: {rev}"));
    }
    Ok(())
}

/// 单次提交引入的改动（统一 diff 文本）；`path` 限定时只看该路径。
///
/// `--format=` 压掉 git 自带的提交头（作者 / 日期 / 消息）：元信息由 `log_history` 提供，
/// 这里只要 diff 正文 —— 否则渲染端还得再切一次，而切点又受 locale / git 版本影响。
pub(super) fn show_commit(
    access: &dyn WorkspaceFs,
    root: &str,
    hash: &str,
    path: Option<&str>,
) -> Result<String, String> {
    let root = resolve_root(access, root)?;
    validate_rev(hash)?;
    let mut args: Vec<&str> = vec!["show", "--format=", "--patch", hash];
    if let Some(path) = path {
        validate_rel_path(path)?;
        args.push("--");
        args.push(path);
    }
    run_git(&root, &args)
}
