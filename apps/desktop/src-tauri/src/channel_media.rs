//! 聊天通道共用的媒体层：入站落盘 / 取走、出站授权与读取、能力矩阵，以及三个通用命令。
//!
//! 七条通道（微信 / 钉钉 / 飞书 / Telegram / QQ / Discord / 企业微信）的媒体协议各不相同，
//! 但落到宿主侧的动作是同一批：把下载到的字节安全落进 `<应用数据>/<channel>/inbox`、
//! 让渲染端凭路径取走、把授权面内的本地文件读出来交给各通道上传。这些放在这里，
//! 通道模块只写自己的协议与上传端点。
//!
//! 与 `channel_common` 的分工：那边是「连媒体都不涉及」的基础设施（目录 / 事件 / 私有写），
//! 这边是需要 `WorkspaceFsAccess`、`serde` 与 `AppHandle` 的媒体关注点。
//!
//! 命令刻意做成「一对通用命令 + 按 channel 分发」，而不是七条通道各来一对：
//! take 的逻辑与通道无关（唯一变量是 inbox 目录名，而目录名就是 channel 名），
//! send 的差异只在「用哪套协议上传」这一处。分发靠 `AppHandle` 的 `Manager::state`，
//! 不需要把七个 host 都塞进命令签名。代价是 `channel` 成了字符串，失去「一命令一类型」
//! 的边界 —— 由 `capability_of` 的兜底与 `match` 的 `_` 分支补上。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::channel_common::{channel_dir, write_private};
use crate::log;
use crate::workspace_fs::WorkspaceFsAccess;

/* ===== 常量 ===== */

/// 入站媒体收件目录名（`<应用数据>/<channel>/inbox`）。
pub const INBOX_SUB_DIR: &str = "inbox";
/// 收件文件保留时长：渲染端崩溃 / 未取走的孤儿超过它就清理。
pub const INBOX_STALE: Duration = Duration::from_secs(24 * 60 * 60);
/// 单个媒体文件的明文上限（入站落盘与出站读取共用）。
pub const MAX_MEDIA_BYTES: u64 = 20 * 1024 * 1024;

/* ===== 类型 ===== */

/// 媒体类别（决定落盘 / 展示分支，也决定各通道走哪套端点）。
///
/// 序列化成 `"image" | "video" | "audio" | "file"`；`Audio` 是「语音 / 音频」的统一类别
/// （各通道的语音端点叫法不一：Telegram `voice`、QQ `silk`、飞书 `audio`、微信 `voice_item`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaKind {
    Image,
    Video,
    Audio,
    File,
}

impl MediaKind {
    pub fn as_str(self) -> &'static str {
        match self {
            MediaKind::Image => "image",
            MediaKind::Video => "video",
            MediaKind::Audio => "audio",
            MediaKind::File => "file",
        }
    }
}

/// 一条已落进 inbox 的入站媒体：字节在宿主侧，渲染端凭 `path` 取走。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaRefDto {
    /// "image" | "file"
    pub kind: String,
    pub name: String,
    pub mime: String,
    pub size: u64,
    /// inbox 里的绝对路径（`channel_take_media` 取走后由宿主删除）。
    pub path: String,
}

/// 出站媒体：授权面校验 + 读字节 + 判类之后的载荷。
pub struct OutboundMedia {
    pub bytes: Vec<u8>,
    /// 文件名（各通道上传时用；也是日志里的标识）。
    pub name: String,
    pub kind: MediaKind,
}

/// 通道的媒体能力：能收哪些类别、能**原生**发哪些类别。
///
/// `outbound` 只列原生端点支持的类别；发不了原生的类别由共享层的降级规则补上
/// （「这条通道能发文件，就把视频 / 语音当文件发」）。序列化成
/// `{ "inbound": [...], "outbound": [...] }`，渲染端据此如实提示。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelMediaCapability {
    pub inbound: Vec<MediaKind>,
    pub outbound: Vec<MediaKind>,
}

/// 构造能力（少写点 `to_vec`）。
fn caps(inbound: &[MediaKind], outbound: &[MediaKind]) -> ChannelMediaCapability {
    ChannelMediaCapability {
        inbound: inbound.to_vec(),
        outbound: outbound.to_vec(),
    }
}

