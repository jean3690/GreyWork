use super::dto::*;
use super::resolve::*;
use super::*;

/// 读取文本文件（10MB 上限），供工作区「打开文件」读取真实磁盘文件。
pub fn fs_read_text_file(access: &WorkspaceFsAccess, path: String) -> Result<String, String> {
    let path = access.resolve_existing(&path)?;
    let metadata = std::fs::metadata(&path).map_err(|error| format!("读取元数据失败: {error}"))?;
    if metadata.len() > MAX_TEXT_BYTES as u64 {
        return Err("文件超过 10MB 上限".into());
    }
    // strict UTF-8 会把 Windows 记事本默认的 GBK/GB18030（简中「ANSI」）与 UTF-16
    // 文本文件读成乱码或直接报错；按编码嗅探 + 检测解码，统一回 UTF-8。
    crate::text::decode_text_file(&path).map_err(|error| format!("读取文件失败: {error}"))
}

/// 读二进制文件（**原始字节**回传，≤20MB），供右栏预览真实磁盘上的 xlsx / pdf / 图片等。
///
/// 返回裸 `Vec<u8>`：桌面壳再包一层 `tauri::ipc::Response`（避免 base64 把载荷撑大 33%，
/// 也让前端直接拿到 ArrayBuffer）；headless 服务端则按自身传输形态封装。
///
/// 超过上限是**报错**，不是静默截断 —— 前端会把这句错误原样显示给用户。
pub fn fs_read_binary(access: &WorkspaceFsAccess, path: String) -> Result<Vec<u8>, String> {
    let path = access.resolve_existing(&path)?;
    let metadata = std::fs::metadata(&path).map_err(|error| format!("读取元数据失败: {error}"))?;
    if metadata.len() > MAX_BINARY_BYTES as u64 {
        return Err("文件超过 20MB 上限".into());
    }
    std::fs::read(&path).map_err(|error| format!("读取文件失败: {error}"))
}

/// 夹紧调用方给的媒体额度：`None` 走默认 20MB，上限永远由宿主说了算。
pub(super) fn media_limit(max_bytes: Option<u64>) -> u64 {
    max_bytes
        .unwrap_or(DEFAULT_MEDIA_BYTES as u64)
        .min(MAX_MEDIA_BYTES as u64)
}

/// 读媒体文件（视频 / 3D 模型 / GIS），**原始字节**回传，上限见 `MAX_MEDIA_BYTES`。
///
/// 与 `fs_read_binary` 分成两条命令而不是给它加参数：那条的 20MB 契约还有 `office.rs`
/// 与附件通道在依赖，而「能一次分配 128MB」这件事应该只有一个入口，评审时一眼可见。
/// 超限同样是**报错**而非截断 —— 半截的视频文件在播放器里表现为「格式损坏」，
/// 那比一句「文件超过 128MB 上限」难排查得多。
///
/// 第二步的流式（Range）落地后，这条命令会被整体替换掉。
pub fn fs_read_media(
    access: &WorkspaceFsAccess,
    path: String,
    max_bytes: Option<u64>,
) -> Result<Vec<u8>, String> {
    let path = access.resolve_existing(&path)?;
    let metadata = std::fs::metadata(&path).map_err(|error| format!("读取元数据失败: {error}"))?;
    let limit = media_limit(max_bytes);
    if metadata.len() > limit {
        return Err(format!("文件超过 {}MB 上限", limit / (1024 * 1024)));
    }
    std::fs::read(&path).map_err(|error| format!("读取文件失败: {error}"))
}

/// 探测的实现（与 `#[tauri::command]` 解耦，便于单测）。
pub(super) fn probe_file(access: &WorkspaceFsAccess, raw: &str) -> Result<FileProbe, String> {
    let path = access.resolve_existing(raw)?;
    let metadata = std::fs::metadata(&path).map_err(|error| format!("读取元数据失败: {error}"))?;
    let prefix = crate::text::read_prefix(&path, crate::text::PROBE_PREFIX_BYTES)
        .map_err(|error| format!("读取文件失败: {error}"))?;
    Ok(FileProbe {
        size: metadata.len(),
        binary: crate::text::looks_binary(&prefix),
        utf8: crate::text::is_utf8_prefix(&prefix),
        bom: crate::text::has_utf8_bom(&prefix),
        crlf: crate::text::uses_crlf(&prefix).unwrap_or(false),
    })
}

/// 探测文件能否按文本预览 / 编辑（只读前 8KB，不把大文件整个读进来）。
pub fn fs_probe_file(access: &WorkspaceFsAccess, path: String) -> Result<FileProbe, String> {
    probe_file(access, &path)
}

/// 目录列举的实现（与 `#[tauri::command]` 解耦，便于单测与基准）。
///
/// 逐项 `canonicalize` 是这里的历史开销大头：每个目录项一次全路径解析、一次读锁、
/// 两次字符串分配，万级目录会被放大成万次全路径解析。而父目录已经 `resolve_existing`
/// 过，普通子项必然仍在该已授权目录内，路径由父目录 `join` 即得（父目录已是 canonical
/// 形态，故 join 结果同样是 canonical 的）。只有链接 / 重解析点才回到 `resolve_existing`
/// 走越界校验。
pub(super) fn list_dir(access: &WorkspaceFsAccess, raw: &str) -> Result<Vec<DirEntryInfo>, String> {
    let dir = access.resolve_existing(raw)?;
    let mut out = Vec::new();
    let reader = std::fs::read_dir(&dir).map_err(|error| format!("打开目录失败: {error}"))?;
    for entry in reader {
        let entry = entry.map_err(|error| format!("读取目录项失败: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("读取目录项类型失败: {error}"))?;
        let resolved = if is_link_like(&entry, &file_type) {
            let entry_path = dir.join(entry.file_name());
            match access.resolve_existing(&entry_path.to_string_lossy()) {
                Ok(path) => path,
                // 与既有行为一致：越界（或断链）的链接项不出现在列表里。
                Err(_) => continue,
            }
        } else {
            dir.join(entry.file_name())
        };
        let metadata = std::fs::metadata(&resolved)
            .map_err(|error| format!("读取目录项元数据失败: {error}"))?;
        let kind = if metadata.is_dir() {
            "directory"
        } else {
            "file"
        };
        out.push(DirEntryInfo {
            name: entry.file_name().to_string_lossy().into_owned(),
            kind: kind.to_string(),
            size: metadata.is_file().then_some(metadata.len()),
            // 剥掉 `\\?\` 再回前端；前端原样回传时宿主会重新 canonicalize，
            // 与账本里的 verbatim 形态仍能对上。
            path: crate::path_safety::strip_verbatim_prefix(&resolved.to_string_lossy()),
        });
    }
    Ok(out)
}

pub fn fs_list_dir(access: &WorkspaceFsAccess, path: String) -> Result<Vec<DirEntryInfo>, String> {
    list_dir(access, &path)
}
