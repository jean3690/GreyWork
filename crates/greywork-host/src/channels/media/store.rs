//! 入站落盘 / 取走（inbox）。

use std::path::{Path, PathBuf};

use crate::channel_common::{channel_dir, write_private};
use crate::host::HostContext;
use crate::log;

use super::naming::{finalize_media, inbox_file_name};
use super::types::{MediaKind, MediaRefDto};
use super::{INBOX_STALE, INBOX_SUB_DIR, MAX_MEDIA_BYTES};

/// 入站媒体收件目录（不存在则创建）。
pub fn inbox_dir(host: &dyn HostContext, channel: &str) -> Result<PathBuf, String> {
    let dir = channel_dir(host, channel)?.join(INBOX_SUB_DIR);
    std::fs::create_dir_all(&dir).map_err(|error| format!("创建媒体收件目录失败: {error}"))?;
    Ok(dir)
}

/// 清理收件目录里的孤儿文件（渲染端崩溃 / 未取走）。
///
/// `all=false` 只删超过 `INBOX_STALE` 的；`all=true`（退出登录）整目录清空。
/// 全是 best-effort：清理失败不该影响连接 / 退出流程。
pub fn prune_inbox(host: &dyn HostContext, channel: &str, all: bool) {
    let Ok(dir) = inbox_dir(host, channel) else {
        return;
    };
    if all {
        let _ = std::fs::remove_dir_all(&dir);
        return;
    }
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > INBOX_STALE);
        if stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// 把已取到明文的媒体字节落进 inbox 并产出描述；落盘失败返回 None（调用方降级）。
///
/// inbox 显式传入（而非从 host 取）是为了让单测能用临时目录直测。
pub fn store_inbound_media(
    inbox: &Path,
    channel: &str,
    received_at: i64,
    index: usize,
    kind: MediaKind,
    name: &str,
    bytes: Vec<u8>,
) -> Option<MediaRefDto> {
    let (name, mime, ext) = finalize_media(kind, name, &bytes);
    let path = inbox.join(inbox_file_name(received_at, index, &ext));
    if let Err(error) = write_private(&path, &bytes) {
        log::warn(channel, format!("入站媒体落盘失败: {error}"));
        return None;
    }
    Some(MediaRefDto {
        kind: kind.as_str().into(),
        name,
        mime,
        size: bytes.len() as u64,
        path: path.to_string_lossy().into_owned(),
    })
}

/// 取走一条入站媒体：校验路径落在收件目录内 → 读原始字节 → 删除文件。
///
/// `canonicalize` 会把符号链接展开，因此 `starts_with` 这一句同时挡住了「用链接逃出
/// 收件目录」。「取走即删」让收件目录不会堆积：渲染端落进会话附件库后，收件副本就没有
/// 保留价值。删除失败不致命（下次 connect 的 `prune_inbox` 兜底）。
pub fn take_media_from_inbox(inbox: &Path, channel: &str, path: &str) -> Result<Vec<u8>, String> {
    let canonical =
        std::fs::canonicalize(path).map_err(|error| format!("媒体路径不可访问: {error}"))?;
    let canonical_inbox =
        std::fs::canonicalize(inbox).map_err(|error| format!("收件目录不可访问: {error}"))?;
    if !canonical.starts_with(&canonical_inbox) {
        return Err("媒体路径不在收件目录内".into());
    }
    let metadata =
        std::fs::metadata(&canonical).map_err(|error| format!("读取媒体元数据失败: {error}"))?;
    if !metadata.is_file() {
        return Err("媒体路径不是文件".into());
    }
    if metadata.len() > MAX_MEDIA_BYTES {
        return Err(format!("媒体超过 {MAX_MEDIA_BYTES} 字节上限"));
    }
    let bytes = std::fs::read(&canonical).map_err(|error| format!("读取媒体失败: {error}"))?;
    if let Err(error) = std::fs::remove_file(&canonical) {
        log::warn(channel, format!("删除收件媒体失败: {error}"));
    }
    Ok(bytes)
}

/// 取走一条入站媒体：校验路径落在该通道的收件目录内 → 读原始字节 → 删除文件。
///
/// 回原始字节而不是 base64 —— 与 `fs_read_binary` 同一取舍，免得 20MB 的文件被撑成
/// ~27MB 字符串。桌面壳再包一层 `tauri::ipc::Response`。
pub fn channel_take_media(
    host: &dyn HostContext,
    channel: String,
    path: String,
) -> Result<Vec<u8>, String> {
    let inbox = inbox_dir(host, &channel)?;
    take_media_from_inbox(&inbox, &channel, &path)
}
