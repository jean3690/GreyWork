use serde::{Deserialize, Serialize};

use crate::channel_media::{MediaKind, MediaRefDto};

use super::*;

/* ===== 协议形状（只取本通道用得到的字段） ===== */

#[derive(Debug, Clone, Deserialize)]
pub(super) struct UpdatesResponse {
    pub(super) ok: bool,
    #[serde(default)]
    pub(super) result: Vec<Update>,
    #[serde(default)]
    pub(super) description: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct Update {
    pub(super) update_id: i64,
    #[serde(default)]
    pub(super) message: Option<Message>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct Message {
    #[serde(default)]
    pub(super) message_id: i64,
    #[serde(default)]
    pub(super) from: Option<User>,
    pub(super) chat: Chat,
    #[serde(default)]
    pub(super) text: Option<String>,
    /// 图片 / 文件消息的配文（与 text 互斥）；有它就该当正文喂给模型。
    #[serde(default)]
    pub(super) caption: Option<String>,
    /// 图片消息：同一张图的多个尺寸（递增），取最后一个（最大）。
    #[serde(default)]
    pub(super) photo: Option<Vec<PhotoSize>>,
    /// 以「文件」方式发出的附件（含被压成文件的图片）。
    #[serde(default)]
    pub(super) document: Option<Document>,
    /// 语音 / 音频 / 视频：形状同 Document（file_id + 可选名 / mime），按文件收。
    #[serde(default)]
    pub(super) voice: Option<Document>,
    #[serde(default)]
    pub(super) audio: Option<Document>,
    #[serde(default)]
    pub(super) video: Option<Document>,
    /// 服务端时间（unix 秒）。
    #[serde(default)]
    pub(super) date: Option<i64>,
}

/// 图片尺寸档（只取下载所需字段）。
#[derive(Debug, Clone, Deserialize)]
pub(super) struct PhotoSize {
    pub(super) file_id: String,
    #[serde(default)]
    pub(super) file_size: Option<u64>,
}

/// 附件 / 媒体文件描述（document / voice / audio / video 共用形状，多余字段忽略）。
#[derive(Debug, Clone, Deserialize)]
pub(super) struct Document {
    pub(super) file_id: String,
    #[serde(default)]
    pub(super) file_name: Option<String>,
    #[serde(default)]
    pub(super) mime_type: Option<String>,
    #[serde(default)]
    pub(super) file_size: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct User {
    /// 反序列化形状对齐用（Telegram 一定带 id）；对端标识取 chat.id，这里不读。
    #[allow(dead_code)]
    pub(super) id: i64,
    #[serde(default)]
    pub(super) first_name: Option<String>,
    #[serde(default)]
    pub(super) last_name: Option<String>,
    #[serde(default)]
    pub(super) username: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct Chat {
    pub(super) id: i64,
    #[serde(default)]
    pub(super) first_name: Option<String>,
    #[serde(default)]
    pub(super) last_name: Option<String>,
    #[serde(default)]
    pub(super) username: Option<String>,
    #[serde(default)]
    pub(super) title: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct SendResponse {
    pub(super) ok: bool,
    #[serde(default)]
    pub(super) description: Option<String>,
}

/// `getMe` 回包：机器人自身的公开身份（username 是扫码链接的唯一组成）。
#[derive(Debug, Clone, Deserialize)]
pub(super) struct MeResponse {
    pub(super) ok: bool,
    #[serde(default)]
    pub(super) result: Option<BotUser>,
    #[serde(default)]
    pub(super) description: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct BotUser {
    #[serde(default)]
    pub(super) first_name: String,
    #[serde(default)]
    pub(super) username: Option<String>,
}

/// `getFile` 回包：拿到可下载的 `file_path`（再拼 `/file/bot<token>/<file_path>` 下载）。
#[derive(Debug, Clone, Deserialize)]
pub(super) struct FileResponse {
    pub(super) ok: bool,
    #[serde(default)]
    pub(super) result: Option<FileInfo>,
    #[serde(default)]
    pub(super) description: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct FileInfo {
    #[serde(default)]
    pub(super) file_path: Option<String>,
}

/// 扫码绑定用的机器人链接（渲染端只负责把它编成二维码）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TelegramBotLinkDto {
    /// 机器人 @username（不含 `@`）。
    pub username: String,
    pub name: String,
    /// `https://t.me/<username>`：手机扫码即打开与机器人的对话。
    pub url: String,
}

/* ===== token 校验 ===== */

/// bot token 形状：`<数字 id>:<base64url 风格密钥>`。
///
/// 严格到形状层面：token 会被拼进 URL 路径，放行空白 / 斜杠 / `?` 等于把请求目标
/// 交给远端输入决定。校验失败时给的是「怎么填」而不是协议细节。
pub fn validate_token(raw: &str) -> Result<String, String> {
    let token = raw.trim();
    if token.is_empty() {
        return Err("bot token 不能为空".into());
    }
    if token.chars().count() > MAX_TOKEN_CHARS {
        return Err(format!("bot token 过长（最多 {MAX_TOKEN_CHARS} 字符）"));
    }
    if !token.is_ascii() {
        return Err("bot token 只能是 ASCII 字符".into());
    }
    let Some((prefix, secret)) = token.split_once(':') else {
        return Err("bot token 形状应为 `数字:密钥`（在 @BotFather 里获取）".into());
    };
    if prefix.is_empty()
        || prefix.len() > TOKEN_PREFIX_MAX_DIGITS
        || !prefix.chars().all(|c| c.is_ascii_digit())
    {
        return Err("bot token 的 id 段应为数字".into());
    }
    if secret.len() < TOKEN_SECRET_MIN_CHARS
        || !secret
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("bot token 的密钥段含非法字符".into());
    }
    Ok(token.to_string())
}

/// 发送文本净化：空文本拒绝，超长按 Telegram 上限截断（截断也要发出去）。
pub fn clamp_text(raw: &str) -> Result<String, String> {
    let text = raw.trim();
    if text.is_empty() {
        return Err("回复内容为空".into());
    }
    if text.chars().count() <= MAX_TEXT_CHARS {
        return Ok(text.to_string());
    }
    let head: String = text.chars().take(MAX_TEXT_CHARS).collect();
    Ok(head)
}

/* ===== 协议归一（纯函数，可单测） ===== */

/// 一条入站消息的归一形状（渲染端只认这一份）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramInboundDto {
    pub message_id: String,
    /// 对端 chat id（十进制字符串）。
    pub peer_id: String,
    /// 发送者展示名（first + last；缺失回落 username / chat id）。
    pub nick: String,
    /// 文本正文（图片 / 文件的配文也算正文）；非文本消息为空串。
    pub text: String,
    /// 随消息到达的图片 / 视频 / 语音 / 文件；字节在宿主 inbox，凭 `path` 取走。
    pub media: Vec<MediaRefDto>,
    pub at: i64,
}

/// 归一后的入站草稿：媒体还是「待下载」的 file_id，等异步取字节落盘后再产 DTO。
#[derive(Debug, Clone)]
pub(super) struct InboundDraft {
    pub(super) message_id: String,
    pub(super) peer_id: String,
    pub(super) nick: String,
    pub(super) text: String,
    pub(super) at: i64,
    pub(super) media: Vec<PendingMedia>,
}

/// 待下载的一条入站媒体：Telegram 只给 file_id，字节要再经 getFile + 文件下载取回。
#[derive(Debug, Clone)]
pub(super) struct PendingMedia {
    pub(super) file_id: String,
    pub(super) kind: MediaKind,
    /// 展示名（图片给 "photo"，由 `finalize_media` 按魔数补后缀）。
    pub(super) name: String,
    pub(super) declared_size: Option<u64>,
}

pub(super) fn user_nick(user: &Option<User>, chat: &Chat, peer_id: &str) -> String {
    if let Some(user) = user {
        let name = [user.first_name.as_deref(), user.last_name.as_deref()]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" ");
        if !name.trim().is_empty() {
            return name.trim().to_string();
        }
        if let Some(username) = user
            .username
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            return username.to_string();
        }
    }
    let chat_name = [chat.first_name.as_deref(), chat.last_name.as_deref()]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");
    if !chat_name.trim().is_empty() {
        return chat_name.trim().to_string();
    }
    if let Some(title) = chat
        .title
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        return title.to_string();
    }
    if let Some(username) = chat
        .username
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        return username.to_string();
    }
    peer_id.to_string()
}

