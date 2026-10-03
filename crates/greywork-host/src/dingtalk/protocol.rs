use serde::Deserialize;

use crate::channel_media::MediaKind;

use super::*;

/* ===== 协议层：线格式 ===== */

/// 建连响应。
#[derive(Debug, Clone, Deserialize)]
pub struct StreamConnection {
    pub endpoint: String,
    pub ticket: String,
}

/// 服务端帧（JSON 文本）。
#[derive(Debug, Clone, Deserialize)]
pub struct StreamFrame {
    #[serde(default, rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub headers: FrameHeaders,
    /// 业务数据：服务端以**字符串**下发（内容自身是 JSON），这里按原文保留。
    #[serde(default)]
    pub data: String,
}

/// 帧头：只声明本项目要用的两枚（ack 需要 messageId，分流需要 topic），
/// 其余字段（contentType / eventType 等）不声明也不影响反序列化。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameHeaders {
    #[serde(default)]
    pub message_id: Option<String>,
    #[serde(default)]
    pub topic: Option<String>,
}

/// 机器人消息载荷（`data` 里的 JSON）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatbotMessage {
    #[serde(default)]
    pub msg_id: Option<String>,
    /// 企业内员工 id：回消息 `at` 与「只答复本人」判定都用它。
    #[serde(default)]
    pub sender_staff_id: Option<String>,
    #[serde(default)]
    pub sender_nick: Option<String>,
    #[serde(default)]
    pub conversation_id: Option<String>,
    /// "1" = 单聊，"2" = 群聊。
    #[serde(default)]
    pub conversation_type: Option<String>,
    /// 机器人回消息用的临时 webhook（约 30 分钟有效）。
    #[serde(default)]
    pub session_webhook: Option<String>,
    #[serde(default)]
    pub session_webhook_expired_time: Option<i64>,
    #[serde(default)]
    pub create_at: Option<i64>,
    #[serde(default)]
    pub msgtype: Option<String>,
    #[serde(default)]
    pub text: Option<MessageText>,
    /// 机器人编码（换下载链接要带它；自定义机器人没有这个字段）。
    #[serde(default)]
    pub robot_code: Option<String>,
    /// 图片 / 语音 / 视频 / 文件的临时下载码（顶层字段，与 msgtype 平级）。
    #[serde(default)]
    pub download_code: Option<String>,
    /// 文件消息的文件名。
    #[serde(default)]
    pub file_name: Option<String>,
    /// 富文本消息的 `content`（里面可能有 richText 图片列表）。
    #[serde(default)]
    pub content: Option<serde_json::Value>,
    /// 富文本消息的 richText 列表（有的下发形状把它放在顶层）。
    #[serde(default)]
    pub rich_text: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct MessageText {
    #[serde(default)]
    pub content: Option<String>,
}

/// 取 accessToken 的响应。
#[derive(Debug, Clone, Default, Deserialize)]
pub(super) struct AccessTokenResponse {
    #[serde(default, rename = "accessToken")]
    pub(super) access_token: Option<String>,
    #[serde(default, rename = "expireIn")]
    pub(super) expire_in: Option<i64>,
    #[serde(default)]
    pub(super) message: Option<String>,
}

/// 换下载链接的响应。
#[derive(Debug, Clone, Default, Deserialize)]
pub(super) struct DownloadUrlResponse {
    #[serde(default, rename = "downloadUrl")]
    pub(super) download_url: Option<String>,
}