/// 本版已接入媒体的通道（能力矩阵的遍历顺序，也是渲染端兜底矩阵的依据）。
pub const CHANNELS: [&str; 7] = [
    "wechat", "dingtalk", "feishu", "telegram", "qq", "discord", "wecom",
];

/// 通道的媒体能力。**协议事实的单一事实来源**：能收 / 能原生发哪些类别都看这里，
/// 与「哪条通道的实现已经接入」无关 —— 后者由 `channel_send_media` 的分发决定。
pub fn capability_of(channel: &str) -> ChannelMediaCapability {
    use MediaKind::{Audio, File, Image, Video};
    match channel {
        // 双向收发图片 / 视频 / 文件；SDK 没有语音发送端点，音频降级为文件。
        "wechat" => caps(&[Image, Video, Audio, File], &[Image, Video, File]),
        // 全类别原生双向。
        "telegram" | "discord" => caps(&[Image, Video, Audio, File], &[Image, Video, Audio, File]),
        // 出站 media 需封面 `image_key`、audio 需 opus，原生只到图片与文件（视频音频降级为文件）。
        "feishu" => caps(&[Image, Video, Audio, File], &[Image, File]),
        // 语音端点要 SILK 编码，原生只到图片与视频（音频降级为文件）。
        "qq" => caps(&[Image, Video, Audio, File], &[Image, Video, File]),
        // 被动回复只能把图片塞进 stream 的图文混排，没有文件出口；入站语音回调走 `media_id`，本轮未接。
        "wecom" => caps(&[Image, Video, File], &[Image]),
        // sessionWebhook 只认 text/markdown/link/actionCard/feedCard，出站没有任何媒体通道；
        // 入站图片 / 视频 / 语音 / 文件仅单聊可收（群聊常缺 downloadCode）。
        "dingtalk" => caps(&[Image, Video, Audio, File], &[]),
        _ => caps(&[], &[]),
    }
}

/// 该能力下这种媒体能不能出站：原生支持，或能降级为文件发。
///
/// 渲染端 `channelMediaAllows` 与宿主侧同一口径 —— 两端都只做「提前告知」与「拦截」，
/// 真正的降级改写发生在 `channel_send_media`。
pub fn capability_allows(cap: &ChannelMediaCapability, kind: MediaKind) -> bool {
    if cap.outbound.contains(&kind) {
        return true;
    }
    kind != MediaKind::File && cap.outbound.contains(&MediaKind::File)
}

/* ===== 纯函数：命名 / 嗅探 / 判类 ===== */

/// 按魔数嗅探图片：(mime, 扩展名)。认不出返回 None。
pub fn sniff_image(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Some(("image/png", "png"));
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some(("image/jpeg", "jpg"));
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some(("image/gif", "gif"));
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some(("image/webp", "webp"));
    }
    if bytes.starts_with(b"BM") {
        return Some(("image/bmp", "bmp"));
    }
    None
}

/// 按魔数嗅探视频容器：(mime, 扩展名)。认不出返回 None。
///
/// 只认容器，不校验编码 —— 目的仅是把「这是视频」判出来，具体编码交给对端播放器。
pub fn sniff_video(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    // ISO BMFF（mp4 / mov / m4v 同容器）：第 4-8 字节是 `ftyp`，其后 4 字节是品牌。
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        let brand = &bytes[8..12];
        // M4A 是纯音频品牌：不当作视频（交给 sniff_audio）。
        if brand.starts_with(b"M4A") {
            return None;
        }
        return Some(match brand {
            b"qt  " => ("video/quicktime", "mov"),
            _ => ("video/mp4", "mp4"),
        });
    }
    // EBML（webm / mkv 同容器）。
    if bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
        return Some(("video/webm", "webm"));
    }
    // AVI：RIFF 容器，类型标识 `AVI `。
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"AVI " {
        return Some(("video/x-msvideo", "avi"));
    }
    // MPEG program / sequence 起始码。
    if bytes.starts_with(&[0x00, 0x00, 0x01, 0xba]) || bytes.starts_with(&[0x00, 0x00, 0x01, 0xb3])
    {
        return Some(("video/mpeg", "mpg"));
    }
    None
}

