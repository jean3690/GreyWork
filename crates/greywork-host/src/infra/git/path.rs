//! 仓库根解析与相对路径校验。

use std::path::{Path, PathBuf};

use crate::core::ports::WorkspaceFs;

pub(super) fn resolve_root(access: &dyn WorkspaceFs, raw: &str) -> Result<PathBuf, String> {
    let path = access.resolve_existing(raw)?;
    let metadata =
        std::fs::metadata(&path).map_err(|error| format!("读取目录元数据失败: {error}"))?;
    if !metadata.is_dir() {
        return Err("git 根必须是目录".into());
    }
    Ok(path)
}

/// 渲染端传来的**仓库相对路径**校验：必须相对、不含 `..`、不以 `-` 开头。
///
/// 参数走 argv 数组，不存在 shell 解释；这里防的是「`-` 开头被 git 当成选项」以及
/// 「路径越出仓库」这两件事。非 ASCII 不受影响（argv 按字节传，`core.quotepath`
/// 只影响输出）。
pub(super) fn validate_rel_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("路径不能为空".into());
    }
    if path.starts_with('-') {
        return Err(format!("非法路径: {path}"));
    }
    // 逐 component 判绝对路径，而不是用 `Path::is_absolute()`：后者在 Windows 上只认
    // 「前缀 + 根」（`C:\x`、`\\srv\share\x`），POSIX 风格的 `/abs/x` 有根没前缀，会被它
    // 放行 —— 而 git 在 Windows 上照样把 `/abs/x` 当绝对路径解释。
    // `Prefix` 单列是为 `C:x` 这类「有前缀无根」的盘符相对路径：它同样会被 git 解释到
    // 仓库之外（与 path_safety.rs 记的那类逃逸同源）。Linux 上 `C:x` 只是个普通文件名，
    // 这里靠 `Path` 的平台语义自动放行，不做过度拒绝。
    let escaped = Path::new(path).components().any(|component| {
        matches!(
            component,
            std::path::Component::ParentDir
                | std::path::Component::RootDir
                | std::path::Component::Prefix(_)
        )
    });
    if escaped {
        return Err(format!("非法路径: {path}"));
    }
    Ok(())
}
