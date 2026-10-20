//! 前端 fs.scoped 能力的宿主侧沙箱：每插件一个受配额约束的私有文件区。
//!
//! 落盘位置 `<app_data>/plugins/<plugin-id>/files/`，插件只能看到自己的子树。
//! 防线（与前端 broker 各自独立实现，纵深防御）：
//! - 路径净化：拒绝对路径、`..`、盘符相对、保留设备名（`path_safety::sanitize_rel_path`）；
//! - 拒绝符号链接（插件无创建链接的能力，读到链接视为越界前兆）；
//! - 单文件 1 MiB、每插件总量 8 MiB；写入前先算配额，超限即拒；
//! - 原子写（temp + rename），失败不破坏既有文件；
//! - 只处理 UTF-8 文本（二进制资产留待后续版本，与 net.fetch 的文本口径一致）。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::host::HostContext;

use super::install::plugins_root;
use super::validate::validate_dir_key;

/// 单文件上限。
const MAX_PLUGIN_FS_FILE_BYTES: u64 = 1024 * 1024;
/// 每插件文件区总量上限。
const MAX_PLUGIN_FS_TOTAL_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginFsOp {
    Read,
    Write,
    Remove,
    List,
    Stat,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFsRequest {
    pub plugin_id: String,
    pub op: PluginFsOp,
    pub path: String,
    #[serde(default)]
    pub data: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFsEntry {
    pub name: String,
    pub dir: bool,
    pub bytes: u64,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFsResponse {
    /// 该次操作涉及的字节数（文件大小）。
    pub bytes: u64,
    /// 操作后该插件文件区总量（write / remove 有值，其余为 0）。
    pub total_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entries: Option<Vec<PluginFsEntry>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exists: Option<bool>,
}

fn plugin_fs_root(host: &dyn HostContext, plugin_id: &str) -> Result<PathBuf, String> {
    validate_dir_key(plugin_id, "plugin id")?;
    Ok(plugins_root(host).join(plugin_id).join("files"))
}

/// 把插件的相对路径解析成沙箱内的绝对路径。`allow_root` 时允许空串 = 沙箱根。
fn resolve_path(root: &Path, raw: &str, allow_root: bool) -> Result<PathBuf, String> {
    if raw.trim().is_empty() {
        if allow_root {
            return Ok(root.to_path_buf());
        }
        return Err("fs.scoped requires a non-empty relative path".to_string());
    }
    let rel = crate::path_safety::sanitize_rel_path(raw)
        .ok_or_else(|| format!("fs.scoped path is not a safe relative path: {raw:?}"))?;
    Ok(root.join(rel))
}

/// 递归统计沙箱占用（跳过符号链接）。
fn dir_size(root: &Path) -> u64 {
    let mut total = 0;
    let Ok(entries) = std::fs::read_dir(root) else {
        return 0;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            total += dir_size(&entry.path());
        } else if let Ok(meta) = entry.metadata() {
            total += meta.len();
        }
    }
    total
}

fn fs_read(root: &Path, raw: &str) -> Result<PluginFsResponse, String> {
    let target = resolve_path(root, raw, false)?;
    let meta = match std::fs::symlink_metadata(&target) {
        Ok(meta) => meta,
        Err(_) => {
            return Ok(PluginFsResponse {
                exists: Some(false),
                ..Default::default()
            })
        }
    };
    if meta.file_type().is_symlink() {
        return Err("fs.scoped refuses to follow symbolic links".to_string());
    }
    if meta.is_dir() {
        return Err(format!("fs.scoped cannot read a directory: {raw:?}"));
    }
    if meta.len() > MAX_PLUGIN_FS_FILE_BYTES {
        return Err(format!(
            "fs.scoped file exceeds the {MAX_PLUGIN_FS_FILE_BYTES} byte limit"
        ));
    }
    let bytes =
        std::fs::read(&target).map_err(|error| format!("fs.scoped read failed: {error}"))?;
    let data = String::from_utf8(bytes)
        .map_err(|_| "fs.scoped file is not valid UTF-8 text".to_string())?;
    Ok(PluginFsResponse {
        exists: Some(true),
        bytes: meta.len(),
        data: Some(data),
        ..Default::default()
    })
}

fn fs_write(root: &Path, raw: &str, data: &str) -> Result<PluginFsResponse, String> {
    let target = resolve_path(root, raw, false)?;
    let bytes = data.as_bytes();
    if bytes.len() as u64 > MAX_PLUGIN_FS_FILE_BYTES {
        return Err(format!(
            "fs.scoped value exceeds the {MAX_PLUGIN_FS_FILE_BYTES} byte per-file limit"
        ));
    }
    if let Ok(meta) = std::fs::symlink_metadata(&target) {
        if meta.file_type().is_symlink() {
            return Err("fs.scoped refuses to overwrite a symbolic link".to_string());
        }
        if meta.is_dir() {
            return Err(format!("fs.scoped cannot overwrite a directory: {raw:?}"));
        }
    }
    let existing = std::fs::metadata(&target)
        .map(|meta| meta.len())
        .unwrap_or(0);
    if dir_size(root).saturating_sub(existing) + bytes.len() as u64 > MAX_PLUGIN_FS_TOTAL_BYTES {
        return Err(format!(
            "fs.scoped exceeds the {MAX_PLUGIN_FS_TOTAL_BYTES} byte per-plugin quota"
        ));
    }
    let parent = target
        .parent()
        .ok_or_else(|| "fs.scoped path has no parent".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| format!("fs.scoped mkdir failed: {error}"))?;
    let file_name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| "fs.scoped path has no file name".to_string())?;
    // 同目录临时文件 + rename：Windows 上 rename 走 REPLACE_EXISTING，可直接覆盖。
    let temp = target.with_file_name(format!(".{file_name}.tmp-{}", std::process::id()));
    std::fs::write(&temp, bytes).map_err(|error| format!("fs.scoped write failed: {error}"))?;
    std::fs::rename(&temp, &target).map_err(|error| format!("fs.scoped commit failed: {error}"))?;
    Ok(PluginFsResponse {
        bytes: bytes.len() as u64,
        total_bytes: dir_size(root),
        ..Default::default()
    })
}

fn fs_remove(root: &Path, raw: &str) -> Result<PluginFsResponse, String> {
    let target = resolve_path(root, raw, false)?;
    let meta = match std::fs::symlink_metadata(&target) {
        Ok(meta) => meta,
        Err(_) => {
            return Ok(PluginFsResponse {
                removed: Some(false),
                total_bytes: dir_size(root),
                ..Default::default()
            })
        }
    };
    if meta.is_dir() && !meta.file_type().is_symlink() {
        std::fs::remove_dir_all(&target)
            .map_err(|error| format!("fs.scoped rmdir failed: {error}"))?;
    } else {
        std::fs::remove_file(&target)
            .map_err(|error| format!("fs.scoped remove failed: {error}"))?;
    }
    Ok(PluginFsResponse {
        removed: Some(true),
        total_bytes: dir_size(root),
        ..Default::default()
    })
}

fn fs_list(root: &Path, raw: &str) -> Result<PluginFsResponse, String> {
    let target = resolve_path(root, raw, true)?;
    if !target.is_dir() {
        return Ok(PluginFsResponse {
            exists: Some(false),
            entries: Some(Vec::new()),
            ..Default::default()
        });
    }
    let mut entries = Vec::new();
    let read =
        std::fs::read_dir(&target).map_err(|error| format!("fs.scoped list failed: {error}"))?;
    for entry in read.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let bytes = if file_type.is_dir() {
            0
        } else {
            entry.metadata().map(|meta| meta.len()).unwrap_or(0)
        };
        entries.push(PluginFsEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            dir: file_type.is_dir(),
            bytes,
        });
    }
    entries.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(PluginFsResponse {
        exists: Some(true),
        entries: Some(entries),
        ..Default::default()
    })
}

