use std::path::Path;

use super::resolve::*;
use super::*;

/// 是否是「跨挂载点 / 跨卷」错误。Unix 为 `EXDEV`(18)，Windows 为
/// `ERROR_NOT_SAME_DEVICE`(17)，两套 errno 都得认，否则 Windows 上只会笼统报「移动失败」。
pub(super) fn is_cross_device(error: &std::io::Error) -> bool {
    #[cfg(windows)]
    {
        error.raw_os_error() == Some(17)
    }
    #[cfg(not(windows))]
    {
        error.raw_os_error() == Some(18)
    }
}

/// 跨挂载点移动的降级路径：复制 → 成功后删源。
///
/// 顺序刻意是「先复制、成了再删源」：`rename` 的原子性在这里拿不到，中间态无法完全避免，
/// 但这样中途失败最多留下一个多余的副本，绝不会出现「源已删、目标残缺」的丢数据形态。
/// 复制失败时清掉半成品目标，别让它冒充成功结果。
///
/// **含符号链接的条目拒绝降级**：`copy_entry` 刻意不跟随链接（不把根外内容搬进来），
/// 若照常删源，那些链接会被一并抹掉 —— 那是静默丢数据。宁可报错让用户自己处置。
pub(super) fn move_across_devices(source: &Path, target: &Path) -> Result<(), String> {
    if has_link_inside(source) {
        return Err("条目内含符号链接，跨磁盘分区移动会丢失这些链接；请改用复制后手动删除".into());
    }
    if let Err(error) = copy_entry(source, target) {
        let _ = remove_entry(target);
        return Err(format!("跨磁盘分区移动失败（复制阶段）: {error}"));
    }
    remove_entry(source).map_err(|error| {
        format!(
            "已复制到目标，但删除源失败: {error} —— 请手动删除 {}",
            source.display()
        )
    })
}

/// 条目自身、或（目录递归地）其内任一条目是否是符号链接 / 重解析点。
///
/// 读不到就当作「有」（保守拒绝）：宁可让用户走复制后手动删除，也不在信息不全时
/// 赌一把把链接删掉。`entry_is_link` 不跟随链接，所以不会顺着链接递归进根外。
pub(super) fn has_link_inside(path: &Path) -> bool {
    if entry_is_link(path) {
        return true;
    }
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return true;
    };
    if !metadata.is_dir() {
        return false;
    }
    let Ok(entries) = std::fs::read_dir(path) else {
        return true;
    };
    entries.into_iter().any(|entry| match entry {
        Ok(entry) => has_link_inside(&entry.path()),
        Err(_) => true,
    })
}

/// 复制条目（文件或目录，递归）。目标必须不存在。
pub(super) fn copy_path(access: &WorkspaceFsAccess, from: &str, to: &str) -> Result<(), String> {
    let source = movable_source(access, from)?;
    if entry_is_link(&source) {
        // 复制链接会跟随到目标（`fs::copy` 读的是目标内容），链接指向根外时
        // 等于把授权面外的内容搬进树里。不做，也不假装能复刻链接本身。
        return Err("不支持复制符号链接".into());
    }
    let target = resolve_new_entry(access, to)?;
    if target.starts_with(&source) {
        return Err("不能把文件夹复制到它自己内部".into());
    }
    if target.exists() {
        return Err(format!("目标已存在: {}", target.display()));
    }
    copy_entry(&source, &target).map_err(|error| format!("复制失败: {error}"))
}

/// 递归复制。**目录内的符号链接 / 重解析点一律跳过**，不跟随。
///
/// 跟随会把授权根之外的内容搬进来（`list_dir` 之所以只用根内条目，也是因为它对每个
/// 条目单独判链接），环状链接还会让递归无限展开。
pub(super) fn copy_entry(source: &Path, target: &Path) -> std::io::Result<()> {
    if entry_is_link(source) {
        return Ok(());
    }
    if std::fs::symlink_metadata(source)?.is_dir() {
        std::fs::create_dir(target)?;
        for entry in std::fs::read_dir(source)? {
            let entry = entry?;
            copy_entry(&entry.path(), &target.join(entry.file_name()))?;
        }
        return Ok(());
    }
    std::fs::copy(source, target).map(|_| ())
}

/// 删除条目（文件 / 目录 / 链接本身，不跟随链接）。
///
/// 用 symlink_metadata：指向目录的符号链接要被当成「文件」删掉链接本身，
/// 而不是递归删掉它指向的目录内容。跨设备移动降级也复用它删源。
pub(super) fn remove_entry(entry: &Path) -> std::io::Result<()> {
    let metadata = std::fs::symlink_metadata(entry)?;
    if metadata.is_dir() {
        std::fs::remove_dir_all(entry)
    } else {
        std::fs::remove_file(entry)
    }
}

/// 复制（工作区文件树「复制后粘贴」，目录递归）。
pub fn fs_copy_path(access: &WorkspaceFsAccess, from: String, to: String) -> Result<(), String> {
    copy_path(access, &from, &to)
}
