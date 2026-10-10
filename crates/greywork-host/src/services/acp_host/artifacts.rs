//! 回合产物扫描（prompt-done 自动开预览的数据源）。

use std::path::{Path, PathBuf};

/// 回合产物预览白名单扩展名（小写、无点）。与前端查看器能力对齐：文本产物
/// （md/html/csv）+ Office 二进制（xlsx/docx/pptx）+ pdf。
/// 故意不放 json/txt：agent 回合里改配置文件、README、锁文件太常见，
/// 弹出来是噪音而不是「交付物」。
const TURN_ARTIFACT_EXTS: &[&str] = &["md", "html", "csv", "xlsx", "docx", "pptx", "pdf"];

/// 遍历时跳过的目录：依赖 / 构建产物 / 缓存。隐藏目录（.git、.cache…）整体跳过。
const TURN_ARTIFACT_SKIP_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "coverage",
    "__pycache__",
    ".venv",
    "venv",
];

/// 递归深度上限：产物目录嵌套通常很浅（≤3 层），上限防极端嵌套拖慢回合收尾。
const TURN_ARTIFACT_MAX_DEPTH: usize = 8;

pub(super) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn system_time_ms(time: std::time::SystemTime) -> u64 {
    time.duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// 是否值得作为回合产物上报：白名单扩展名 + 排除 Office 锁文件（`~$` 前缀）
/// 与隐藏文件（`.name`）。扩展名大小写不敏感。
pub(super) fn is_turn_artifact_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    if name.starts_with("~$") || name.starts_with('.') || name.ends_with('~') {
        return false;
    }
    let Some(extension) = path.extension().and_then(|e| e.to_str()) else {
        return false;
    };
    let extension = extension.to_ascii_lowercase();
    TURN_ARTIFACT_EXTS
        .iter()
        .any(|candidate| *candidate == extension)
}

/// 收集 `root` 下自 `since_ms` 以来 mtime 变化过的白名单文件（绝对路径，字典序）。
/// 目录过滤：隐藏目录与已知噪音目录不进入；符号链接不跟随（防循环与逃逸）。
/// 同步 IO，调用方须放 spawn_blocking。
pub(crate) fn scan_turn_artifacts(root: &Path, since_ms: u64) -> Vec<PathBuf> {
    fn walk(dir: &Path, since_ms: u64, depth: usize, out: &mut Vec<PathBuf>) {
        if depth > TURN_ARTIFACT_MAX_DEPTH {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if file_type.is_dir() {
                if name.starts_with('.') || TURN_ARTIFACT_SKIP_DIRS.contains(&name.as_ref()) {
                    continue;
                }
                walk(&path, since_ms, depth + 1, out);
            } else if file_type.is_file() && is_turn_artifact_file(&path) {
                if let Ok(metadata) = entry.metadata() {
                    if let Ok(modified) = metadata.modified() {
                        if system_time_ms(modified) >= since_ms {
                            out.push(path);
                        }
                    }
                }
            }
        }
    }
    let mut found = Vec::new();
    walk(root, since_ms, 0, &mut found);
    found.sort();
    found
}
