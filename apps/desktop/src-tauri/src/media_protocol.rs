//! 媒体流式协议（`gwmedia://`）：把工作区里的视频 / 音频直接交给 WebKit 的媒体后端按
//! HTTP Range 拉取，而不是先整份读进内存再塞 blob URL。
//!
//! **为什么必须有这一层**：`<video src="blob:...">` 要求宿主先把整个文件读进来 ——
//! IPC 全量传输 + 主线程 `new Blob` 同步拷贝 + WebKit 把整个 blob 拉完才开始播，
//! 拖动进度条基本废。128MB 的视频光前两步就是几秒的界面卡死，实测表现是
//! 「一直转圈、不出画面、也没有任何报错」。媒体元素真正需要的是一个**支持 Range 的
//! 地址**，它自己会按需拉片段、按需 seek。
//!
//! **授权面与 `fs_read_media` 完全同源**（`WorkspaceFsAccess::resolve_existing`），
//! 没有第二套 scope 需要保持同步 —— 这也是不用 Tauri 自带 asset 协议的原因：
//! 那会引入一份与授权账本并行的 allow-list，漏加一处就是「视频静默打不开」。
//!
//! 地址形态由 `@tauri-apps/api` 的 `convertFileSrc(path, "gwmedia")` 生成（见
//! `packages/host-ipc/src/media.ts`）：
//! - Linux / macOS → `gwmedia://localhost/<encodeURIComponent(绝对路径)>`
//! - Windows / Android → `http://gwmedia.localhost/<encodeURIComponent(绝对路径)>`
//!
//! 两条形态都要在 `tauri.conf.json` 的 `media-src` 里放行，改这里就得同步改那里
//! （`drift_tests::desktop_csp_declares_media_sources` 会拦）。

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use http_range::HttpRange;
// `http` 不单独声明依赖：Tauri 把它原样再导出（`tauri::http`），
// 两边用同一个类型才不会出现「版本对了但类型对不上」。
use tauri::http::header::{ACCEPT_RANGES, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, RANGE};
use tauri::http::{Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime};

use crate::workspace_fs::WorkspaceFsAccess;

/// 自定义协议名。改这里必须同步改 `packages/host-ipc/src/media.ts` 与 `tauri.conf.json`。
pub const SCHEME: &str = "gwmedia";

/// 单次响应最多吐多少字节。与 Tauri asset 协议同量级：一次给太多等于又把大文件拉进内存，
/// 给太少则首帧要等很多个来回。媒体元素会自己接着请求下一段。
const MAX_CHUNK: u64 = 1024 * 1024;

/// 协议处理器，交给 `Builder::register_asynchronous_uri_scheme_protocol`。
///
/// 用异步变体 + `spawn_blocking` 而不是同步变体：同步变体的回调跑在 WebKit 的主线程上，
/// 每次 1MB 的读盘都会卡一下界面。
pub fn handle<R: Runtime>(
    ctx: tauri::UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        responder.respond(respond(&app, &request));
    });
}

fn respond<R: Runtime>(app: &AppHandle<R>, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let Some(access) = app.try_state::<WorkspaceFsAccess>() else {
        return plain(StatusCode::INTERNAL_SERVER_ERROR, "工作区访问未初始化");
    };
    let Some(decoded) = decode_path(request.uri().path()) else {
        return plain(StatusCode::BAD_REQUEST, "路径无法解码");
    };
    // 授权判据与 fs_read_media 同源。未授权一律 403，不区分「不存在」——
    // 否则这个协议就成了一个能探测任意路径是否存在的接口。
    let Ok(path) = access.resolve_existing(&decoded) else {
        return plain(StatusCode::FORBIDDEN, "路径未获用户授权");
    };
    let Ok(file) = File::open(&path) else {
        return plain(StatusCode::NOT_FOUND, "文件不存在");
    };
    let Ok(len) = file.metadata().map(|meta| meta.len()) else {
        return plain(StatusCode::INTERNAL_SERVER_ERROR, "无法读取文件元数据");
    };
    let mime = mime_of(&path);
    match request
        .headers()
        .get(RANGE)
        .and_then(|value| value.to_str().ok())
    {
        Some(range) => partial(file, len, range, mime),
        // 媒体元素一律带 Range 来取；这条只服务「直接点开协议地址」这类边角场景。
        None => full(file, len, mime),
    }
}

