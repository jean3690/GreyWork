use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use crate::host::HostContext;
use crate::workspace_fs::WorkspaceFsAccess;

use super::capability::{capability_allows, capability_of, effective_kind, CHANNELS};
use super::dispatch::channel_media_capabilities;
use super::host::{ChannelHost, ChannelRegistry};
use super::naming::{
    finalize_media, inbox_file_name, resolve_media_kind_named, sanitize_display_name, sniff_audio,
    sniff_image, sniff_video,
};
use super::outbound::load_outbound_media;
use super::store::{store_inbound_media, take_media_from_inbox};
use super::types::{MediaKind, OutboundMedia};

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
fn effective_kind_degrades_to_file_or_rejects() {
    use MediaKind::{Audio, File, Image, Video};

    // 原生支持：原样返回。
    assert_eq!(
        effective_kind(&capability_of("telegram"), Video),
        Some(Video)
    );
    assert_eq!(
        effective_kind(&capability_of("telegram"), Audio),
        Some(Audio)
    );
    // 非原生但能发文件：降级为 File。
    assert_eq!(effective_kind(&capability_of("wechat"), Audio), Some(File));
    assert_eq!(effective_kind(&capability_of("feishu"), Video), Some(File));
    assert_eq!(effective_kind(&capability_of("qq"), Audio), Some(File));
    // 企业微信只能发图片：文件 / 视频 / 语音都拒。
    assert_eq!(effective_kind(&capability_of("wecom"), Image), Some(Image));
    assert_eq!(effective_kind(&capability_of("wecom"), File), None);
    assert_eq!(effective_kind(&capability_of("wecom"), Video), None);
    // 钉钉出站全无。
    assert_eq!(effective_kind(&capability_of("dingtalk"), Image), None);
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

#[test]
fn channel_registry_looks_up_registered_and_misses_unknown() {
    struct Dummy;
    impl ChannelHost for Dummy {
        fn send_media<'a>(
            &'a self,
            _host_ctx: &'a Arc<dyn HostContext>,
            _peer_id: &'a str,
            _context_token: Option<&'a str>,
            _media: OutboundMedia,
        ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
            Box::pin(async { Ok(()) })
        }
    }
    let dummy = Dummy;
    let registry = ChannelRegistry::new()
        .register("wechat", &dummy)
        .register("telegram", &dummy);
    assert!(registry.get("wechat").is_some());
    assert!(registry.get("telegram").is_some());
    assert!(registry.get("nope").is_none(), "未注册通道必须查不到");
}