impl ChatbotMessage {
    /// 联系人标识：优先员工 id（单聊稳定），退回落会话 id（群聊只有一个主体）。
    pub fn peer_key(&self) -> Option<String> {
        self.sender_staff_id
            .as_deref()
            .or(self.conversation_id.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    }

    pub fn display_nick(&self) -> String {
        self.sender_nick
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("钉钉联系人")
            .to_string()
    }

    /// 文本内容（钉钉群聊 @机器人 时正文里会带 @昵称 前缀，剥掉它更好读）。
    pub fn body_text(&self) -> String {
        let raw = self
            .text
            .as_ref()
            .and_then(|text| text.content.as_deref())
            .unwrap_or_default()
            .trim();
        let stripped = raw
            .strip_prefix('@')
            .and_then(|rest| {
                rest.find(char::is_whitespace)
                    .map(|index| &rest[index + 1..])
            })
            .unwrap_or(raw);
        stripped.trim().to_string()
    }

    /// 本条消息里可下载的媒体（类别 + 下载码）：picture / video / audio / file 的顶层下载码，
    /// 加上富文本里的图片项，最多 4 条。
    ///
    /// 钉钉的富文本下发形状有两种（`content.richText` 或顶层 `richText`），都兼容。
    /// 群聊里用户往往 @ 不到机器人、消息里也不带 `download_code`，此时按空值过滤掉（仅单聊可靠）。
    pub fn pending_media(&self) -> Vec<(MediaKind, String)> {
        let mut out = Vec::new();
        let kind = match self.msgtype.as_deref() {
            Some("picture") => Some(MediaKind::Image),
            Some("video") => Some(MediaKind::Video),
            Some("audio") => Some(MediaKind::Audio),
            Some("file") => Some(MediaKind::File),
            _ => None,
        };
        if let (Some(kind), Some(code)) = (kind, self.top_download_code()) {
            out.push((kind, code));
        }
        if self.msgtype.as_deref() == Some("richText") {
            for item in self.rich_text_items() {
                if let Some(code) = rich_text_image_code(&item) {
                    out.push((MediaKind::Image, code));
                }
            }
        }
        out.truncate(MAX_INBOUND_MEDIA);
        out
    }

    /// 顶层下载码：空串 / 纯空白视为没有。
    fn top_download_code(&self) -> Option<String> {
        self.download_code
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    }

    /// 富文本项列表：优先顶层 `richText`，否则取 `content.richText`。
    fn rich_text_items(&self) -> Vec<serde_json::Value> {
        if let Some(items) = self.rich_text.clone() {
            return items;
        }
        self.content
            .as_ref()
            .and_then(|content| content.get("richText"))
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default()
    }
}

/// 富文本项里的图片下载码：兼容 `{downloadCode}` 与 `{picture:{downloadCode}}` 两种形状。
fn rich_text_image_code(item: &serde_json::Value) -> Option<String> {
    item.get("downloadCode")
        .or_else(|| {
            item.get("picture")
                .and_then(|picture| picture.get("downloadCode"))
        })
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/* ===== 协议层：请求构造 ===== */

/// wss 地址 + ticket（ticket 需要百分号编码后拼进查询串）。
pub fn stream_url(endpoint: &str, ticket: &str) -> String {
    format!(
        "{}?ticket={}",
        endpoint.trim_end_matches('?'),
        percent_encode(ticket)
    )
}

pub(super) fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        let unreserved = byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~');
        if unreserved {
            out.push(*byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// 建连请求体（与官方 SDK 同形：只要订阅表里有机器人 topic，服务端就会推消息）。
pub fn open_body(client_id: &str, client_secret: &str) -> serde_json::Value {
    serde_json::json!({
        "clientId": client_id,
        "clientSecret": client_secret,
        "subscriptions": [{ "type": "CALLBACK", "topic": CHATBOT_TOPIC }],
        "ua": UA,
    })
}

/// 解析服务端帧。
pub fn parse_frame(raw: &str) -> Result<StreamFrame, String> {
    serde_json::from_str::<StreamFrame>(raw).map_err(|error| format!("帧解析失败: {error}"))
}

/// 帧 ack：同一 messageId 回执，`data` 是字符串化的 JSON。
pub fn ack_payload(message_id: &str) -> String {
    serde_json::json!({
        "code": 200,
        "headers": { "messageId": message_id, "contentType": "application/json" },
        "message": "OK",
        "data": "{}",
    })
    .to_string()
}

/// 回消息请求体（官方 SDK 用 text + at；群里 @ 一下发送者更自然）。
pub fn reply_body(text: &str, staff_id: Option<&str>) -> serde_json::Value {
    let mut at = serde_json::Map::new();
    if let Some(staff_id) = staff_id.filter(|value| !value.trim().is_empty()) {
        at.insert("atUserIds".into(), serde_json::json!([staff_id]));
    }
    serde_json::json!({ "msgtype": "text", "text": { "content": text }, "at": at })
}

pub async fn open_stream(
    client: &reqwest::Client,
    client_id: &str,
    client_secret: &str,
) -> Result<StreamConnection, String> {
    let response = client
        .post(STREAM_OPEN_URL)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .json(&open_body(client_id, client_secret))
        .timeout(API_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("建连请求失败: {error}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("建连响应读取失败: {error}"))?;
    if !status.is_success() {
        return Err(format!("建连失败 HTTP {status}: {}", brief(&text)));
    }
    serde_json::from_str::<StreamConnection>(&text)
        .map_err(|error| format!("建连响应解析失败: {error}"))
}

/// 用 sessionWebhook 回一条文本。
pub async fn reply_via_webhook(
    client: &reqwest::Client,
    webhook: &str,
    text: &str,
    staff_id: Option<&str>,
) -> Result<(), String> {
    let response = client
        .post(webhook)
        .header("Content-Type", "application/json")
        .json(&reply_body(text, staff_id))
        .timeout(API_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("发送消息失败: {error}"))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("发送失败 HTTP {status}: {}", brief(&body)));
    }
    Ok(())
}

/// 响应体截断：错误信息进日志与界面，不把整段响应塞进去。
pub(super) fn brief(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= 200 {
        return trimmed.to_string();
    }
    let head: String = trimmed.chars().take(200).collect();
    format!("{head}…")
}