/// 按魔数嗅探音频：(mime, 扩展名)。认不出返回 None。
pub fn sniff_audio(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    // m4a 与 mp4 同属 ISO BMFF，先按品牌挑出来（避免被 sniff_video 抢走）。
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" && bytes[8..12].starts_with(b"M4A") {
        return Some(("audio/mp4", "m4a"));
    }
    if bytes.starts_with(b"OggS") {
        return Some(("audio/ogg", "ogg"));
    }
    if bytes.starts_with(b"ID3")
        || bytes.starts_with(&[0xff, 0xfb])
        || bytes.starts_with(&[0xff, 0xf3])
        || bytes.starts_with(&[0xff, 0xf2])
    {
        return Some(("audio/mpeg", "mp3"));
    }
    // WAV：RIFF 容器，类型标识 `WAVE`。
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WAVE" {
        return Some(("audio/wav", "wav"));
    }
    if bytes.starts_with(b"fLaC") {
        return Some(("audio/flac", "flac"));
    }
    if bytes.starts_with(b"#!AMR") {
        return Some(("audio/amr", "amr"));
    }
    if bytes.starts_with(b"#!SILK") {
        return Some(("audio/silk", "silk"));
    }
    None
}

/// 给展示名补上扩展名；已有同一后缀（大小写不敏感）则不重复追加。
fn with_ext(display: &str, ext: &str) -> String {
    let suffix = format!(".{ext}");
    if display.to_ascii_lowercase().ends_with(&suffix) {
        display.to_string()
    } else {
        format!("{display}{suffix}")
    }
}

/// 文件名末段扩展名：小写、只保留字母数字、≤8 字符；不合格返回空串。
pub fn ext_of(name: &str) -> String {
    name.rsplit_once('.')
        .map(|(_, ext)| ext)
        .unwrap_or("")
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .take(8)
        .collect::<String>()
        .to_ascii_lowercase()
}

/// 展示名净化：去掉控制字符，路径分隔符换成下划线，限长。
///
/// 只用于界面展示与附件记录，**不参与落盘路径**（落盘名见 `inbox_file_name`）。
pub fn sanitize_display_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|ch| (*ch as u32) > 0x1f && (*ch as u32) != 0x7f)
        .map(|ch| match ch {
            '/' | '\\' | ':' => '_',
            other => other,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        return "attachment".to_string();
    }
    trimmed.chars().take(120).collect()
}

/// 定下 (展示名, mime, 落盘扩展名)：图片 / 视频 / 音频按魔数校正，文件沿用原扩展名。
pub fn finalize_media(kind: MediaKind, name: &str, bytes: &[u8]) -> (String, String, String) {
    let display = sanitize_display_name(name);
    match kind {
        MediaKind::Image => {
            let (mime, ext) = sniff_image(bytes).unwrap_or(("image/png", "png"));
            (
                format!("{display}.{ext}"),
                mime.to_string(),
                ext.to_string(),
            )
        }
        MediaKind::Video | MediaKind::Audio => {
            let sniffed = if kind == MediaKind::Video {
                sniff_video(bytes)
            } else {
                sniff_audio(bytes)
            };
            let (mime, ext) = match sniffed {
                Some((mime, ext)) => (mime.to_string(), ext.to_string()),
                // 嗅不出：退回原扩展名；仍没有就按类别的通用后缀兜底。
                None => {
                    let ext = ext_of(&display);
                    let ext = if ext.is_empty() {
                        if kind == MediaKind::Video {
                            "mp4"
                        } else {
                            "mp3"
                        }
                        .to_string()
                    } else {
                        ext
                    };
                    (format!("{}/{}", kind.as_str(), ext), ext)
                }
            };
            (with_ext(&display, &ext), mime, ext)
        }
        MediaKind::File => {
            // 文件 mime 交给渲染端按扩展名推断，宿主不猜。
            let ext = ext_of(&display);
            (display, String::new(), ext)
        }
    }
}

