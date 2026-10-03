use std::path::{Component, Path, PathBuf};

use super::*;

pub(super) fn validate_absolute(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("只接受绝对路径".into());
    }
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("路径不得包含 ..".into());
    }
    Ok(path.to_path_buf())
}

/// 短暂重试的 `rename`：Windows 上目标文件被编辑器/杀软占用一瞬会让它失败。
///
/// 只重试几次、每次间隔很短 —— 授权账本落盘在命令路径上，不能在这里长时间阻塞。
pub(super) fn rename_with_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    const ATTEMPTS: u32 = 3;
    const DELAY: std::time::Duration = std::time::Duration::from_millis(20);
    let mut result = std::fs::rename(from, to);
    for _ in 1..ATTEMPTS {
        if result.is_ok() {
            break;
        }
        std::thread::sleep(DELAY);
        result = std::fs::rename(from, to);
    }
    result
}

pub(super) fn canonical_existing(path: &Path) -> Result<PathBuf, String> {
    validate_absolute(path)?;
    std::fs::canonicalize(path).map_err(|error| format!("路径不可访问: {error}"))
}

/// 该条目本身是否是符号链接 / Windows 重解析点（不跟随）。
///
/// `list_dir` 里的 `is_link_like` 吃的是 `DirEntry`，按路径判断的场景要单独一份。
pub(super) fn entry_is_link(path: &Path) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        return metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// 新建路径的公共前置：名字安全 + 父目录已存在且在授权根内。返回**条目自身**的路径。
pub(super) fn resolve_new_entry(access: &WorkspaceFsAccess, raw: &str) -> Result<PathBuf, String> {
    let requested = validate_absolute(Path::new(raw))?;
    let name = requested
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "路径缺少文件名".to_string())?;
    // 渲染端已校验一次；这里再兜一次，免得别处（或手改过的前端）塞进非法名。
    if !crate::path_safety::is_safe_path_segment(name) {
        return Err(format!("名称不可用: {name}"));
    }
    let parent = requested
        .parent()
        .ok_or_else(|| "路径缺少父目录".to_string())?;
    if !parent.exists() {
        return Err("父目录不存在".into());
    }
    let canonical_parent = canonical_existing(parent)?;
    access.require_authorized_root(&canonical_parent)?;
    if !canonical_parent.is_dir() {
        return Err("父目录不是文件夹".into());
    }
    Ok(canonical_parent.join(name))
}

/// 可删除 / 可改名 / 可移动的源条目及其守卫。
pub(super) fn movable_source(access: &WorkspaceFsAccess, raw: &str) -> Result<PathBuf, String> {
    let requested = validate_absolute(Path::new(raw))?;
    if crate::path_safety::is_filesystem_root(&requested) {
        return Err("不能操作文件系统根目录".into());
    }
    // 绑定进来的工作区根同样不许动：删掉它会让授权账本指向一个不存在的目录，
    // 而且树里本来就点不到根自身（只列它的子项），这条防的是被构造出来的调用。
    if access.is_authorized_root(&requested) {
        return Err("不能移动或删除已授权的工作区根目录".into());
    }
    let entry = access.resolve_entry(raw)?;
    // 断链的符号链接 `exists()` 是 false，但条目确实在 —— 用 symlink_metadata 兜住。
    if !entry.exists() && std::fs::symlink_metadata(&entry).is_err() {
        return Err(format!("路径不存在: {}", entry.display()));
    }
    Ok(entry)
}

/// 浅层列目录；指向授权根之外的符号链接不会暴露给渲染端。
/// 目录项是否可能是「链接 / 重解析点」——只有这类项才可能指向已授权父目录之外。
///
/// unix 上 `readdir` 的 `d_type` 直接带符号链接位，判定不额外发系统调用。
/// Windows 上目录联接（junction）是重解析点，但 `is_symlink()` 未必为真，
/// 故改按 `FILE_ATTRIBUTE_REPARSE_POINT` 判定：宁可多解析一次，也不能放过越界。
/// 取不到元数据时同样按「可能是」处理（保守方向）。
pub(super) fn is_link_like(entry: &std::fs::DirEntry, file_type: &std::fs::FileType) -> bool {
    if file_type.is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        // `DirEntry::metadata` 在 Windows 复用目录枚举已取回的 WIN32_FIND_DATA，
        // 不额外发系统调用。
        return match entry.metadata() {
            Ok(metadata) => metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0,
            Err(_) => true,
        };
    }
    #[cfg(not(windows))]
    {
        let _ = entry;
        false
    }
}
