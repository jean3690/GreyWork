//! 命名 / 魔数嗅探 / 判类纯函数。

use super::types::MediaKind;

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

/// 按文件名扩展名判类（不嗅探字节）：认不出返回 File。
///
/// 入站某些通道只给 mime 或什么都没有、只给文件名时用它兜底判类。
pub fn kind_by_name(name: &str) -> MediaKind {
    kind_of_ext(&ext_of(name)).unwrap_or(MediaKind::File)
}
