use std::path::{Path, PathBuf};

use super::*;

/* ===== 遍历 / 分块 / 相似度（纯函数，便于单测） ===== */

/// 一个候选文件：路径 + 大小 + mtime（epoch 秒）。
pub(super) struct FileEntry {
    pub(super) path: PathBuf,
    pub(super) size: u64,
    pub(super) mtime: i64,
}

/// 递归收集根下可索引的文本文件（不跟随符号链接，忽略黑名单目录与二进制）。
pub(super) fn collect_files(root: &Path) -> Vec<FileEntry> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    let mut dirs = 0usize;
    while let Some(dir) = stack.pop() {
        if dirs >= MAX_DIRS || out.len() >= MAX_FILES {
            break;
        }
        dirs += 1;
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            if out.len() >= MAX_FILES {
                break;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            // 不跟随符号链接：`file_type` 来自 read_dir 的 dirent，不触发跟随。
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            if file_type.is_dir() {
                if name.starts_with('.')
                    || IGNORE_DIRS
                        .iter()
                        .any(|ignored| ignored.eq_ignore_ascii_case(&name))
                {
                    continue;
                }
                stack.push(path);
                continue;
            }
            if !file_type.is_file() || !is_indexable_name(&name) {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if metadata.len() == 0 || metadata.len() > MAX_FILE_BYTES {
                continue;
            }
            // 二进制嗅探：首 1KB 出现 NUL 即按二进制跳过（扩展名白名单之外的双保险）。
            if let Ok(prefix) = crate::text::read_prefix(&path, 1024) {
                if crate::text::looks_binary(&prefix) {
                    continue;
                }
            }
            let mtime = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |duration| duration.as_secs() as i64);
            out.push(FileEntry {
                path,
                size: metadata.len(),
                mtime,
            });
        }
    }
    out
}

/// 文件名是否属于文本索引白名单（扩展名命中，或属无扩展名的已知文本文件）。
pub(super) fn is_indexable_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if TEXT_FILENAMES.iter().any(|candidate| lower == *candidate) {
        return true;
    }
    match lower.rsplit_once('.') {
        Some((_, ext)) => TEXT_EXTENSIONS.contains(&ext),
        None => false,
    }
}

/// 按行聚合分块：每块目标 `CHUNK_CHARS` 字符，相邻块重叠 `CHUNK_OVERLAP` 字符。
pub(super) fn chunk_text(text: &str) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    for line in text.lines() {
        let line_len = line.chars().count();
        if !current.is_empty() && current.chars().count() + line_len + 1 > CHUNK_CHARS {
            let finished = std::mem::take(&mut current);
            current = tail_chars(&finished, CHUNK_OVERLAP);
            chunks.push(finished);
        }
        current.push_str(line);
        current.push('\n');
    }
    if !current.trim().is_empty() {
        chunks.push(current);
    }
    chunks
}

/// 取字符串末尾 `n` 个字符（不足则不重叠，避免短块被整块重复）。
pub(super) fn tail_chars(value: &str, n: usize) -> String {
    let count = value.chars().count();
    if count <= n {
        return String::new();
    }
    value.chars().skip(count - n).collect()
}