/// 一条消息里可收的媒体：图片取最大档；文件 / 语音 / 音频 / 视频按各自类别收，最多 4 条。
pub(super) fn pending_media(message: &Message) -> Vec<PendingMedia> {
    let mut out = Vec::new();
    if let Some(largest) = message.photo.as_ref().and_then(|sizes| sizes.last()) {
        out.push(PendingMedia {
            file_id: largest.file_id.clone(),
            kind: MediaKind::Image,
            name: "photo".into(),
            declared_size: largest.file_size,
        });
    }
    if let Some(document) = message.document.as_ref() {
        out.push(document_media(document, "document", None));
    }
    for (slot, fallback, kind) in [
        (message.voice.as_ref(), "voice", MediaKind::Audio),
        (message.audio.as_ref(), "audio", MediaKind::Audio),
        (message.video.as_ref(), "video", MediaKind::Video),
    ] {
        if let Some(item) = slot {
            out.push(document_media(item, fallback, Some(kind)));
        }
    }
    out.truncate(MAX_INBOUND_MEDIA);
    out
}

/// document / voice / audio / video 归一：`kind` 为 None 时按 mime 猜
/// （以文件方式发的图也走图片端点），否则用调用方给的类别。
pub(super) fn document_media(
    document: &Document,
    fallback: &str,
    kind: Option<MediaKind>,
) -> PendingMedia {
    let name = document
        .file_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback)
        .to_string();
    let kind = kind.unwrap_or_else(|| match document.mime_type.as_deref() {
        Some(mime) if mime.starts_with("image/") => MediaKind::Image,
        _ => MediaKind::File,
    });
    PendingMedia {
        file_id: document.file_id.clone(),
        kind,
        name,
        declared_size: document.file_size,
    }
}

