use serde::{Deserialize, Serialize};

use crate::channel_media::{kind_by_name, MediaKind, MediaRefDto};

use super::*;

/* ===== 协议形状 ===== */

/// `GET /users/@me` 的 bot 用户（只为「填完能确认填对了」）。
#[derive(Debug, Clone, Default, Deserialize)]
pub(super) struct BotUser {
    #[serde(default)]
    pub(super) id: String,
    #[serde(default)]
    pub(super) username: String,
    #[serde(default)]
    pub(super) global_name: Option<String>,
}

impl BotUser {
    /// 展示名：优先全局名，回落用户名。
    pub(super) fn display_name(&self) -> String {
        self.global_name
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| self.username.clone())
    }
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct GatewayResponse {
    #[serde(default)]
    pub(super) url: Option<String>,
    #[serde(default)]
    pub(super) message: Option<String>,
}

/// 网关下行帧：`s` 只在 dispatch 上出现，`t` 表示事件类型。
#[derive(Debug, Clone, Deserialize)]
pub(super) struct GatewayFrame {
    pub(super) op: i64,
    #[serde(default)]
    pub(super) d: Option<serde_json::Value>,
    #[serde(default)]
    pub(super) s: Option<i64>,
    #[serde(default)]
    pub(super) t: Option<String>,
}

/// `MESSAGE_CREATE` 的消息体（只取用得到的字段）。
#[derive(Debug, Clone, Default, Deserialize)]
pub(super) struct MessagePayload {
    #[serde(default)]
    pub(super) id: String,
    #[serde(default)]
    pub(super) channel_id: String,
    /// 服务器消息才带 guild_id —— 带了就不是私聊，丢弃。
    #[serde(default)]
    pub(super) guild_id: Option<String>,
    #[serde(default)]
    pub(super) content: String,
    #[serde(default)]
    pub(super) author: Author,
    /// 随消息上传的附件（图片 / 文件）；`url` 是带签名的 CDN 直链，下载无需鉴权。
    #[serde(default)]
    pub(super) attachments: Vec<AttachmentPayload>,
    /// RFC3339（`2024-01-01T00:00:00.000000+00:00`）。
    #[serde(default)]
    pub(super) timestamp: Option<String>,
}

/// `MESSAGE_CREATE` 的附件描述（只取下载所需字段）。
#[derive(Debug, Clone, Default, Deserialize)]
pub(super) struct AttachmentPayload {
    #[serde(default)]
    pub(super) filename: String,
    #[serde(default)]
    pub(super) content_type: Option<String>,
    #[serde(default)]
    pub(super) size: Option<u64>,
    #[serde(default)]
    pub(super) url: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub(super) struct Author {
    #[serde(default)]
    pub(super) id: String,
    #[serde(default)]
    pub(super) username: String,
    #[serde(default)]
    pub(super) global_name: Option<String>,
    /// 别的机器人：不答复（否则两个 bot 会互相刷）。
    #[serde(default)]
    pub(super) bot: bool,
}

/* ===== 归一（纯函数，可单测） ===== */

/// 对端 id 编码：`dm:<channel_id>`。
///
/// 渲染端把 peer_id 原样还回来，宿主据此拼回发路径；前缀让「未知来源的 id」在解析阶段
/// 就被挡住，而不是等拼进 URL 才发现不对。
pub fn encode_peer(channel_id: &str) -> String {
    format!("dm:{channel_id}")
}

/// 解码对端 id：必须是 `dm:` 前缀 + 纯十进制雪花 id。
pub fn decode_peer(peer_id: &str) -> Option<String> {
    let channel_id = peer_id.strip_prefix("dm:")?;
    is_snowflake(channel_id).then(|| channel_id.to_string())
}

/// 雪花 id：非空、整数、长度有上限（拼 URL 路径用，必须收口）。
pub fn is_snowflake(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= MAX_SNOWFLAKE_CHARS
        && value.chars().all(|item| item.is_ascii_digit())
}

/// bot token 形状：`<段>.<段>.<段>`，base64url 字符集。
///
/// 只做形状检查（离线可判），有效性由保存时的 `/users/@me` 探针确认。
pub fn is_valid_token(token: &str) -> bool {
    let token = token.trim();
    if token.is_empty() || token.chars().count() > MAX_TOKEN_CHARS {
        return false;
    }
    let parts: Vec<&str> = token.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|part| {
            part.chars().count() >= 6
                && part
                    .chars()
                    .all(|item| item.is_ascii_alphanumeric() || item == '-' || item == '_')
        })
}

