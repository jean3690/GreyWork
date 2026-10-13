//! 媒体流式读取：按 HTTP Range 切片段，供预览的 `<video>` / `<audio>` 直接当 src 用。
//!
//! **为什么需要这一层**：把整份文件读进内存再塞 blob URL 对视频是灾难 —— 全量传输 +
//! 主线程同步拷贝 + 媒体元素要把整个 blob 拉完才开播，拖动进度条基本废。媒体元素真正
//! 需要的是一条**支持 Range 的地址**，它自己会按需拉片段、按需 seek。
//!
//! 授权面与 `fs_read_media` 完全同源（`WorkspaceFsAccess::resolve_existing`），没有第二套
//! scope 需要保持同步。桌面壳的 `gwmedia://` 协议与服务端的 `/api/media` 都走这份实现
//! （前者只在 Range 数学之外复用 MIME 表，它的老代码在阶段 4 随 Tauri 一起删）。

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use http_range::HttpRange;

use super::{WorkspaceFsAccess, MAX_MEDIA_BYTES};

/// 单次响应最多吐多少字节。与 Tauri asset 协议同量级：一次给太多等于又把大文件拉进内存，
/// 给太少则首帧要等很多个来回。媒体元素会自己接着请求下一段。
pub const MAX_MEDIA_CHUNK: u64 = 1024 * 1024;

/// 扩展名 → MIME。**只覆盖媒体**：`Content-Type` 给错会让媒体元素选错解复用器，而
/// `application/octet-stream` 在媒体元素上不可靠。表与前端 `VideoViewer.vue` 的 `MIME`
/// 对齐 —— 改这里要同步改那处。
pub fn media_mime_of(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("mp4" | "m4v") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mov") => "video/quicktime",
        Some("mkv") => "video/x-matroska",
        Some("mp3") => "audio/mpeg",
        Some("m4a") => "audio/mp4",
        Some("wav") => "audio/wav",
        Some("ogg" | "oga") => "audio/ogg",
        Some("flac") => "audio/flac",
        _ => "application/octet-stream",
    }
}

