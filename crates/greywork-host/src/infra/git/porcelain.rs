//! `git status --porcelain` / `--numstat` 的解析与采集。

use std::path::Path;

use super::dto::GitStatusDto;
use super::exec::run_git;

/// X/Y 两个位置码（staged/worktree）中的非空白码 → 类型化状态；空白 = 无改动。
pub(super) fn letter_to_status(letter: char) -> Option<String> {
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

/// 一条 porcelain 记录：路径 + （重命名 / 复制时的）旧路径 + XY 两个位置码。
#[derive(Debug)]
pub(super) struct StatusRecord {
    pub(super) path: String,
    pub(super) old_path: Option<String>,
    /// X：index（已暂存）侧的位置码。
    pub(super) index: char,
    /// Y：worktree（未暂存）侧的位置码。
    pub(super) worktree: char,
}

/// 解析 `git status --porcelain -z` 的一条记录头（`XY <路径>`）。
///
/// 只解析这一条；重命名 / 复制的**旧路径是紧随其后的另一条记录**，由 `collect_records` 拼上。
///
/// 用 `-z` 形态而不是默认的行形态：`-z` 下路径**原样输出**（不引号、不转义），
/// 重命名/复制的两条路径以 NUL 分隔而不是 ` -> ` 拼接。这样既省掉一整套 C 风格解转义
/// （`core.quotepath=false` 只关掉非 ASCII 的八进制转义，含 `"` / `\` 的路径仍会被
/// 引号包裹），也不会被文件名里恰好含 ` -> ` 的情况骗到。
pub(super) fn parse_status_record(record: &str) -> Option<(char, char, String)> {
    let bytes = record.as_bytes();
    if bytes.len() < 3 || bytes[2] != b' ' {
        return None;
    }
    let path = record[3..].to_string();
    if path.is_empty() {
        return None;
    }
    Some((bytes[0] as char, bytes[1] as char, path))
}

/// `-z` 下重命名/复制的 index 字母：后面还会跟一条「旧路径」记录，必须跳过。
pub(super) fn record_carries_old_path(record: &str) -> bool {
    matches!(record.as_bytes().first(), Some(b'R' | b'C'))
}

/// `git status --porcelain -z` 的全部记录（含重命名配对）。
pub(super) fn collect_records(root: &Path) -> Result<Vec<StatusRecord>, String> {
    let out = run_git(root, &["status", "--porcelain", "-z"])?;
    let mut records = out.split('\0');
    let mut entries = Vec::new();
    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        // 先决定要不要吃掉下一条（旧路径），再做状态校验 —— 校验失败时也不能让
        // 旧路径被当成一条独立记录（那样会凭空多出一个文件）。
        let old_path = if record_carries_old_path(record) {
            records.next().map(str::to_string)
        } else {
            None
        };
        if let Some((index, worktree, path)) = parse_status_record(record) {
            entries.push(StatusRecord {
                path,
                old_path,
                index,
                worktree,
            });
        }
    }
    Ok(entries)
}

/// `git status --porcelain` 全部条目的类型化列表。
pub(super) fn collect_status(root: &Path) -> Result<Vec<GitStatusDto>, String> {
    Ok(collect_records(root)?
        .into_iter()
        .filter_map(|record| {
            let status =
                letter_to_status(record.index).or_else(|| letter_to_status(record.worktree))?;
            Some(GitStatusDto {
                path: record.path,
                status,
                staged: !matches!(record.index, ' ' | '?' | '!'),
            })
        })
        .collect())
}

/// 解析 `--numstat` 的一行（`added\tdeleted\tpath`）。
///
/// 重命名时路径有两种形态，都要取到**新路径**：
/// - `old => new.txt`（前后缀无公共部分）
/// - `dir/{old => new}.txt`（git 把公共前后缀抽到花括号外 —— 这是最容易切错的一种，
///   直接按 `=>` 切会得到 `new}.txt`）
pub(super) fn parse_numstat_line(line: &str) -> Option<(u32, u32, String)> {
    let mut parts = line.split('\t');
    let add = parts.next()?.parse().ok()?;
    let del = parts.next()?.parse().ok()?;
    let path = parts.next()?.trim();
    if path.is_empty() {
        return None;
    }
    Some((add, del, rename_target(path)))
}

/// 行式 numstat 的路径 → 新路径。非重命名原样返回。
fn rename_target(path: &str) -> String {
    let Some((before, after)) = path.split_once(" => ") else {
        return path.to_string();
    };
    let Some(open) = before.rfind('{') else {
        return after.trim().to_string();
    };
    match after.find('}') {
        Some(close) => format!(
            "{}{}{}",
            &before[..open],
            &after[..close],
            &after[close + 1..]
        ),
        // 花括号没闭合：不猜，退化成「取箭头右边」。
        None => after.trim().to_string(),
    }
}

pub(super) fn collect_numstat(
    root: &Path,
    cached: bool,
) -> Result<Vec<(u32, u32, String)>, String> {
    let args: &[&str] = if cached {
        &["diff", "--cached", "--numstat"]
    } else {
        &["diff", "--numstat"]
    };
    let out = run_git(root, args)?;
    Ok(out.lines().filter_map(parse_numstat_line).collect())
}

/// 从一张 numstat 表里取某路径的行级增删；没有就返回 0。
pub(super) fn numstat_of(list: &[(u32, u32, String)], path: &str) -> (u32, u32) {
    list.iter()
        .find(|(_, _, candidate)| candidate == path)
        .map(|(add, del, _)| (*add, *del))
        .unwrap_or((0, 0))
}
