use super::resolve::*;
use super::*;

/* ===================== 文件树增删改 =====================
 *
 * 全部只作用于**授权根内**、且**操作条目本身而不是符号链接目标**（见 resolve_entry）。
 * 破坏性操作（删除、覆盖式改名）在 UI 侧还有一道确认，宿主这里只守住路径边界与
 * 「不静默覆盖」这两条。
 */

/// 确保目录存在（产物默认目录等工作区相关落盘前置）。
pub fn fs_ensure_dir(access: &WorkspaceFsAccess, path: String) -> Result<(), String> {
    let path = access.resolve_write(&path)?;
    std::fs::create_dir_all(&path).map_err(|error| format!("创建目录失败: {error}"))
}

/// 新建空文件。父目录必须已存在（不做递归创建，避免手滑造出一串目录）。
pub(super) fn create_file(access: &WorkspaceFsAccess, raw: &str) -> Result<(), String> {
    let path = resolve_new_entry(access, raw)?;
    // create_new = O_EXCL：撞名会失败而不是覆盖；目标是指向别处的悬空链接同样失败。
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| format!("新建文件失败: {error}"))?;
    Ok(())
}

/// 新建文件夹（`create_dir` 而非 `create_dir_all`：父目录不存在就报错）。
pub(super) fn create_dir(access: &WorkspaceFsAccess, raw: &str) -> Result<(), String> {
    let path = resolve_new_entry(access, raw)?;
    std::fs::create_dir(&path).map_err(|error| format!("新建文件夹失败: {error}"))
}

/// 改名 / 移动（同一个操作：改名是同目录换名，移动是新目录加原名）。
pub(super) fn rename_path(access: &WorkspaceFsAccess, from: &str, to: &str) -> Result<(), String> {
    let source = movable_source(access, from)?;
    let target = resolve_new_entry(access, to)?;
    if crate::path_safety::same_path(&source, &target) {
        return Err("新名称与原名称相同".into());
    }
    // Path::starts_with 按组件比较，所以 `/w/a.txt` 不会被 `/w/a.txt.bak` 命中；
    // 这里要拦的是「把目录挪进它自己的子树」。
    if target.starts_with(&source) {
        return Err("不能把文件夹移动到它自己内部".into());
    }
    // 显式挡撞名：Unix 的 rename 会**静默覆盖**普通文件，用户会丢数据。
    if target.exists() {
        return Err(format!("目标已存在: {}", target.display()));
    }
    match std::fs::rename(&source, &target) {
        Ok(()) => Ok(()),
        // EXDEV / ERROR_NOT_SAME_DEVICE：源与目标在不同挂载点，rename 不跨设备。降级为
        // 「复制 + 删除」（见 move_across_devices）。
        Err(error) if is_cross_device(&error) => move_across_devices(&source, &target),
        Err(error) => Err(format!("移动失败: {error}")),
    }
}

/// 删除条目。文件夹递归删除（`remove_dir_all` 删的是条目本身，不跟随链接）。
pub(super) fn delete_path(access: &WorkspaceFsAccess, raw: &str) -> Result<(), String> {
    let entry = movable_source(access, raw)?;
    remove_entry(&entry).map_err(|error| format!("删除失败: {error}"))
}

/// 新建空文件（工作区文件树「新建文件」）。
pub fn fs_create_file(access: &WorkspaceFsAccess, path: String) -> Result<(), String> {
    create_file(access, &path)
}

/// 新建文件夹（工作区文件树「新建文件夹」）。
pub fn fs_create_dir(access: &WorkspaceFsAccess, path: String) -> Result<(), String> {
    create_dir(access, &path)
}

/// 改名 / 移动（工作区文件树「重命名 / 剪切后粘贴」）。
pub fn fs_rename_path(access: &WorkspaceFsAccess, from: String, to: String) -> Result<(), String> {
    rename_path(access, &from, &to)
}

/// 删除文件或文件夹（工作区文件树「删除」）。
pub fn fs_delete_path(access: &WorkspaceFsAccess, path: String) -> Result<(), String> {
    delete_path(access, &path)
}

/// 写二进制文件（base64 载荷，≤20MB），产物默认落盘通道。
pub fn fs_write_binary(
    access: &WorkspaceFsAccess,
    path: String,
    data_base64: String,
) -> Result<(), String> {
    // 上限以**解码后的字节数**为准：base64 会把载荷撑大约 4/3，旧实现拿编码串长度
    // 比 20MB，等于把有效上限压到 ~15MB。这里先按编码串长度粗筛一次（避免为一个
    // 超大字符串白分配解码缓冲），再以解码字节数定音。
    let max_encoded = MAX_BINARY_BYTES / 3 * 4 + 8;
    if data_base64.len() > max_encoded {
        return Err("文件超过 20MB 上限".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|error| format!("base64 解码失败: {error}"))?;
    if bytes.len() > MAX_BINARY_BYTES {
        return Err("文件超过 20MB 上限".into());
    }
    let path = access.resolve_write(&path)?;
    std::fs::write(&path, bytes).map_err(|error| format!("写入文件失败: {error}"))
}

/// 写回文本文件（单次 ≤10MB），供编辑器保存时同步到工作区存放文件夹。
pub fn fs_write_text_file(
    access: &WorkspaceFsAccess,
    path: String,
    content: String,
) -> Result<(), String> {
    if content.len() > MAX_TEXT_BYTES {
        return Err("文件超过 10MB 上限".into());
    }
    let path = access.resolve_write(&path)?;
    std::fs::write(&path, content).map_err(|error| format!("写入文件失败: {error}"))
}