/// inbox 落盘文件名：`<收到时刻>-<序号>.<ext>`。
///
/// 刻意不用对端给的文件名 —— 那是不可信输入；落盘路径只由收到时刻、序号与白名单扩展名拼成。
pub fn inbox_file_name(received_at: i64, index: usize, ext: &str) -> String {
    let ext = if ext.is_empty() { "bin" } else { ext };
    format!("{received_at}-{index}.{ext}")
}

/// 显式类别字符串 → 类别；空 / 未知返回 None。`"voice"` 是 `"audio"` 的别名。
fn explicit_kind(explicit: Option<&str>) -> Option<MediaKind> {
    match explicit.map(str::trim) {
        Some("image") => Some(MediaKind::Image),
        Some("video") => Some(MediaKind::Video),
        Some("audio") | Some("voice") => Some(MediaKind::Audio),
        Some("file") => Some(MediaKind::File),
        _ => None,
    }
}

/// 按魔数嗅探类别：图片 → 音频 → 视频；都认不出返回 None。
fn sniff_kind(bytes: &[u8]) -> Option<MediaKind> {
    if sniff_image(bytes).is_some() {
        return Some(MediaKind::Image);
    }
    if sniff_audio(bytes).is_some() {
        return Some(MediaKind::Audio);
    }
    if sniff_video(bytes).is_some() {
        return Some(MediaKind::Video);
    }
    None
}

/// 按扩展名归类：图片 / 视频 / 音频；其余（含空串）返回 None。
fn kind_of_ext(ext: &str) -> Option<MediaKind> {
    const IMAGE: [&str; 6] = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];
    const VIDEO: [&str; 6] = ["mp4", "mov", "m4v", "webm", "mkv", "avi"];
    const AUDIO: [&str; 8] = ["mp3", "ogg", "opus", "m4a", "wav", "aac", "flac", "amr"];
    match ext {
        e if IMAGE.contains(&e) => Some(MediaKind::Image),
        e if VIDEO.contains(&e) => Some(MediaKind::Video),
        e if AUDIO.contains(&e) => Some(MediaKind::Audio),
        _ => None,
    }
}

/// 定媒体类别（出站用）：显式参数优先，其次按文件名扩展名，最后按魔数嗅探。
///
/// 出站一定知道文件名，而扩展名比魔数更贴近用户意图（`.mp3` 即便头不可嗅也当音频），
/// 也能避免把 m4a 这类 ISO BMFF 容器误判成视频。`name` 传空串即退化为纯魔数嗅探。
pub fn resolve_media_kind_named(explicit: Option<&str>, name: &str, bytes: &[u8]) -> MediaKind {
    if let Some(kind) = explicit_kind(explicit) {
        return kind;
    }
    if let Some(kind) = kind_of_ext(&ext_of(name)) {
        return kind;
    }
    sniff_kind(bytes).unwrap_or(MediaKind::File)
}

/* ===== 目录 / 落盘 / 取走 ===== */

/// 入站媒体收件目录（不存在则创建）。
pub fn inbox_dir(app: &AppHandle, channel: &str) -> Result<PathBuf, String> {
    let dir = channel_dir(app, channel)?.join(INBOX_SUB_DIR);
    std::fs::create_dir_all(&dir).map_err(|error| format!("创建媒体收件目录失败: {error}"))?;
    Ok(dir)
}

