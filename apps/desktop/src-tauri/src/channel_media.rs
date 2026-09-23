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

/// 媒体类别（决定落盘 / 展示分支，也决定各通道走图片端点还是文件端点）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaKind {
    Image,
    File,
}

impl MediaKind {
    pub fn as_str(self) -> &'static str {
        match self {
            MediaKind::Image => "image",
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

/// 通道的媒体能力（协议层面的事实，与实现进度无关）。
///
/// 序列化成 `"both" | "imageOnly" | "inboundOnly" | "none"`，渲染端据此如实提示。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaCapability {
    Both,
    ImageOnly,
    InboundOnly,
    /// 出站完全不支持媒体。
    #[serde(rename = "none")]
    Unsupported,
}

/// 本版已接入媒体的通道（能力矩阵的遍历顺序，也是渲染端兜底矩阵的依据）。
pub const CHANNELS: [&str; 7] = [
    "wechat", "dingtalk", "feishu", "telegram", "qq", "discord", "wecom",
];

/// 通道的媒体能力。**协议事实的单一事实来源**：出站能不能发、能不能发文件都看这里，
/// 与「哪条通道的实现已经接入」无关 —— 后者由 `channel_send_media` 的分发决定。
pub fn capability_of(channel: &str) -> MediaCapability {
    match channel {
        // 双向收发图片与文件。
        "wechat" | "telegram" | "discord" | "feishu" | "qq" => MediaCapability::Both,
        // 被动回复只能把图片塞进 stream 的图文混排，没有文件出口。
        "wecom" => MediaCapability::ImageOnly,
        // sessionWebhook 只认 text/markdown/link/actionCard/feedCard，出站没有任何媒体通道。
        "dingtalk" => MediaCapability::InboundOnly,
        _ => MediaCapability::Unsupported,
    }
}

/// 该能力下这种媒体能不能出站。
pub fn capability_allows(cap: MediaCapability, kind: MediaKind) -> bool {
    match cap {
        MediaCapability::Both => true,
        MediaCapability::ImageOnly => kind == MediaKind::Image,
        MediaCapability::InboundOnly | MediaCapability::Unsupported => false,
    }
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

/// 定下 (展示名, mime, 落盘扩展名)：图片按魔数校正，文件沿用原扩展名。
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

/// 定媒体类别：显式参数优先，否则按魔数嗅探（认得出图片就当图片）。
pub fn resolve_media_kind(explicit: Option<&str>, bytes: &[u8]) -> MediaKind {
    match explicit.map(str::trim) {
        Some("image") => MediaKind::Image,
        Some("file") => MediaKind::File,
        _ => {
            if sniff_image(bytes).is_some() {
                MediaKind::Image
            } else {
                MediaKind::File
            }
        }
    }
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
/// 用 `resolve_media_kind(Some(kind), &media.bytes)` 覆盖。
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
    let kind = resolve_media_kind(None, &bytes);
    Ok(OutboundMedia { bytes, name, kind })
}

/// 能力不允许时的说明文案（宿主侧兜底；渲染端另有一份 i18n 提示）。
fn capability_error(channel: &str, cap: MediaCapability, kind: MediaKind) -> String {
    match (cap, kind) {
        (MediaCapability::ImageOnly, MediaKind::File) => {
            format!("{channel} 只能发送图片，无法发送文件")
        }
        (MediaCapability::InboundOnly, _) => format!("{channel} 只能接收文件，无法向外发送"),
        (MediaCapability::Unsupported, _) => format!("{channel} 不支持发送文件"),
        _ => format!("{channel} 不支持发送该类型文件"),
    }
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
        media.kind = resolve_media_kind(Some(explicit), &media.bytes);
    }
    if !capability_allows(cap, media.kind) {
        return Err(capability_error(&channel, cap, media.kind));
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
pub fn channel_media_capabilities() -> BTreeMap<String, MediaCapability> {
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
        assert_eq!(resolve_media_kind(Some("file"), &png), MediaKind::File);
        assert_eq!(
            resolve_media_kind(Some("image"), b"plain"),
            MediaKind::Image
        );
        assert_eq!(resolve_media_kind(None, &png), MediaKind::Image);
        assert_eq!(resolve_media_kind(None, b"plain"), MediaKind::File);
        assert_eq!(resolve_media_kind(Some("  "), b"plain"), MediaKind::File);
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
    fn capability_matrix_gates_kinds() {
        assert_eq!(capability_of("wechat"), MediaCapability::Both);
        assert_eq!(capability_of("telegram"), MediaCapability::Both);
        assert_eq!(capability_of("wecom"), MediaCapability::ImageOnly);
        assert_eq!(capability_of("dingtalk"), MediaCapability::InboundOnly);
        assert_eq!(capability_of("nope"), MediaCapability::Unsupported);

        assert!(capability_allows(MediaCapability::Both, MediaKind::Image));
        assert!(capability_allows(MediaCapability::Both, MediaKind::File));
        assert!(capability_allows(
            MediaCapability::ImageOnly,
            MediaKind::Image
        ));
        assert!(!capability_allows(
            MediaCapability::ImageOnly,
            MediaKind::File
        ));
        assert!(!capability_allows(
            MediaCapability::InboundOnly,
            MediaKind::Image
        ));
        assert!(!capability_allows(
            MediaCapability::Unsupported,
            MediaKind::File
        ));
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
