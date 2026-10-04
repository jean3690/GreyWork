use aes::cipher::generic_array::GenericArray;
use aes::cipher::{BlockDecrypt, KeyInit};
use aes::Aes256;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::{Deserialize, Serialize};

use crate::channel_media::{MediaKind, MediaRefDto};

use super::*;

/* ===== 协议形状 ===== */

/// 服务端下行帧：请求回执（无 cmd，带 headers.req_id + errcode）与回调（有 cmd）共用一份形状。
#[derive(Debug, Clone, Deserialize)]
pub(super) struct ServerFrame {
    #[serde(default)]
    pub(super) cmd: Option<String>,
    #[serde(default)]
    pub(super) headers: FrameHeaders,
    #[serde(default)]
    errcode: Option<i64>,
    #[serde(default)]
    errmsg: Option<String>,
    #[serde(default)]
    pub(super) body: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub(super) struct FrameHeaders {
    #[serde(default)]
    pub(super) req_id: Option<String>,
}

/// `aibot_msg_callback` / `aibot_event_callback` 的 body（只取用得到的字段）。
#[derive(Debug, Clone, Default, Deserialize)]
pub(super) struct CallbackBody {
    #[serde(default)]
    pub(super) msgid: String,
    #[serde(default)]
    pub(super) create_time: Option<i64>,
    #[serde(default)]
    pub(super) chatid: Option<String>,
    #[serde(default)]
    pub(super) chattype: Option<String>,
    #[serde(default)]
    pub(super) from: FromUser,
    #[serde(default)]
    pub(super) msgtype: Option<String>,
    #[serde(default)]
    pub(super) text: Option<TextBlock>,
    #[serde(default)]
    pub(super) event: Option<EventBlock>,
    /// 图片 / 视频：`{url, aeskey}`（长连接模式额外给 aeskey，字节要解密）。
    #[serde(default)]
    pub(super) image: Option<MediaBlock>,
    #[serde(default)]
    pub(super) video: Option<MediaBlock>,
    /// 文件：`{url, aeskey, name?, size?}`。
    #[serde(default)]
    pub(super) file: Option<FileBlock>,
    /// 语音：`{content}`（转写文本；企业微信不下发原始音频，无 url/aeskey）。
    #[serde(default)]
    pub(super) voice: Option<VoiceBlock>,
    /// 图文混排：`{msg_item: [{type, text?, image?}]}`。
    #[serde(default)]
    pub(super) mixed: Option<MixedBlock>,
}

/// 图片 / 视频块。
#[derive(Debug, Clone, Default, Deserialize)]
pub(super) struct MediaBlock {
    #[serde(default)]
    pub(super) url: Option<String>,
    #[serde(default)]
    pub(super) aeskey: Option<String>,
}

/// 文件块。
#[derive(Debug, Clone, Default, Deserialize)]
pub(super) struct FileBlock {
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    aeskey: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    size: Option<u64>,
}

/// 语音块：企业微信只回「语音转文本」结果，没有可下载的原始音频。
#[derive(Debug, Clone, Default, Deserialize)]
pub(super) struct VoiceBlock {
    /// 语音转写文本（官方《智能机器人长连接》VoiceContent.content）。
    #[serde(default)]
    content: Option<String>,
}

/// 图文混排块。
#[derive(Debug, Clone, Default, Deserialize)]
pub(super) struct MixedBlock {
    #[serde(default)]
    pub(super) msg_item: Vec<MixedItem>,
}

/// 图文混排里的一项：`type` 是 `text` 或 `image`。
#[derive(Debug, Clone, Default, Deserialize)]
pub(super) struct MixedItem {
    #[serde(default, rename = "type")]
    pub(super) kind: Option<String>,
    #[serde(default)]
    pub(super) text: Option<TextBlock>,
    #[serde(default)]
    pub(super) image: Option<MediaBlock>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub(super) struct FromUser {
    #[serde(default)]
    userid: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub(super) struct TextBlock {
    #[serde(default)]
    content: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub(super) struct EventBlock {
    #[serde(default)]
    pub(super) eventtype: Option<String>,
}

/* ===== 归一（纯函数，可单测） ===== */

/// 会话范围：单聊 / 群聊（主动推送要区分 chat_type）。
#[derive(Debug, Clone, PartialEq)]
pub enum ChatScope {
    Single,
    Group,
}

/// 对端 id 编码：`single:<userid>` / `group:<chatid>`。
pub fn encode_peer(scope: &ChatScope, id: &str) -> String {
    let prefix = match scope {
        ChatScope::Single => "single",
        ChatScope::Group => "group",
    };
    format!("{prefix}:{id}")
}

/// 解码对端 id；形状不对返回 None。
pub fn decode_peer(peer_id: &str) -> Option<(ChatScope, String)> {
    let (prefix, id) = peer_id.split_once(':')?;
    let scope = match prefix {
        "single" => ChatScope::Single,
        "group" => ChatScope::Group,
        _ => return None,
    };
    let id = id.trim();
    if id.is_empty() {
        return None;
    }
    Some((scope, id.to_string()))
}

/// 一条入站消息的归一形状。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WecomInboundDto {
    pub msg_id: String,
    /// 对端 id（`single:<userid>` / `group:<chatid>`）。
    pub peer_id: String,
    /// 发送者展示名：企业微信只给 userid，这里回落对端 id。
    pub nick: String,
    /// 发送者 userid（判归属人）。
    pub sender_id: String,
    pub text: String,
    /// 收不下也转不成文本的消息类型（如无直链图片、未知类型），其余为空串。
    pub unsupported: String,
    /// 随消息到达的图片 / 视频 / 文件；字节在宿主 inbox，凭 `path` 取走。
    pub media: Vec<MediaRefDto>,
    pub at: i64,
}

/// 归一后的入站草稿：媒体还是「待下载」的 `{url, aeskey}`，等异步取字节落盘后再产 DTO。
#[derive(Debug, Clone)]
pub(crate) struct WecomInboundDraft {
    pub msg_id: String,
    pub peer_id: String,
    pub nick: String,
    pub sender_id: String,
    pub text: String,
    pub unsupported: String,
    pub at: i64,
    pub media: Vec<PendingMedia>,
}

/// 待下载的一条入站媒体（长连接模式给的是加密直链 + aeskey）。
#[derive(Debug, Clone)]
pub(crate) struct PendingMedia {
    pub(super) url: String,
    pub(super) aeskey: Option<String>,
    pub(super) kind: MediaKind,
    pub(super) name: String,
    pub(super) declared_size: Option<u64>,
}

/// 归一条消息回调；缺关键字段返回 None。
pub(crate) fn normalize_callback(
    body: &serde_json::Value,
    received_at: i64,
) -> Option<WecomInboundDraft> {
    let parsed: CallbackBody = serde_json::from_value(body.clone()).ok()?;
    let sender = parsed
        .from
        .userid
        .clone()
        .filter(|value| !value.trim().is_empty())?;
    let is_group = parsed.chattype.as_deref() == Some("group");
    let peer_id = if is_group {
        encode_peer(
            &ChatScope::Group,
            parsed.chatid.as_deref().unwrap_or_default(),
        )
    } else {
        encode_peer(&ChatScope::Single, &sender)
    };
    if peer_id.ends_with(':') {
        // 群聊消息没有 chatid：没法回发，丢掉而不是猜一个
        return None;
    }
    let msgtype = parsed.msgtype.clone().unwrap_or_default();
    let text = match msgtype.as_str() {
        "text" => parsed
            .text
            .as_ref()
            .and_then(|block| block.content.clone())
            .unwrap_or_default(),
        // 图文混排里的文本项也当正文转达，免得只有图没话。
        "mixed" => parsed.mixed.as_ref().map(mixed_text).unwrap_or_default(),
        // 语音：企业微信直接回「语音转文本」，没有可下载的原始音频 —— 把转写当正文转达，模型即可应答。
        "voice" => parsed
            .voice
            .as_ref()
            .and_then(|block| block.content.clone())
            .unwrap_or_default(),
        _ => String::new(),
    };
    let media = pending_media(&parsed);
    // 文本、有转写的语音、有可下载媒体都算「转达到了」；其余（缺直链的 image…）如实标注类型。
    let handled = match msgtype.as_str() {
        "text" => true,
        "voice" => !text.trim().is_empty(),
        _ => !media.is_empty(),
    };
    let at = parsed
        .create_time
        .filter(|seconds| *seconds > 0)
        .map(|seconds| seconds.saturating_mul(1000))
        .unwrap_or(received_at);
    Some(WecomInboundDraft {
        msg_id: parsed.msgid,
        nick: peer_id.clone(),
        peer_id,
        sender_id: sender,
        text,
        unsupported: if handled { String::new() } else { msgtype },
        at,
        media,
    })
}

/// 图文混排里的文本项拼成正文。
fn mixed_text(mixed: &MixedBlock) -> String {
    mixed
        .msg_item
        .iter()
        .filter(|item| item.kind.as_deref() == Some("text"))
        .filter_map(|item| item.text.as_ref())
        .filter_map(|block| block.content.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// 从回调里挑出可下载的媒体（图片 / 视频 / 文件 / 图文混排里的图），最多 4 条。
///
/// 语音不在此列：企业微信语音回调只给转写文本（`voice.content`），没有可下载的原始音频，
/// 因此在 `normalize_callback` 里按文本转达，而不当媒体下载。
pub(super) fn pending_media(body: &CallbackBody) -> Vec<PendingMedia> {
    let mut out = Vec::new();
    if let Some(block) = body.image.as_ref() {
        push_pending(&mut out, block, MediaKind::Image);
    }
    if let Some(block) = body.video.as_ref() {
        push_pending(&mut out, block, MediaKind::Video);
    }
    if let Some(block) = body.file.as_ref() {
        out.push(PendingMedia {
            url: block.url.clone().unwrap_or_default().trim().to_string(),
            aeskey: block.aeskey.clone(),
            kind: MediaKind::File,
            name: block
                .name
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("attachment")
                .to_string(),
            declared_size: block.size,
        });
    }
    if let Some(mixed) = body.mixed.as_ref() {
        for item in &mixed.msg_item {
            if item.kind.as_deref() == Some("image") {
                if let Some(block) = item.image.as_ref() {
                    push_pending(&mut out, block, MediaKind::Image);
                }
            }
        }
    }
    out.retain(|item| !item.url.is_empty());
    out.truncate(MAX_INBOUND_MEDIA);
    out
}

/// 把图片 / 视频块归一成待下载项（无直链的丢掉）。
fn push_pending(out: &mut Vec<PendingMedia>, block: &MediaBlock, kind: MediaKind) {
    let url = block.url.clone().unwrap_or_default().trim().to_string();
    if url.is_empty() {
        return;
    }
    out.push(PendingMedia {
        url,
        aeskey: block.aeskey.clone(),
        kind,
        name: "attachment".to_string(),
        declared_size: None,
    });
}

/// 文本净化：空文本拒绝，超长截断。
pub fn clamp_text(raw: &str) -> Result<String, String> {
    let text = raw.trim();
    if text.is_empty() {
        return Err("回复内容为空".into());
    }
    if text.chars().count() <= MAX_TEXT_CHARS {
        return Ok(text.to_string());
    }
    Ok(text.chars().take(MAX_TEXT_CHARS).collect())
}

/// 被动回复帧：必须透传回调的 req_id。
pub fn respond_frame(req_id: &str, text: &str) -> serde_json::Value {
    serde_json::json!({
        "cmd": "aibot_respond_msg",
        "headers": { "req_id": req_id },
        "body": { "msgtype": "text", "text": { "content": text } },
    })
}

/// 主动推送帧：只在没有回调凭据时用（要求对方先给机器人发过消息）。
/// 主动推送只支持 template_card / markdown，这里用 markdown 承载纯文本。
pub fn push_frame(scope: &ChatScope, id: &str, text: &str, req_id: &str) -> serde_json::Value {
    serde_json::json!({
        "cmd": "aibot_send_msg",
        "headers": { "req_id": req_id },
        "body": {
            "chatid": id,
            "chat_type": if *scope == ChatScope::Single { 1 } else { 2 },
            "msgtype": "markdown",
            "markdown": { "content": text },
        },
    })
}

/// 订阅帧。
pub fn subscribe_frame(bot_id: &str, secret: &str, req_id: &str) -> serde_json::Value {
    serde_json::json!({
        "cmd": "aibot_subscribe",
        "headers": { "req_id": req_id },
        "body": { "bot_id": bot_id, "secret": secret },
    })
}

/// 心跳帧。
pub fn ping_frame(req_id: &str) -> serde_json::Value {
    serde_json::json!({ "cmd": "ping", "headers": { "req_id": req_id } })
}

/* ===== 媒体：出站帧与上传体（纯函数，可单测） ===== */

/// 媒体消息体：`{msgtype: <type>, <type>: {media_id}}`（键名随类别变，故用 Map 拼）。
fn media_body(media_type: &str, media_id: &str) -> serde_json::Map<String, serde_json::Value> {
    let mut body = serde_json::Map::new();
    body.insert(
        "msgtype".into(),
        serde_json::Value::String(media_type.to_string()),
    );
    body.insert(
        media_type.into(),
        serde_json::json!({ "media_id": media_id }),
    );
    body
}

/// 媒体被动回复帧：msgtype 就是媒体类别（image），media_id 由上传换得。
pub fn respond_media_frame(req_id: &str, media_type: &str, media_id: &str) -> serde_json::Value {
    serde_json::json!({
        "cmd": RESPOND_CMD,
        "headers": { "req_id": req_id },
        "body": serde_json::Value::Object(media_body(media_type, media_id)),
    })
}

/// 媒体主动推送帧：与文本推送同形，只把 msgtype 换成媒体类别。
pub fn push_media_frame(
    scope: &ChatScope,
    id: &str,
    media_type: &str,
    media_id: &str,
    req_id: &str,
) -> serde_json::Value {
    let mut body = media_body(media_type, media_id);
    body.insert("chatid".into(), serde_json::Value::String(id.to_string()));
    body.insert(
        "chat_type".into(),
        serde_json::json!(if *scope == ChatScope::Single { 1 } else { 2 }),
    );
    serde_json::json!({
        "cmd": PUSH_CMD,
        "headers": { "req_id": req_id },
        "body": serde_json::Value::Object(body),
    })
}

/// 上传第一步的请求体。
pub fn upload_init_body(
    name: &str,
    media_type: &str,
    size: usize,
    total_chunks: usize,
    md5: &str,
) -> serde_json::Value {
    serde_json::json!({
        "filename": name,
        "type": media_type,
        "total_size": size,
        "total_chunks": total_chunks,
        "md5": md5,
    })
}

/// 上传第二步（每片）的请求体：分片原文 base64。
pub fn upload_chunk_body(
    upload_id: &str,
    index: usize,
    total_chunks: usize,
    base64_data: &str,
) -> serde_json::Value {
    serde_json::json!({
        "upload_id": upload_id,
        "chunk_index": index,
        "total_chunks": total_chunks,
        "base64_data": base64_data,
    })
}

/// 上传第三步（合并）的请求体。
pub fn upload_finish_body(upload_id: &str, name: &str, media_type: &str) -> serde_json::Value {
    serde_json::json!({
        "upload_id": upload_id,
        "filename": name,
        "media_type": media_type,
    })
}

/* ===== 媒体：入站解密（AES-256-CBC，密钥即 aeskey） ===== */

/// 小写十六进制（上传第一步要带的整文件 md5）。
pub(super) fn md5_hex(bytes: &[u8]) -> String {
    use md5::Md5;
    use sha2::Digest as _;
    let mut hasher = Md5::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest.iter() {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// 解 aeskey：base64（长度非 4 的倍数时补齐 `=`），须解出 32 字节。
fn decode_aes_key(aes_key: &str) -> Result<Vec<u8>, String> {
    let raw = aes_key.trim();
    if raw.is_empty() {
        return Err("缺少 aeskey".into());
    }
    let padded = if raw.len().is_multiple_of(4) {
        raw.to_string()
    } else {
        format!("{raw}{}", "=".repeat(4 - raw.len() % 4))
    };
    let key = BASE64
        .decode(padded)
        .map_err(|_| "aeskey base64 解码失败".to_string())?;
    if key.len() != 32 {
        return Err("aeskey 不是 32 字节".into());
    }
    Ok(key)
}

/// 解密企业微信入站媒体：AES-256-CBC，IV 取密钥前 16 字节，PKCS#7 去填充。
///
/// 与官方 SDK（`download_file`）同一算法；`aes` 已是 `aes-gcm` 的传递依赖，这里不引新 crate。
pub fn decrypt_media(encrypted: &[u8], aes_key: &str) -> Result<Vec<u8>, String> {
    if encrypted.is_empty() {
        return Err("密文为空".into());
    }
    if !encrypted.len().is_multiple_of(16) {
        return Err("密文长度不是 16 的倍数".into());
    }
    let key = decode_aes_key(aes_key)?;
    let cipher = Aes256::new(GenericArray::from_slice(&key));
    let mut prev = [0u8; 16];
    prev.copy_from_slice(&key[..16]);
    let mut out = Vec::with_capacity(encrypted.len());
    for block in encrypted.as_chunks::<16>().0 {
        let mut buf = GenericArray::clone_from_slice(block);
        cipher.decrypt_block(&mut buf);
        for (index, byte) in buf.iter().enumerate() {
            out.push(byte ^ prev[index]);
        }
        prev.copy_from_slice(block);
    }
    unpad_pkcs7(out)
}

/// PKCS#7 去填充（块长 16）。
fn unpad_pkcs7(mut data: Vec<u8>) -> Result<Vec<u8>, String> {
    let pad = *data.last().ok_or("解密结果为空")? as usize;
    if pad == 0 || pad > 16 || pad > data.len() {
        return Err("PKCS#7 填充值非法".into());
    }
    if data[data.len() - pad..]
        .iter()
        .any(|byte| *byte as usize != pad)
    {
        return Err("PKCS#7 填充字节不一致".into());
    }
    data.truncate(data.len() - pad);
    Ok(data)
}

/// 请求回执判定：errcode 缺失或 0 视为成功。
pub(super) fn frame_error(frame: &ServerFrame) -> Option<String> {
    match frame.errcode {
        Some(0) | None => None,
        Some(code) => Some(format!(
            "企业微信拒绝了请求（{code}）：{}",
            frame
                .errmsg
                .clone()
                .unwrap_or_else(|| "unknown error".into())
        )),
    }
}