/// 一次媒体读取的结果，与 HTTP 语义一一对应（调用方只管照着造响应）。
#[derive(Debug)]
pub enum MediaSlice {
    /// 200：无 `Range` 头，回整份。
    Full { bytes: Vec<u8>, mime: &'static str },
    /// 206：`Content-Range: bytes {start}-{end}/{total}`。
    Partial {
        bytes: Vec<u8>,
        mime: &'static str,
        start: u64,
        end: u64,
        total: u64,
    },
    /// 416：`Content-Range: bytes */{total}`。
    Unsatisfiable { total: u64 },
}

/// 读一段媒体。`range` 是请求的 `Range` 头原文（`None` = 不带 Range 的普通 GET）。
///
/// 单次的字节数**恒定有上界**（`MAX_MEDIA_CHUNK`），所以服务端内存不会被大文件吃掉。
/// 多段 range（`bytes=0-99,200-299`）只服务第一段 —— RFC 允许服务端忽略多余段，而拼
/// `multipart/byteranges` 的复杂度换不来任何实际收益（媒体元素发的都是单段）。
pub fn fs_media_slice(
    access: &WorkspaceFsAccess,
    path: &str,
    range: Option<&str>,
) -> Result<MediaSlice, String> {
    let path = access.resolve_existing(path)?;
    let mut file = File::open(&path).map_err(|error| format!("打开媒体文件失败: {error}"))?;
    let len = file
        .metadata()
        .map_err(|error| format!("无法读取文件元数据: {error}"))?
        .len();
    let mime = media_mime_of(&path);

    let Some(header) = range else {
        return full(file, len, mime);
    };
    let Ok(ranges) = HttpRange::parse(header, len) else {
        return Ok(MediaSlice::Unsatisfiable { total: len });
    };
    let Some(range) = ranges.first() else {
        return Ok(MediaSlice::Unsatisfiable { total: len });
    };
    let start = range.start;
    let end = (start + range.length - 1)
        .min(len.saturating_sub(1))
        .min(start + MAX_MEDIA_CHUNK - 1);
    let count = (end - start + 1) as usize;
    let mut bytes = vec![0u8; count];
    file.seek(SeekFrom::Start(start))
        .map_err(|error| format!("定位读取位置失败: {error}"))?;
    file.read_exact(&mut bytes)
        .map_err(|error| format!("读取媒体文件失败: {error}"))?;
    Ok(MediaSlice::Partial {
        bytes,
        mime,
        start,
        end,
        total: len,
    })
}

/// 不带 `Range` 的普通 GET：回整份，但**仍夹紧到 `MAX_MEDIA_BYTES`**。
///
/// 媒体元素一律带 `Range`（MP4 还会先用后缀 range 取尾部的 `moov`），所以这条只服务
/// 「直接在地址栏打开」这类边角场景 —— 边角场景同样不该把宿主内存吃穿。
fn full(mut file: File, len: u64, mime: &'static str) -> Result<MediaSlice, String> {
    if len > MAX_MEDIA_BYTES as u64 {
        return Err(format!("文件超过 {}MB 上限", MAX_MEDIA_BYTES / 1024 / 1024));
    }
    // 先按文件大小预分配。
    let mut bytes = Vec::with_capacity(len as usize);
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("读取媒体文件失败: {error}"))?;
    Ok(MediaSlice::Full { bytes, mime })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("系统时间早于 UNIX 纪元")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("greywork-media-{tag}-{nanos}"));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    fn access(root: &Path) -> WorkspaceFsAccess {
        WorkspaceFsAccess::new(root, root.parent().unwrap().join("gw-media-test.json"))
            .expect("创建授权状态")
    }

    /// 建一个 4 字节的 `a.mp4` 并返回 (access 根, 文件路径)。
    fn fixture() -> (std::path::PathBuf, std::path::PathBuf) {
        let root = temp_dir("root");
        let file = root.join("a.mp4");
        std::fs::write(&file, b"0123456789").expect("写媒体文件");
        (root, file)
    }

    #[test]
    fn covers_the_extensions_the_previewer_uses() {
        for (name, mime) in [
            ("a.mp4", "video/mp4"),
            ("a.M4V", "video/mp4"),
            ("a.webm", "video/webm"),
            ("a.mov", "video/quicktime"),
            ("a.mkv", "video/x-matroska"),
            ("a.mp3", "audio/mpeg"),
            ("a.m4a", "audio/mp4"),
            ("a.wav", "audio/wav"),
            ("a.oga", "audio/ogg"),
            ("a.flac", "audio/flac"),
            ("a.txt", "application/octet-stream"),
            ("noext", "application/octet-stream"),
        ] {
            assert_eq!(media_mime_of(Path::new(name)), mime, "{name}");
        }
    }

    #[test]
    fn range_returns_only_the_requested_window() {
        let (root, file) = fixture();
        let access = access(&root);
        let slice =
            fs_media_slice(&access, &file.to_string_lossy(), Some("bytes=2-5")).expect("切片");
        let MediaSlice::Partial {
            bytes,
            mime,
            start,
            end,
            total,
        } = slice
        else {
            panic!("应回 206 部分内容");
        };
        assert_eq!(bytes, b"2345");
        assert_eq!((start, end, total), (2, 5, 10));
        assert_eq!(mime, "video/mp4");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn chunk_is_capped_regardless_of_how_much_was_asked_for() {
        let root = temp_dir("cap");
        let file = root.join("big.mp4");
        std::fs::write(&file, vec![7u8; (MAX_MEDIA_CHUNK * 2) as usize]).expect("写大文件");
        let access = access(&root);
        let slice =
            fs_media_slice(&access, &file.to_string_lossy(), Some("bytes=0-")).expect("切片");
        let MediaSlice::Partial {
            bytes, end, total, ..
        } = slice
        else {
            panic!("应回 206 部分内容");
        };
        assert_eq!(bytes.len() as u64, MAX_MEDIA_CHUNK, "单次字节数必须有上界");
        assert_eq!(end, MAX_MEDIA_CHUNK - 1);
        assert_eq!(total, MAX_MEDIA_CHUNK * 2);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn suffix_range_serves_the_tail() {
        // MP4 会先用后缀 range 取尾部的 `moov`，这条不能漏。
        let (root, file) = fixture();
        let access = access(&root);
        let slice =
            fs_media_slice(&access, &file.to_string_lossy(), Some("bytes=-3")).expect("切片");
        let MediaSlice::Partial {
            bytes, start, end, ..
        } = slice
        else {
            panic!("应回 206 部分内容");
        };
        assert_eq!(bytes, b"789");
        assert_eq!((start, end), (7, 9));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn out_of_range_asks_for_416() {
        let (root, file) = fixture();
        let access = access(&root);
        let slice =
            fs_media_slice(&access, &file.to_string_lossy(), Some("bytes=100-200")).expect("切片");
        assert!(matches!(slice, MediaSlice::Unsatisfiable { total: 10 }));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn no_range_header_returns_the_whole_file() {
        let (root, file) = fixture();
        let access = access(&root);
        let slice = fs_media_slice(&access, &file.to_string_lossy(), None).expect("整份");
        let MediaSlice::Full { bytes, mime } = slice else {
            panic!("应回 200 整份");
        };
        assert_eq!(bytes, b"0123456789");
        assert_eq!(mime, "video/mp4");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn unauthorized_path_is_rejected_before_any_read() {
        let (root, _) = fixture();
        let outside = temp_dir("outside");
        let secret = outside.join("secret.mp4");
        std::fs::write(&secret, b"secret").expect("写外部文件");
        let access = access(&root);
        let error = fs_media_slice(&access, &secret.to_string_lossy(), Some("bytes=0-"))
            .expect_err("应拒绝");
        assert!(error.contains("未获用户授权"), "实际错误：{error}");
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }
}