/// 清理收件目录里的孤儿文件（渲染端崩溃 / 未取走）。
///
/// `all=false` 只删超过 `INBOX_STALE` 的；`all=true`（退出登录）整目录清空。
/// 全是 best-effort：清理失败不该影响连接 / 退出流程。
pub fn prune_inbox(app: &AppHandle, channel: &str, all: bool) {
    let Ok(dir) = inbox_dir(app, channel) else {
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
/// inbox 显式传入（而非从 app 取）是为了让单测能用临时目录直测。
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

/* ===== 出站：授权面校验 + 读取 ===== */

/// 读一条要发出去的本地文件：先过授权面，再卡大小，最后读字节并判类。
///
/// `path` 必须落在已授权路径内（与 `fs_read_binary` 同一授权面）：渲染端选过的文件、
/// `~/.greyWork` 下的附件都在其中，不新开授权面。显式 kind 由调用方在拿到 `bytes` 后
/// 用 `resolve_media_kind_named(Some(kind), &media.name, &media.bytes)` 覆盖。
pub fn load_outbound_media(
    access: &WorkspaceFsAccess,
    path: &str,
) -> Result<OutboundMedia, String> {
    let real = access.resolve_existing(path)?;
    let metadata =
        std::fs::metadata(&real).map_err(|error| format!("读取文件元数据失败: {error}"))?;
    if !metadata.is_file() {
        return Err("只能发送文件".into());
    }
    if metadata.len() > MAX_MEDIA_BYTES {
        return Err(format!(
            "文件超过 {} MB 上限",
            MAX_MEDIA_BYTES / (1024 * 1024)
        ));
    }
    let bytes = std::fs::read(&real).map_err(|error| format!("读取文件失败: {error}"))?;
    let name = real
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "attachment".into());
    let kind = resolve_media_kind_named(None, &name, &bytes);
    Ok(OutboundMedia { bytes, name, kind })
}

/// 类别的中文名（错误文案用）。
fn kind_label(kind: MediaKind) -> &'static str {
    match kind {
        MediaKind::Image => "图片",
        MediaKind::Video => "视频",
        MediaKind::Audio => "语音",
        MediaKind::File => "文件",
    }
}

/// 能力不允许时的说明文案（宿主侧兜底；渲染端另有一份 i18n 提示）。
fn capability_error(channel: &str, cap: &ChannelMediaCapability, kind: MediaKind) -> String {
    if cap.outbound.is_empty() {
        return if cap.inbound.is_empty() {
            format!("{channel} 不支持发送文件")
        } else {
            format!("{channel} 只能接收消息，无法向外发送")
        };
    }
    format!("{channel} 不支持发送{}", kind_label(kind))
}

/* ===== 通用命令 ===== */