fn fs_stat(root: &Path, raw: &str) -> Result<PluginFsResponse, String> {
    let target = resolve_path(root, raw, true)?;
    let meta = match std::fs::symlink_metadata(&target) {
        Ok(meta) => meta,
        Err(_) => {
            return Ok(PluginFsResponse {
                exists: Some(false),
                ..Default::default()
            })
        }
    };
    if meta.file_type().is_symlink() {
        return Err("fs.scoped refuses to stat a symbolic link".to_string());
    }
    let bytes = if meta.is_dir() { 0 } else { meta.len() };
    Ok(PluginFsResponse {
        exists: Some(true),
        bytes,
        ..Default::default()
    })
}

/// 前端 fs.scoped 能力 broker 的宿主侧入口：按 pluginId 落到各自沙箱。
pub fn plugin_fs(
    host: &dyn HostContext,
    request: PluginFsRequest,
) -> Result<PluginFsResponse, String> {
    let root = plugin_fs_root(host, &request.plugin_id)?;
    match request.op {
        PluginFsOp::Read => fs_read(&root, &request.path),
        PluginFsOp::Write => fs_write(&root, &request.path, request.data.as_deref().unwrap_or("")),
        PluginFsOp::Remove => fs_remove(&root, &request.path),
        PluginFsOp::List => fs_list(&root, &request.path),
        PluginFsOp::Stat => fs_stat(&root, &request.path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);

    /// 每用例独立临时沙箱根，Drop 时清理。
    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new() -> Self {
            let seq = SEQ.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir()
                .join(format!("gw-plugin-fs-test-{}-{seq}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn write_then_read_round_trips() {
        let root = TempRoot::new();
        let written = fs_write(root.path(), "logs/a.txt", "hello 世界").unwrap();
        assert_eq!(written.bytes, "hello 世界".len() as u64);
        assert_eq!(written.total_bytes, "hello 世界".len() as u64);

        let read = fs_read(root.path(), "logs/a.txt").unwrap();
        assert_eq!(read.exists, Some(true));
        assert_eq!(read.data.as_deref(), Some("hello 世界"));
    }

    #[test]
    fn read_missing_reports_absent() {
        let root = TempRoot::new();
        let read = fs_read(root.path(), "nope.txt").unwrap();
        assert_eq!(read.exists, Some(false));
        assert!(read.data.is_none());
    }

    #[test]
    fn list_reports_sorted_entries() {
        let root = TempRoot::new();
        fs_write(root.path(), "b.txt", "22").unwrap();
        fs_write(root.path(), "a.txt", "1").unwrap();
        fs_write(root.path(), "sub/c.txt", "333").unwrap();

        let listed = fs_list(root.path(), "").unwrap();
        let names: Vec<&str> = listed
            .entries
            .as_ref()
            .unwrap()
            .iter()
            .map(|entry| entry.name.as_str())
            .collect();
        assert_eq!(names, vec!["a.txt", "b.txt", "sub"]);
        let sub = listed
            .entries
            .as_ref()
            .unwrap()
            .iter()
            .find(|entry| entry.name == "sub")
            .unwrap();
        assert!(sub.dir);
    }

    #[test]
    fn stat_reports_file_and_missing() {
        let root = TempRoot::new();
        fs_write(root.path(), "x.txt", "1234").unwrap();
        let stat = fs_stat(root.path(), "x.txt").unwrap();
        assert_eq!(stat.exists, Some(true));
        assert_eq!(stat.bytes, 4);

        let missing = fs_stat(root.path(), "x.txt.missing").unwrap();
        assert_eq!(missing.exists, Some(false));
    }

    #[test]
    fn remove_deletes_file_and_directory() {
        let root = TempRoot::new();
        fs_write(root.path(), "sub/a.txt", "x").unwrap();
        let removed = fs_remove(root.path(), "sub").unwrap();
        assert_eq!(removed.removed, Some(true));
        assert!(!root.path().join("sub").exists());

        let again = fs_remove(root.path(), "sub").unwrap();
        assert_eq!(again.removed, Some(false));
    }

    #[test]
    fn reject_unsafe_paths() {
        let root = TempRoot::new();
        for bad in [
            "../evil",
            "/etc/passwd",
            "a/../../b",
            "c:evil",
            "sub/con.txt",
            "",
        ] {
            assert!(
                fs_write(root.path(), bad, "x").is_err(),
                "{bad:?} 写路径应被拒绝"
            );
            assert!(
                fs_read(root.path(), bad).is_err()
                    || fs_read(root.path(), bad).unwrap().exists == Some(false),
                "{bad:?} 读路径应被拒绝或视为不存在"
            );
        }
        // 根外未被触碰
        assert!(!std::env::temp_dir().join("evil").exists());
    }

    #[test]
    fn reject_oversized_single_file() {
        let root = TempRoot::new();
        let oversized = "x".repeat(MAX_PLUGIN_FS_FILE_BYTES as usize + 1);
        let error = fs_write(root.path(), "big.txt", &oversized).unwrap_err();
        assert!(error.contains("per-file limit"), "{error}");
        assert!(!root.path().join("big.txt").exists());
    }

    #[test]
    fn enforce_total_quota_and_allow_shrink() {
        let root = TempRoot::new();
        // 单文件上限 1 MiB，正好写满 8 MiB 总量。
        let chunk = "y".repeat(MAX_PLUGIN_FS_FILE_BYTES as usize);
        for index in 0..8 {
            fs_write(root.path(), &format!("chunk-{index}.txt"), &chunk).unwrap();
        }
        // 第 9 个哪怕 1 字节也超总量。
        let error = fs_write(root.path(), "overflow.txt", "z").unwrap_err();
        assert!(error.contains("per-plugin quota"), "{error}");
        // 原地缩小不触发配额。
        let shrunk = fs_write(root.path(), "chunk-0.txt", "small").unwrap();
        assert_eq!(shrunk.total_bytes, 7 * MAX_PLUGIN_FS_FILE_BYTES + 5);
        // 缩出来的空间可再写。
        assert!(fs_write(root.path(), "overflow.txt", "z").is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn reject_symbolic_links() {
        use std::os::unix::fs::symlink;
        let root = TempRoot::new();
        let outside =
            std::env::temp_dir().join(format!("gw-plugin-fs-outside-{}", std::process::id()));
        std::fs::write(&outside, "secret").unwrap();
        symlink(&outside, root.path().join("link.txt")).unwrap();

        assert!(fs_read(root.path(), "link.txt").is_err());
        assert!(fs_write(root.path(), "link.txt", "overwrite").is_err());
        // list 跳过符号链接。
        let listed = fs_list(root.path(), "").unwrap();
        assert!(listed
            .entries
            .as_ref()
            .unwrap()
            .iter()
            .all(|entry| entry.name != "link.txt"));

        let _ = std::fs::remove_file(&outside);
    }
}