/// `Update` → 归一草稿；无消息体（编辑 / 回调查询等）返回 None。
pub(super) fn normalize_update(update: &Update, received_at: i64) -> Option<InboundDraft> {
    let message = update.message.as_ref()?;
    let peer_id = message.chat.id.to_string();
    let at = message
        .date
        .filter(|seconds| *seconds > 0)
        .map(|seconds| seconds.saturating_mul(1000))
        .unwrap_or(received_at);
    // 图片 / 文件的配文也算正文：只发图配一句话时，那句话是模型最需要的上下文。
    let text = message
        .text
        .clone()
        .or_else(|| message.caption.clone())
        .unwrap_or_default();
    Some(InboundDraft {
        message_id: message.message_id.to_string(),
        nick: user_nick(&message.from, &message.chat, &peer_id),
        text,
        peer_id,
        at,
        media: pending_media(message),
    })
}

/// 解析一次 `getUpdates` 响应体：`ok=false` 一律当错误（把 description 带出去）。
pub(super) fn parse_updates(raw: &str) -> Result<Vec<Update>, String> {
    let parsed: UpdatesResponse =
        serde_json::from_str(raw).map_err(|error| format!("getUpdates 响应解析失败: {error}"))?;
    if !parsed.ok {
        return Err(format!(
            "Telegram 拒绝了 getUpdates：{}",
            parsed.description.unwrap_or_else(|| "unknown error".into())
        ));
    }
    Ok(parsed.result)
}
