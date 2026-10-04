use md5::Md5;
use serde::{Deserialize, Serialize};
use sha1::Sha1;

use crate::channel_media::{
    ext_of, kind_by_name, sniff_image, MediaKind, MediaRefDto, OutboundMedia,
};

use super::*;

/* ===== 协议形状 ===== */

#[derive(Debug, Clone, Deserialize)]
pub(super) struct TokenResponse {
    #[serde(default)]
    pub(super) access_token: Option<String>,
    /// 官方返回的是字符串（`"7200"`），这里按兼容处理。
    #[serde(default)]
    pub(super) expires_in: Option<serde_json::Value>,
    #[serde(default)]
    pub(super) message: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct GatewayResponse {
    #[serde(default)]
    pub(super) url: Option<String>,
    #[serde(default)]
    pub(super) message: Option<String>,
}

/// 网关下行帧。
#[derive(Debug, Clone, Deserialize)]
pub(super) struct GatewayFrame {
    pub(super) op: i64,
    #[serde(default)]
    pub(super) t: Option<String>,
    #[serde(default)]
    pub(super) s: Option<i64>,
    #[serde(default)]
    pub(super) d: Option<serde_json::Value>,
}

/// 分片预上传（`upload_prepare`）的响应。
///
/// `block_size` 官方给的是字符串，这里按值收，交给 `size_of` 兼容字符串 / 数字两种形状。
#[derive(Debug, Clone, Default, Deserialize)]
pub(super) struct UploadPrepareResponse {
    #[serde(default)]
    pub(super) upload_id: String,
    #[serde(default)]
    pub(super) parts: Vec<UploadPart>,
}

/// 一片预签名上传信息。
#[derive(Debug, Clone, Default, Deserialize)]
pub(super) struct UploadPart {
    #[serde(default)]
    pub(super) index: u64,
    #[serde(default)]
    pub(super) presigned_url: String,
    #[serde(default)]
    pub(super) block_size: serde_json::Value,
}

/// `C2C_MESSAGE_CREATE` / `GROUP_AT_MESSAGE_CREATE` 的消息体（只取用得到的字段）。
#[derive(Debug, Clone, Default, Deserialize)]
struct MessagePayload {
    #[serde(default)]
    id: String,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    timestamp: Option<String>,
    /// 群聊消息带群 openid；单聊没有。
    #[serde(default)]
    group_openid: Option<String>,
    #[serde(default)]
    author: Author,
    /// 富媒体消息带附件（图片 / 语音 / 视频 / 文件），`url` 是可直接下载的地址。
    #[serde(default)]
    attachments: Vec<AttachmentPayload>,
}

/// 富媒体附件描述（只取下载所需字段）。
#[derive(Debug, Clone, Default, Deserialize)]
pub(super) struct AttachmentPayload {
    #[serde(default)]
    pub(super) content_type: Option<String>,
    #[serde(default)]
    pub(super) filename: Option<String>,
    #[serde(default)]
    pub(super) size: Option<u64>,
    #[serde(default)]
    pub(super) url: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct Author {
    #[serde(default)]
    user_openid: Option<String>,
    #[serde(default)]
    member_openid: Option<String>,
}

/* ===== 归一（纯函数，可单测） ===== */

/// 会话范围：单聊 / 群聊（回发走不同端点，且群聊要回群里而不是私聊）。
#[derive(Debug, Clone, PartialEq)]
pub enum ChatScope {
    C2c,
    Group,
}

/// 对端 id 编码：`c2c:<openid>` / `group:<openid>`。
///
/// 渲染端把 peer_id 原样还回来，宿主据此选回发端点——两个 openid 空间不通用，
/// 必须把「往哪发」编进 id，而不是靠外部状态猜。
pub fn encode_peer(scope: &ChatScope, openid: &str) -> String {
    let prefix = match scope {
        ChatScope::C2c => "c2c",
        ChatScope::Group => "group",
    };
    format!("{prefix}:{openid}")
}

/// 解码对端 id；形状不对返回 None（脏数据不该让整条通道停摆）。
pub fn decode_peer(peer_id: &str) -> Option<(ChatScope, String)> {
    let (prefix, openid) = peer_id.split_once(':')?;
    let scope = match prefix {
        "c2c" => ChatScope::C2c,
        "group" => ChatScope::Group,
        _ => return None,
    };
    let openid = openid.trim();
    if openid.is_empty() {
        return None;
    }
    Some((scope, openid.to_string()))
}

/// 一条入站消息的归一形状。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QqInboundDto {
    /// 消息 id（被动回复要带着它回）。
    pub message_id: String,
    /// 对端 id（`c2c:<openid>` / `group:<openid>`）。
    pub peer_id: String,
    /// 发送者展示名：QQ 只给 openid，这里回落对端 id。
    pub nick: String,
    /// 发送者 openid（群聊里用来判归属人）。
    pub sender_id: String,
    pub text: String,
    /// 随消息到达的图片 / 视频 / 语音 / 文件；字节在宿主 inbox，凭 `path` 取走。
    pub media: Vec<MediaRefDto>,
    pub at: i64,
}

/// 归一后的入站草稿：附件还是「待下载」的 CDN 直链，等异步取字节落盘后再产 DTO。
#[derive(Debug, Clone)]
pub(crate) struct QqInboundDraft {
    pub message_id: String,
    pub peer_id: String,
    pub nick: String,
    pub sender_id: String,
    pub text: String,
    pub at: i64,
    pub media: Vec<PendingAttachment>,
}

/// 待下载的一条入站附件（QQ 给的是 CDN 直链，直接 GET）。
#[derive(Debug, Clone)]
pub(crate) struct PendingAttachment {
    pub(super) url: String,
    pub(super) kind: MediaKind,
    pub(super) name: String,
    pub(super) declared_size: Option<u64>,
}

/// 归一条 dispatch 事件；不认识的 `t`、空正文且无附件都返回 None。
pub(crate) fn normalize_dispatch(
    event: &str,
    data: &serde_json::Value,
    received_at: i64,
) -> Option<QqInboundDraft> {
    let payload: MessagePayload = serde_json::from_value(data.clone()).ok()?;
    if payload.id.trim().is_empty() {
        return None;
    }
    let (scope, openid, sender_id) = match event {
        "C2C_MESSAGE_CREATE" => {
            let sender = payload.author.user_openid.clone()?;
            (ChatScope::C2c, sender.clone(), sender)
        }
        "GROUP_AT_MESSAGE_CREATE" => {
            let group = payload.group_openid.clone()?;
            // 群聊里 sender 是成员 openid；没有它就判断不了归属人，退回群 id 不猜。
            let sender = payload
                .author
                .member_openid
                .clone()
                .unwrap_or_else(|| group.clone());
            (ChatScope::Group, group, sender)
        }
        _ => return None,
    };
    let media = pending_attachments(&payload.attachments);
    let text = payload.content.unwrap_or_default();
    if text.trim().is_empty() && media.is_empty() {
        return None;
    }
    let at = payload
        .timestamp
        .as_deref()
        .and_then(|raw| raw.parse::<i64>().ok())
        .filter(|seconds| *seconds > 0)
        .map(|seconds| seconds.saturating_mul(1000))
        .unwrap_or(received_at);
    let peer_id = encode_peer(&scope, &openid);
    Some(QqInboundDraft {
        message_id: payload.id,
        nick: peer_id.clone(),
        peer_id,
        sender_id,
        text,
        at,
        media,
    })
}

/// 附件归一：按 mime 分图片 / 视频 / 语音，认不出再按文件名扩展名，最后按文件收；
/// 无直链的丢掉；最多 4 条。
pub(super) fn pending_attachments(attachments: &[AttachmentPayload]) -> Vec<PendingAttachment> {
    let mut out: Vec<PendingAttachment> = attachments
        .iter()
        .filter(|item| !item.url.trim().is_empty())
        .map(|item| {
            let name = item
                .filename
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let kind = match item.content_type.as_deref() {
                Some(mime) if mime.starts_with("image/") => MediaKind::Image,
                Some(mime) if mime.starts_with("video/") => MediaKind::Video,
                Some(mime) if mime.starts_with("audio/") => MediaKind::Audio,
                _ => kind_by_name(name.unwrap_or("")),
            };
            PendingAttachment {
                url: item.url.trim().to_string(),
                kind,
                name: name.unwrap_or("attachment").to_string(),
                declared_size: item.size,
            }
        })
        .collect();
    out.truncate(MAX_INBOUND_MEDIA);
    out
}

/// 被动回复的请求体：`msg_id` + 自增 `msg_seq`（同一对不能重复发）。
pub fn reply_payload(text: &str, msg_id: &str, msg_seq: u64) -> serde_json::Value {
    serde_json::json!({
        "content": text,
        "msg_type": 0,
        "msg_id": msg_id,
        "msg_seq": msg_seq,
    })
}

/// 富媒体消息的请求体：`msg_type=7` + `media.file_info`（先上传换来的凭据）。
pub fn rich_media_payload(file_info: &str, msg_id: &str, msg_seq: u64) -> serde_json::Value {
    serde_json::json!({
        "msg_type": 7,
        "media": { "file_info": file_info },
        "msg_id": msg_id,
        "msg_seq": msg_seq,
    })
}

/// 单聊 / 群聊的资源根（`upload_prepare` / `files` / `messages` 都挂在它下面）。
pub(super) fn base_url(scope: &ChatScope, openid: &str) -> String {
    match scope {
        ChatScope::C2c => format!("{API_BASE}/v2/users/{openid}"),
        ChatScope::Group => format!("{API_BASE}/v2/groups/{openid}"),
    }
}

/// 回发消息的端点。
pub(super) fn messages_url(scope: &ChatScope, openid: &str) -> String {
    format!("{}/messages", base_url(scope, openid))
}

/// QQ 的业务类型：图片只认 png/jpg、视频只认 mp4/mov，其余一律按文件（4）发，
/// 免得撞 850019「不支持的文件格式」。语音要 SILK 编码，共享层已把它降级为文件。
pub(super) fn qq_file_type(media: &OutboundMedia) -> i64 {
    match media.kind {
        MediaKind::Image => {
            if let Some((mime, _)) = sniff_image(&media.bytes) {
                if mime == "image/png" || mime == "image/jpeg" {
                    return FILE_TYPE_IMAGE;
                }
            }
        }
        MediaKind::Video => {
            if matches!(ext_of(&media.name).as_str(), "mp4" | "mov") {
                return FILE_TYPE_MEDIA;
            }
        }
        MediaKind::Audio | MediaKind::File => {}
    }
    FILE_TYPE_FILE
}

/// 小写十六进制（md5 / sha1 摘要的文本形状）。
pub(super) fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

pub(super) fn md5_hex(bytes: &[u8]) -> String {
    let mut hasher = Md5::new();
    hasher.update(bytes);
    hex(&hasher.finalize())
}

pub(super) fn sha1_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(bytes);
    hex(&hasher.finalize())
}

/// 分片大小兼容字符串 / 数字两种形状（官方给字符串，这里不赌）。
pub(super) fn size_of(value: &serde_json::Value) -> Option<u64> {
    match value {
        serde_json::Value::String(text) => text.trim().parse::<u64>().ok(),
        serde_json::Value::Number(number) => number.as_u64(),
        _ => None,
    }
}

/// 文本净化：空文本拒绝，超长截断（截断也要发出去）。
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

/// `expires_in` 兼容字符串/数字两种形状。
pub(super) fn parse_expires_in(raw: Option<&serde_json::Value>) -> i64 {
    match raw {
        Some(serde_json::Value::String(text)) => text.parse::<i64>().unwrap_or(7200),
        Some(serde_json::Value::Number(number)) => number.as_i64().unwrap_or(7200),
        _ => 7200,
    }
}

/// 鉴权头：官方格式 `QQBot {access_token}`。
pub(super) fn auth_header(token: &str) -> String {
    format!("QQBot {token}")
}