/// 一条入站消息的归一形状。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiscordInboundDto {
    pub message_id: String,
    /// 对端 id（`dm:<channel_id>`）。
    pub peer_id: String,
    /// 发送者展示名（全局名 → 用户名 → 用户 id）。
    pub nick: String,
    /// 发送者用户 id（判归属人用）。
    pub sender_id: String,
    pub text: String,
    /// 随消息到达的图片 / 视频 / 语音 / 文件；字节在宿主 inbox，凭 `path` 取走。
    pub media: Vec<MediaRefDto>,
    pub at: i64,
}

/// 归一后的入站草稿：附件还是「待下载」的 CDN 直链，等异步取字节落盘后再产 DTO。
#[derive(Debug, Clone)]
pub(crate) struct DiscordInboundDraft {
    pub message_id: String,
    pub peer_id: String,
    pub nick: String,
    pub sender_id: String,
    pub text: String,
    pub at: i64,
    pub media: Vec<PendingAttachment>,
}

/// 待下载的一条入站附件（Discord 给的是带签名的 CDN 直链，直接 GET）。
#[derive(Debug, Clone)]
pub(crate) struct PendingAttachment {
    pub(super) url: String,
    pub(super) kind: MediaKind,
    pub(super) name: String,
    pub(super) declared_size: Option<u64>,
}

/// 归一条 dispatch 事件；不认识的 `t`、服务器消息、机器人消息、空正文且无附件都返回 None。
pub(crate) fn normalize_dispatch(
    event: &str,
    data: &serde_json::Value,
    received_at: i64,
) -> Option<DiscordInboundDraft> {
    if event != "MESSAGE_CREATE" {
        return None;
    }
    let payload: MessagePayload = serde_json::from_value(data.clone()).ok()?;
    if payload.id.trim().is_empty() || !is_snowflake(payload.channel_id.trim()) {
        return None;
    }
    // 服务器频道（含群里 @ 机器人）：本通道只做私聊。
    if payload
        .guild_id
        .as_deref()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
    {
        return None;
    }
    if payload.author.bot || payload.author.id.trim().is_empty() {
        return None;
    }
    let media = pending_attachments(&payload.attachments);
    // 既没有正文也没有可下载附件（贴纸 / 纯 embed）：丢弃。
    let text = payload.content.trim();
    if text.is_empty() && media.is_empty() {
        return None;
    }
    let nick = payload
        .author
        .global_name
        .clone()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            let username = payload.author.username.trim();
            (!username.is_empty()).then(|| username.to_string())
        })
        .unwrap_or_else(|| payload.author.id.clone());
    Some(DiscordInboundDraft {
        message_id: payload.id,
        peer_id: encode_peer(payload.channel_id.trim()),
        nick,
        sender_id: payload.author.id.trim().to_string(),
        text: text.to_string(),
        at: parse_timestamp(payload.timestamp.as_deref(), received_at),
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
            let name = item.filename.trim();
            let kind = match item.content_type.as_deref() {
                Some(mime) if mime.starts_with("image/") => MediaKind::Image,
                Some(mime) if mime.starts_with("video/") => MediaKind::Video,
                Some(mime) if mime.starts_with("audio/") => MediaKind::Audio,
                _ => kind_by_name(name),
            };
            PendingAttachment {
                url: item.url.trim().to_string(),
                kind,
                name: if name.is_empty() {
                    "attachment".to_string()
                } else {
                    name.to_string()
                },
                declared_size: item.size,
            }
        })
        .collect();
    out.truncate(MAX_INBOUND_MEDIA);
    out
}

/// Discord 时间戳是 RFC3339；解析不出来就用收包时间（不猜）。
pub fn parse_timestamp(raw: Option<&str>, fallback: i64) -> i64 {
    raw.and_then(|value| chrono::DateTime::parse_from_rfc3339(value.trim()).ok())
        .map(|value| value.timestamp_millis())
        .unwrap_or(fallback)
}