/// 取走一条入站媒体：校验路径落在该通道的收件目录内 → 读原始字节 → 删除文件。
///
/// 回原始字节（`tauri::ipc::Response`）而不是 base64 —— 与 `fs_read_binary` 同一取舍，
/// 免得 20MB 的文件被撑成 ~27MB 字符串。
#[tauri::command]
pub fn channel_take_media(
    app: AppHandle,
    channel: String,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let inbox = inbox_dir(&app, &channel)?;
    let bytes = take_media_from_inbox(&inbox, &channel, &path)?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 发一条媒体：过授权面 → 卡能力 → 交给该通道的上传实现。
///
/// 能力检查放在这里而不是各通道里：钉钉（无出站媒体）、企业微信（只能发图片）这类
/// 协议约束在唯一一处拦截，渲染端只是「提前告知」，不是唯一防线。
#[tauri::command]
pub async fn channel_send_media(
    app: AppHandle,
    access: State<'_, WorkspaceFsAccess>,
    channel: String,
    peer_id: String,
    path: String,
    kind: Option<String>,
    context_token: Option<String>,
) -> Result<(), String> {
    let cap = capability_of(&channel);
    let mut media = load_outbound_media(&access, &path)?;
    if let Some(explicit) = kind.as_deref() {
        media.kind = resolve_media_kind_named(Some(explicit), &media.name, &media.bytes);
    }
    if !capability_allows(&cap, media.kind) {
        return Err(capability_error(&channel, &cap, media.kind));
    }
    // 原生端点做不到、但这条通道能发文件：降级为文件发。集中在这一处，各通道的
    // `match media.kind` 就只会见到自己原生支持的类别。
    if !cap.outbound.contains(&media.kind) {
        log::info(
            &channel,
            format!(
                "{channel} 无原生{}端点，降级为文件发送: {}",
                kind_label(media.kind),
                media.name
            ),
        );
        media.kind = MediaKind::File;
    }
    match channel.as_str() {
        "wechat" => {
            crate::wechat::send_media_impl(&app, &peer_id, context_token.as_deref(), media).await
        }
        "telegram" => crate::telegram::send_media_impl(&app, &peer_id, media).await,
        "discord" => crate::discord::send_media_impl(&app, &peer_id, media).await,
        "feishu" => crate::feishu::send_media_impl(&app, &peer_id, media).await,
        "qq" => crate::qq::send_media_impl(&app, &peer_id, media).await,
        "wecom" => crate::wecom::send_media_impl(&app, &peer_id, media).await,
        other => Err(format!("未知通道: {other}")),
    }
}

/// 各通道的媒体能力矩阵；渲染端启动时拉一次，据此提示「这条通道能发什么」。
#[tauri::command]
pub fn channel_media_capabilities() -> BTreeMap<String, ChannelMediaCapability> {
    CHANNELS
        .iter()
        .map(|channel| ((*channel).to_string(), capability_of(channel)))
        .collect()
}

/* ===== 单测 ===== */

#[cfg(test)]
mod tests {
    use super::*;

    /// 建一个进程内唯一的临时目录（沿用既有测试的写法，不引 tempfile）。
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gw-media-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    #[test]
    fn sniff_image_detects_common_formats() {
        assert_eq!(
            sniff_image(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]),
            Some(("image/png", "png"))
        );
        assert_eq!(
            sniff_image(&[0xff, 0xd8, 0xff, 0xe0]),
            Some(("image/jpeg", "jpg"))
        );
        assert_eq!(sniff_image(b"GIF89a..."), Some(("image/gif", "gif")));
        assert_eq!(sniff_image(b"not an image"), None);
    }

    #[test]
    fn resolve_media_kind_prefers_explicit_then_sniffs() {
        let png = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        // 空文件名 → 走魔数嗅探分支。
        assert_eq!(
            resolve_media_kind_named(Some("file"), "", &png),
            MediaKind::File
        );
        assert_eq!(
            resolve_media_kind_named(Some("image"), "", b"plain"),
            MediaKind::Image
        );
        assert_eq!(resolve_media_kind_named(None, "", &png), MediaKind::Image);
        assert_eq!(
            resolve_media_kind_named(None, "", b"plain"),
            MediaKind::File
        );
        assert_eq!(
            resolve_media_kind_named(Some("  "), "", b"plain"),
            MediaKind::File
        );
    }

    #[test]
    fn finalize_media_corrects_image_extension() {
        // 对端说它是图片，但魔数说不是：落盘按嗅探结果兜底（png），展示名带上正确后缀。
        let (name, mime, ext) = finalize_media(MediaKind::Image, "weird-name", b"nope");
        assert_eq!(
            (name.as_str(), mime.as_str(), ext.as_str()),
            ("weird-name.png", "image/png", "png")
        );

        let (name, mime, ext) = finalize_media(MediaKind::File, "报表.xlsx", b"zip");
        assert_eq!(
            (name.as_str(), mime.as_str(), ext.as_str()),
            ("报表.xlsx", "", "xlsx")
        );
    }

    #[test]
    fn sanitize_display_name_strips_paths_and_controls() {
        assert_eq!(sanitize_display_name("../../etc/passwd"), "_.._etc_passwd");
        assert_eq!(sanitize_display_name("a\u{0}b\u{7f}c"), "abc");
        assert_eq!(sanitize_display_name("   "), "attachment");
        assert_eq!(sanitize_display_name("..."), "attachment");
    }

    #[test]
    fn inbox_file_name_is_path_safe() {
        assert_eq!(
            inbox_file_name(1_700_000_000_000, 0, "png"),
            "1700000000000-0.png"
        );
        assert_eq!(inbox_file_name(1, 2, ""), "1-2.bin");
    }

    #[test]
    fn store_inbound_media_writes_file_and_describes() {
        let dir = scratch("store");
        let png = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];
        let dto = store_inbound_media(&dir, "test", 42, 0, MediaKind::Image, "pic", png.to_vec())
            .expect("落盘成功");
        assert_eq!(dto.kind, "image");
        assert_eq!(dto.name, "pic.png");
        assert_eq!(dto.mime, "image/png");
        assert_eq!(dto.size, png.len() as u64);
        assert_eq!(std::fs::read(&dto.path).expect("读回"), png);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn take_media_from_inbox_reads_then_deletes() {
        let inbox = scratch("take");
        let file = inbox.join("1-0.png");
        std::fs::write(&file, b"bytes").expect("写收件文件");

        let bytes = take_media_from_inbox(&inbox, "test", &file.to_string_lossy()).expect("取走");
        assert_eq!(bytes, b"bytes");
        assert!(!file.exists(), "取走即删");
        let _ = std::fs::remove_dir_all(&inbox);
    }

    #[test]
    fn take_media_from_inbox_rejects_outside_and_symlink_escape() {
        let inbox = scratch("take-guard");
        let outside = scratch("take-outside");
        let outside_file = outside.join("secret.txt");
        std::fs::write(&outside_file, b"secret").expect("写外部文件");

        // 收件目录之外的真实路径：拒绝。
        assert!(take_media_from_inbox(&inbox, "test", &outside_file.to_string_lossy()).is_err());

        // 收件目录内的符号链接指向外部：canonicalize 展开后仍拒绝。
        #[cfg(unix)]
        {
            let link = inbox.join("link.txt");
            std::os::unix::fs::symlink(&outside_file, &link).expect("建符号链接");
            assert!(
                take_media_from_inbox(&inbox, "test", &link.to_string_lossy()).is_err(),
                "符号链接不得逃出收件目录"
            );
        }

        let _ = std::fs::remove_dir_all(&inbox);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn load_outbound_media_enforces_authorized_root_and_size() {
        let root = scratch("outbound-root");
        let inside = root.join("ok.txt");
        std::fs::write(&inside, b"hello").expect("写文件");
        let access = WorkspaceFsAccess::new(&root, root.join("ledger.json")).expect("构造授权面");

        let media = load_outbound_media(&access, &inside.to_string_lossy()).expect("授权面内可读");
        assert_eq!(media.bytes, b"hello");
        assert_eq!(media.name, "ok.txt");
        assert_eq!(media.kind, MediaKind::File);

        // 授权面之外：拒绝。
        let outside = scratch("outbound-outside");
        let secret = outside.join("secret.txt");
        std::fs::write(&secret, b"nope").expect("写外部文件");
        assert!(load_outbound_media(&access, &secret.to_string_lossy()).is_err());

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn capability_matrix_declares_native_kinds_with_file_fallback() {
        use MediaKind::{Audio, File, Image, Video};

        // 微信：入站可收语音，出站有视频但无原生语音 → 语音降级为文件。
        let wechat = capability_of("wechat");
        assert!(wechat.inbound.contains(&Audio), "微信入站可收语音");
        assert!(wechat.outbound.contains(&Video), "微信出站可发视频");
        assert!(!wechat.outbound.contains(&Audio), "微信无原生语音端点");
        assert!(capability_allows(&wechat, Audio), "能发文件即允许降级");
        assert!(capability_allows(&wechat, Image));
        assert!(capability_allows(&wechat, File));

        // 飞书：原生只到图片与文件 → 视频 / 语音降级为文件。
        let feishu = capability_of("feishu");
        assert!(
            !feishu.outbound.contains(&Video),
            "飞书原生不出视频（需封面）"
        );
        assert!(capability_allows(&feishu, Video));
        assert!(capability_allows(&feishu, Audio));

        // QQ：原生有视频，语音要 SILK → 音频降级为文件。
        let qq = capability_of("qq");
        assert!(qq.outbound.contains(&Video));
        assert!(!qq.outbound.contains(&Audio), "QQ 语音要 SILK，原生不发");
        assert!(capability_allows(&qq, Audio));

        // 企业微信：原生只发图片，且没有文件出口 → 其余一律拒绝。
        let wecom = capability_of("wecom");
        assert!(capability_allows(&wecom, Image));
        assert!(!capability_allows(&wecom, File));
        assert!(!capability_allows(&wecom, Video));
        assert!(!capability_allows(&wecom, Audio));

        // 钉钉：出站全无。
        let dingtalk = capability_of("dingtalk");
        assert!(dingtalk.outbound.is_empty());
        for kind in [Image, Video, Audio, File] {
            assert!(!capability_allows(&dingtalk, kind));
        }

        // 未知通道：既不收也不发。
        let unknown = capability_of("nope");
        assert!(unknown.inbound.is_empty() && unknown.outbound.is_empty());
        assert!(!capability_allows(&unknown, File));
    }

    #[test]
    fn sniff_video_and_audio_detect_containers() {
        let mut mp4 = vec![0, 0, 0, 0x18];
        mp4.extend_from_slice(b"ftypisom");
        assert_eq!(sniff_video(&mp4), Some(("video/mp4", "mp4")));

        let mut mov = vec![0, 0, 0, 0x14];
        mov.extend_from_slice(b"ftypqt  ");
        assert_eq!(sniff_video(&mov), Some(("video/quicktime", "mov")));

        assert_eq!(
            sniff_video(&[0x1a, 0x45, 0xdf, 0xa3, 0x01]),
            Some(("video/webm", "webm"))
        );

        assert_eq!(sniff_audio(b"OggS...."), Some(("audio/ogg", "ogg")));
        assert_eq!(sniff_audio(b"ID3\x04...."), Some(("audio/mpeg", "mp3")));
        assert_eq!(sniff_audio(b"fLaC...."), Some(("audio/flac", "flac")));
        assert_eq!(sniff_audio(b"#!AMR...."), Some(("audio/amr", "amr")));
        assert_eq!(sniff_audio(b"#!SILK...."), Some(("audio/silk", "silk")));

        // m4a 同属 ISO BMFF，但按音频收，不被视频抢走。
        let mut m4a = vec![0, 0, 0, 0x20];
        m4a.extend_from_slice(b"ftypM4A ");
        assert_eq!(sniff_audio(&m4a), Some(("audio/mp4", "m4a")));
        assert_eq!(sniff_video(&m4a), None, "M4A 不算视频");
    }

    #[test]
    fn resolve_media_kind_named_prefers_explicit_then_extension_then_sniff() {
        assert_eq!(
            resolve_media_kind_named(Some("audio"), "clip.mp4", b""),
            MediaKind::Audio
        );
        // 扩展名优先于嗅探：头不可嗅的 mp3 仍按音频。
        assert_eq!(
            resolve_media_kind_named(None, "song.mp3", b"plain"),
            MediaKind::Audio
        );
        assert_eq!(
            resolve_media_kind_named(None, "movie.mkv", b"plain"),
            MediaKind::Video
        );
        // 扩展名认不出时才嗅探。
        let mut mp4 = vec![0, 0, 0, 0x18];
        mp4.extend_from_slice(b"ftypisom");
        assert_eq!(
            resolve_media_kind_named(None, "noext", &mp4),
            MediaKind::Video
        );
        // 都认不出 → 文件。
        assert_eq!(
            resolve_media_kind_named(None, "notes.txt", b"plain"),
            MediaKind::File
        );
        // `voice` 是 `audio` 的别名。
        assert_eq!(
            resolve_media_kind_named(Some("voice"), "", b""),
            MediaKind::Audio
        );
    }

    #[test]
    fn finalize_media_fills_video_and_audio_extension() {
        let mut mp4 = vec![0, 0, 0, 0x18];
        mp4.extend_from_slice(b"ftypisom");
        let (name, mime, ext) = finalize_media(MediaKind::Video, "video-0", &mp4);
        assert_eq!(
            (name.as_str(), mime.as_str(), ext.as_str()),
            ("video-0.mp4", "video/mp4", "mp4")
        );

        let (name, mime, ext) = finalize_media(MediaKind::Audio, "voice-1", b"OggS....");
        assert_eq!(
            (name.as_str(), mime.as_str(), ext.as_str()),
            ("voice-1.ogg", "audio/ogg", "ogg")
        );

        // 嗅不出时退回原扩展名，且不重复追加。
        let (name, _mime, ext) = finalize_media(MediaKind::Audio, "rec.mp3", b"plain");
        assert_eq!((name.as_str(), ext.as_str()), ("rec.mp3", "mp3"));
    }

    #[test]
    fn capabilities_command_covers_every_channel() {
        let map = channel_media_capabilities();
        for channel in CHANNELS {
            assert!(map.contains_key(channel), "矩阵缺少通道 {channel}");
        }
        assert_eq!(map.len(), CHANNELS.len());
    }
}