/// `convertFileSrc` 把整条绝对路径 `encodeURIComponent` 后拼在 host 之后，
/// 所以这里先剥掉开头那个 `/` 再百分号解码。
fn decode_path(raw: &str) -> Option<String> {
    let encoded = raw.strip_prefix('/')?;
    let bytes = percent_encoding::percent_decode_str(encoded).collect::<Vec<u8>>();
    String::from_utf8(bytes).ok()
}

/// 扩展名 → MIME。**只覆盖媒体**：`Content-Type` 给错会让 WebKit 选错解复用器，
/// 而 `application/octet-stream` 在媒体元素上不可靠。表与前端 `VideoViewer.vue` 的
/// `MIME` 对齐。
fn mime_of(path: &Path) -> &'static str {
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

/// 带 `Range` 的请求：回 206 与请求区间的**前一段**（上限 `MAX_CHUNK`）。
///
/// 一次只给一段是刻意的：媒体元素会接着请求下一段，而服务端内存恒定在 1MB 以内。
/// 多段 range（`bytes=0-99,200-299`）只服务第一段 —— RFC 允许服务端忽略多余段，
/// 而拼 `multipart/byteranges` 的复杂度换不来任何实际收益（媒体元素发的都是单段）。
fn partial(mut file: File, len: u64, header: &str, mime: &str) -> Response<Vec<u8>> {
    let Ok(ranges) = HttpRange::parse(header, len) else {
        return range_not_satisfiable(len);
    };
    let Some(range) = ranges.first() else {
        return range_not_satisfiable(len);
    };
    let start = range.start;
    let end = (start + range.length - 1)
        .min(len.saturating_sub(1))
        .min(start + MAX_CHUNK - 1);
    let count = (end - start + 1) as usize;
    let mut buf = vec![0u8; count];
    if file.seek(SeekFrom::Start(start)).is_err() || file.read_exact(&mut buf).is_err() {
        return plain(StatusCode::INTERNAL_SERVER_ERROR, "读取文件失败");
    }
    Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header(CONTENT_TYPE, mime)
        .header(ACCEPT_RANGES, "bytes")
        .header(CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
        .header(CONTENT_LENGTH, count)
        .body(buf)
        .unwrap_or_else(|_| plain(StatusCode::INTERNAL_SERVER_ERROR, "构造响应失败"))
}

/// 不带 `Range` 的普通 GET：回整份文件。
///
/// 这里会把整个文件读进内存 —— 媒体元素不会走到这条（它们一律带 `Range`，MP4 还会先用
/// 后缀 range 取尾部的 `moov`），所以它只可能被手工请求命中。真要收紧的话，这里该改成
/// 返回 416 或 206 首段，但那会让「浏览器直接打开协议地址」这种行为变得莫名其妙。
fn full(mut file: File, len: u64, mime: &str) -> Response<Vec<u8>> {
    // 先按文件大小预分配，但给一个上限，免得一个畸形路径直接申请 GB 级内存。
    let mut buf = Vec::with_capacity(len.min(MAX_CHUNK * 8) as usize);
    if file.read_to_end(&mut buf).is_err() {
        return plain(StatusCode::INTERNAL_SERVER_ERROR, "读取文件失败");
    }
    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, mime)
        .header(ACCEPT_RANGES, "bytes")
        .header(CONTENT_LENGTH, buf.len())
        .body(buf)
        .unwrap_or_else(|_| plain(StatusCode::INTERNAL_SERVER_ERROR, "构造响应失败"))
}