/// identify 帧。注意 `token` **不带** `Bot ` 前缀（带前缀是 REST 的用法）。
pub fn identify_frame(token: &str, intents: i64) -> serde_json::Value {
    serde_json::json!({
        "op": 2,
        "d": {
            "token": token,
            "intents": intents,
            "properties": {
                "os": std::env::consts::OS,
                "browser": "greywork",
                "device": "greywork",
            },
        },
    })
}

/// resume 帧：断线后用 `session_id` + 最后事件序号续上，不必重新 identify。
pub fn resume_frame(token: &str, session_id: &str, seq: i64) -> serde_json::Value {
    serde_json::json!({
        "op": 6,
        "d": { "token": token, "session_id": session_id, "seq": seq },
    })
}

/// 心跳帧：`d` 是最后收到的 dispatch 序号，没收到过就 null。
pub fn heartbeat_frame(seq: Option<i64>) -> serde_json::Value {
    serde_json::json!({ "op": 1, "d": seq })
}

/// 网关地址：补上版本与编码（官方建议显式带上）。
///
/// 官方下发的 `url` 没有路径（`wss://gateway.discord.gg`），直接拼 `?` 会得到非法地址，
/// 所以先补 `/`；`resume_gateway_url` 可能自带查询串，那就用 `&` 续在后面。
pub fn gateway_ws_url(base: &str) -> String {
    let base = base.trim();
    let (head, query) = match base.split_once('?') {
        Some((head, query)) => (head, query),
        None => (base, ""),
    };
    let scheme_end = head.find("://").map(|index| index + 3).unwrap_or(0);
    let mut url = head.trim_end_matches('/').to_string();
    // 去掉结尾斜杠后再判「有没有路径」，否则 `host/` 会被判成有路径而少一个 `/`。
    if !url.get(scheme_end..).unwrap_or("").contains('/') {
        url.push('/');
    }
    url.push('?');
    if query.is_empty() {
        url.push_str(&format!("v={API_VERSION}&encoding=json"));
    } else {
        url.push_str(query);
        url.push_str(&format!("&v={API_VERSION}&encoding=json"));
    }
    url
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

/// REST 鉴权头：与 identify 帧不同，这里必须带 `Bot ` 前缀。
pub(super) fn auth_header(token: &str) -> String {
    format!("Bot {token}")
}

/// 断开后该怎么走。
#[derive(Debug, PartialEq)]
pub enum CloseAction {
    /// 按原会话 resume（大多数情况）。
    Resume,
    /// 会话已失效：丢掉 session 重新 identify。
    Reidentify,
    /// 重试无用，必须停下等用户改配置。
    Fatal,
}

/// 关闭码 → 后续动作（官方 close code 表）。
pub fn classify_close(code: Option<u16>) -> CloseAction {
    match code {
        // 我们主动关的：正常收尾，不必重连。
        Some(1000) | Some(1001) => CloseAction::Reidentify,
        // 未知 opcode / 帧解析错误 / 分片参数 / API 版本：客户端的问题，重试无用。
        Some(4001) | Some(4002) | Some(4010) | Some(4011) | Some(4012) => CloseAction::Fatal,
        // 未鉴权 / 重复 identify / seq 失效 / 会话超时 / 会话数超限：重新 identify。
        Some(4003) | Some(4005) | Some(4007) | Some(4009) | Some(4015) | Some(4016) => {
            CloseAction::Reidentify
        }
        // token 无效、intents 被拒：改配置才行。
        Some(4004) | Some(4013) | Some(4014) => CloseAction::Fatal,
        // 4000 未知错误 / 4008 限流 / 无关闭码：隔一会儿 resume。
        _ => CloseAction::Resume,
    }
}

/// 关闭码的中文说明（错误详情给用户看，不能只有数字）。
pub(super) fn close_hint(code: u16) -> &'static str {
    match code {
        4004 => "bot token 无效或已被重置，请到 Discord 开发者门户重新复制",
        4013 => "intents 取值不被接受（本通道只申请 DIRECT_MESSAGES）",
        4014 => "intents 未获许可（本通道只申请 DIRECT_MESSAGES，若持续出现请升级应用）",
        4012 => "网关不接受该 API 版本",
        4010 | 4011 => "网关不接受当前分片参数",
        4001 | 4002 => "协议帧被网关拒绝",
        _ => "原因未知",
    }
}