fn range_not_satisfiable(len: u64) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::RANGE_NOT_SATISFIABLE)
        .header(CONTENT_RANGE, format!("bytes */{len}"))
        .body(Vec::new())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn plain(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(message.as_bytes().to_vec())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("gw-media-proto-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn decode_path_undoes_encode_uri_component() {
        // `convertFileSrc` 用 encodeURIComponent，`/` 也编成 %2F。
        assert_eq!(
            decode_path("/%2Fhome%2Fme%2Fmy-file%20(1).mp4").as_deref(),
            Some("/home/me/my-file (1).mp4")
        );
        // 缺开头斜杠（不该发生）宁可拒绝，也不猜。
        assert_eq!(decode_path("%2Fetc%2Fpasswd"), None);
        // 非法 UTF-8 字节拒绝。
        assert_eq!(decode_path("/%FF%FE"), None);
    }

    #[test]
    fn mime_only_covers_media_and_is_case_insensitive() {
        assert_eq!(mime_of(Path::new("/a/clip.mp4")), "video/mp4");
        assert_eq!(mime_of(Path::new("/a/CLIP.MP4")), "video/mp4");
        assert_eq!(mime_of(Path::new("/a/clip.MKV")), "video/x-matroska");
        // 非媒体不给猜测的 MIME：给错会让 WebKit 选错解复用器。
        assert_eq!(
            mime_of(Path::new("/a/notes.md")),
            "application/octet-stream"
        );
        assert_eq!(mime_of(Path::new("/a/noext")), "application/octet-stream");
    }

    #[test]
    fn range_response_returns_only_the_requested_slice() {
        let path = temp_file("clip.mp4", b"0123456789");
        let file = File::open(&path).unwrap();
        let response = partial(file, 10, "bytes=2-5", "video/mp4");

        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[CONTENT_RANGE], "bytes 2-5/10");
        assert_eq!(response.headers()[CONTENT_LENGTH], "4");
        assert_eq!(response.headers()[ACCEPT_RANGES], "bytes");
        assert_eq!(response.body().as_slice(), b"2345");
    }

    #[test]
    fn open_ended_range_is_clamped_to_the_chunk_ceiling() {
        let dir = std::env::temp_dir().join(format!("gw-media-chunk-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("big.mp4");
        // 比 MAX_CHUNK 大 1 字节，用来验证「一次只给一段」。
        std::fs::write(&path, vec![0u8; (MAX_CHUNK + 1) as usize]).unwrap();
        let len = MAX_CHUNK + 1;
        let file = File::open(&path).unwrap();

        let response = partial(file, len, "bytes=0-", "video/mp4");
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        // 尾部对齐到 MAX_CHUNK-1，而不是把整个文件吐出来。
        assert_eq!(
            response.headers()[CONTENT_RANGE],
            format!("bytes 0-{}/{len}", MAX_CHUNK - 1)
        );
        assert_eq!(response.body().len() as u64, MAX_CHUNK);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn suffix_range_reads_the_tail() {
        // MP4 的 moov 常在文件尾，播放器会先用后缀 range 去取它。
        let path = temp_file("tail.mp4", b"0123456789");
        let file = File::open(&path).unwrap();
        let response = partial(file, 10, "bytes=-3", "video/mp4");

        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[CONTENT_RANGE], "bytes 7-9/10");
        assert_eq!(response.body().as_slice(), b"789");
    }

    #[test]
    fn unsatisfiable_range_reports_416_with_total_length() {
        let path = temp_file("short.mp4", b"0123456789");
        let file = File::open(&path).unwrap();
        let response = partial(file, 10, "bytes=50-60", "video/mp4");

        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(response.headers()[CONTENT_RANGE], "bytes */10");

        // 畸形头同样落到 416，而不是 panic 或回 200。
        let file = File::open(&path).unwrap();
        assert_eq!(
            partial(file, 10, "not-a-range", "video/mp4").status(),
            StatusCode::RANGE_NOT_SATISFIABLE
        );
    }
}
