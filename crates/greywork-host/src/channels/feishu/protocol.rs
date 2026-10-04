use serde::Deserialize;

use crate::channel_media::MediaKind;

use super::*;

/* ===== 协议层：protobuf 帧 ===== */

/// `pbbp2.Frame`（只保留本项目用得到的字段，字段号对齐官方 pb.go）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Frame {
    pub seq_id: u64,
    pub log_id: u64,
    pub service: i32,
    pub method: i32,
    pub headers: Vec<(String, String)>,
    pub payload_encoding: String,
    pub payload_type: String,
    pub payload: Vec<u8>,
}

impl Frame {
    /// 取 header（同名取第一个）。
    pub fn header(&self, key: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_str())
    }

    pub fn set_header(&mut self, key: &str, value: &str) {
        match self.headers.iter_mut().find(|(name, _)| name == key) {
            Some(entry) => entry.1 = value.to_string(),
            None => self.headers.push((key.to_string(), value.to_string())),
        }
    }

    /// 编码：只写有值的字段（proto2 的 req 字段在 Go 侧同样按需写）。
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(64 + self.payload.len());
        if self.seq_id != 0 {
            write_varint_field(&mut out, 1, self.seq_id);
        }
        if self.log_id != 0 {
            write_varint_field(&mut out, 2, self.log_id);
        }
        if self.service != 0 {
            write_varint_field(&mut out, 3, self.service as u64);
        }
        if self.method != 0 {
            write_varint_field(&mut out, 4, self.method as u64);
        }
        for (key, value) in &self.headers {
            let mut header = Vec::new();
            write_bytes_field(&mut header, 1, key.as_bytes());
            write_bytes_field(&mut header, 2, value.as_bytes());
            write_bytes_field(&mut out, 5, &header);
        }
        if !self.payload_encoding.is_empty() {
            write_bytes_field(&mut out, 6, self.payload_encoding.as_bytes());
        }
        if !self.payload_type.is_empty() {
            write_bytes_field(&mut out, 7, self.payload_type.as_bytes());
        }
        if !self.payload.is_empty() {
            write_bytes_field(&mut out, 8, &self.payload);
        }
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Frame, String> {
        let mut frame = Frame::default();
        let mut cursor = 0usize;
        while cursor < bytes.len() {
            let key = read_varint(bytes, &mut cursor)?;
            let field = key >> 3;
            let wire = (key & 0x7) as u8;
            match (field, wire) {
                (1, 0) => frame.seq_id = read_varint(bytes, &mut cursor)?,
                (2, 0) => frame.log_id = read_varint(bytes, &mut cursor)?,
                (3, 0) => frame.service = read_varint(bytes, &mut cursor)? as i32,
                (4, 0) => frame.method = read_varint(bytes, &mut cursor)? as i32,
                (5, 2) => {
                    let raw = read_bytes(bytes, &mut cursor)?;
                    frame.headers.push(decode_header(&raw)?);
                }
                (6, 2) => {
                    frame.payload_encoding =
                        String::from_utf8_lossy(&read_bytes(bytes, &mut cursor)?).into_owned()
                }
                (7, 2) => {
                    frame.payload_type =
                        String::from_utf8_lossy(&read_bytes(bytes, &mut cursor)?).into_owned()
                }
                (8, 2) => frame.payload = read_bytes(bytes, &mut cursor)?,
                // 未知字段按 wire type 跳过（兼容服务端后续新增字段）。
                (_, 0) => {
                    read_varint(bytes, &mut cursor)?;
                }
                (_, 2) => {
                    read_bytes(bytes, &mut cursor)?;
                }
                (_, 5) => {
                    cursor += 4;
                }
                (_, 1) => {
                    cursor += 8;
                }
                (_, other) => return Err(format!("不支持的 wire type: {other}")),
            }
        }
        Ok(frame)
    }
}

fn decode_header(bytes: &[u8]) -> Result<(String, String), String> {
    let mut cursor = 0usize;
    let mut key = String::new();
    let mut value = String::new();
    while cursor < bytes.len() {
        let tag = read_varint(bytes, &mut cursor)?;
        let field = tag >> 3;
        match field {
            1 => key = String::from_utf8_lossy(&read_bytes(bytes, &mut cursor)?).into_owned(),
            2 => value = String::from_utf8_lossy(&read_bytes(bytes, &mut cursor)?).into_owned(),
            _ => {
                // 未知字段：按 wire type 跳过（header 只有 1/2 两个 string 字段）。
                if (tag & 0x7) as u8 == 2 {
                    read_bytes(bytes, &mut cursor)?;
                } else {
                    read_varint(bytes, &mut cursor)?;
                }
            }
        }
    }
    Ok((key, value))
}

fn write_varint(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

pub(super) fn write_varint_field(out: &mut Vec<u8>, field: u64, value: u64) {
    write_varint(out, field << 3);
    write_varint(out, value);
}

pub(super) fn write_bytes_field(out: &mut Vec<u8>, field: u64, value: &[u8]) {
    write_varint(out, (field << 3) | 2);
    write_varint(out, value.len() as u64);
    out.extend_from_slice(value);
}

fn read_varint(bytes: &[u8], cursor: &mut usize) -> Result<u64, String> {
    let mut result = 0u64;
    let mut shift = 0u32;
    loop {
        let Some(byte) = bytes.get(*cursor) else {
            return Err("varint 越界".into());
        };
        *cursor += 1;
        result |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Ok(result);
        }
        shift += 7;
        if shift >= 64 {
            return Err("varint 过长".into());
        }
    }
}

fn read_bytes(bytes: &[u8], cursor: &mut usize) -> Result<Vec<u8>, String> {
    let length = read_varint(bytes, cursor)? as usize;
    let end = cursor.checked_add(length).ok_or("长度溢出")?;
    if end > bytes.len() {
        return Err("字段越界".into());
    }
    let slice = bytes[*cursor..end].to_vec();
    *cursor = end;
    Ok(slice)
}

/* ===== 协议层：事件与上行 ===== */

/// 长连接入口响应。
#[derive(Debug, Clone, Deserialize)]
pub struct EndpointResponse {
    #[serde(default)]
    pub code: i64,
    #[serde(default)]
    pub msg: Option<String>,
    #[serde(default)]
    pub data: Option<EndpointData>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EndpointData {
    #[serde(rename = "URL", default)]
    pub url: String,
    #[serde(rename = "ClientConfig", default)]
    pub client_config: Option<ClientConfig>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct ClientConfig {
    #[serde(default)]
    pub reconnect_count: i64,
    #[serde(default)]
    pub reconnect_interval: i64,
    #[serde(default)]
    pub reconnect_nonce: i64,
    #[serde(default)]
    pub ping_interval: i64,
}

/// 机器人消息事件（`im.message.receive_v1`）里我们关心的字段。
#[derive(Debug, Clone, Deserialize)]
pub struct MessageEvent {
    #[serde(default)]
    pub header: EventHeader,
    #[serde(default)]
    pub event: EventBody,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct EventHeader {
    #[serde(default)]
    pub event_id: Option<String>,
    #[serde(default)]
    pub event_type: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct EventBody {
    #[serde(default)]
    pub sender: Option<EventSender>,
    #[serde(default)]
    pub message: Option<EventMessage>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct EventSender {
    #[serde(default)]
    pub sender_id: Option<SenderId>,
    #[serde(default)]
    pub sender_type: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct SenderId {
    #[serde(default)]
    pub open_id: Option<String>,
    #[serde(default)]
    pub union_id: Option<String>,
    /// 企业内可见的 user_id（同一租户内稳定）。
    #[serde(default)]
    pub user_id: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct EventMessage {
    #[serde(default)]
    pub message_id: Option<String>,
    #[serde(default)]
    pub chat_id: Option<String>,
    /// "p2p" 单聊 / "group" 群聊。
    #[serde(default)]
    pub chat_type: Option<String>,
    #[serde(default)]
    pub message_type: Option<String>,
    /// 内容本身是字符串化的 JSON（文本消息形如 `{"text":"…"}`）。
    #[serde(default)]
    pub content: Option<String>,
}

/// 文本内容：`{"text":"…"}`；解析失败按空串处理（不把整段 JSON 喂给模型）。
pub fn message_text(message: &EventMessage) -> String {
    let Some(content) = message
        .content
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    else {
        return String::new();
    };
    let parsed: serde_json::Value = match serde_json::from_str(content) {
        Ok(value) => value,
        Err(_) => return String::new(),
    };
    parsed
        .get("text")
        .and_then(|value| value.as_str())
        .map(|text| text.trim().to_string())
        .unwrap_or_default()
}

/// 待下载的一条入站媒体：飞书给的是 file_key / image_key，字节要经 `resources` 端点取回。
#[derive(Debug, Clone)]
pub(crate) struct PendingMedia {
    pub(super) kind: MediaKind,
    pub(super) name: String,
    /// 资源类型（`image` / `file`）——下载端点的 `type` 参数。
    pub(super) resource_type: &'static str,
    pub(super) file_key: String,
}

/// 从消息 content 里抽出可下载的媒体（按 message_type 分叉；text / post 等返回空）。
pub(crate) fn content_media(message: &EventMessage) -> Vec<PendingMedia> {
    let message_type = message.message_type.as_deref().unwrap_or("text");
    let Some(content) = message
        .content
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(content) else {
        return Vec::new();
    };
    let field = |key: &str| {
        parsed
            .get(key)
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    let item = match message_type {
        "image" => field("image_key").map(|file_key| PendingMedia {
            kind: MediaKind::Image,
            name: "image".into(),
            resource_type: "image",
            file_key,
        }),
        "file" => field("file_key").map(|file_key| PendingMedia {
            kind: MediaKind::File,
            name: field("file_name").unwrap_or_else(|| "file".into()),
            resource_type: "file",
            file_key,
        }),
        "audio" => field("file_key").map(|file_key| PendingMedia {
            kind: MediaKind::Audio,
            name: "audio".into(),
            resource_type: "file",
            file_key,
        }),
        "media" => field("file_key").map(|file_key| PendingMedia {
            kind: MediaKind::Video,
            name: field("file_name").unwrap_or_else(|| "video".into()),
            resource_type: "file",
            file_key,
        }),
        _ => None,
    };
    item.into_iter().take(MAX_INBOUND_MEDIA).collect()
}

impl MessageEvent {
    /// 联系人标识：单聊用发送者 open_id（回消息也用它），群聊退到 chat_id（群是同一主体）。
    pub fn peer_key(&self) -> Option<String> {
        let message = self.event.message.as_ref()?;
        let chat_type = message.chat_type.as_deref().unwrap_or("p2p");
        if chat_type == "p2p" {
            return self
                .event
                .sender
                .as_ref()
                .and_then(|sender| sender.sender_id.as_ref())
                .and_then(|ids| ids.open_id.as_deref())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
        }
        message
            .chat_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    }

    /// 回消息的接收方类型与 id：单聊 open_id，群聊 chat_id。
    pub fn reply_target(&self) -> Option<(&'static str, String)> {
        let message = self.event.message.as_ref()?;
        let chat_type = message.chat_type.as_deref().unwrap_or("p2p");
        if chat_type == "p2p" {
            let open_id = self
                .event
                .sender
                .as_ref()
                .and_then(|sender| sender.sender_id.as_ref())
                .and_then(|ids| ids.open_id.as_deref())
                .unwrap_or_default()
                .trim()
                .to_string();
            return (!open_id.is_empty()).then_some(("open_id", open_id));
        }
        let chat_id = message
            .chat_id
            .as_deref()
            .unwrap_or_default()
            .trim()
            .to_string();
        (!chat_id.is_empty()).then_some(("chat_id", chat_id))
    }

    pub fn display_nick(&self) -> String {
        // 事件里不带昵称：用 id 的短形做展示名（远端会话页可读即可）。
        self.peer_key()
            .map(|key| short_id(&key))
            .unwrap_or_else(|| "飞书联系人".into())
    }
}

/// `ou_xxx` / `oc_xxx` → 展示短名。
pub fn short_id(value: &str) -> String {
    if value.chars().count() <= 12 {
        return value.to_string();
    }
    let head: String = value.chars().take(12).collect();
    format!("{head}…")
}

/// 长连接入口请求体（官方 SDK：AppID/AppSecret；也可选 ClientAssertion，本项目用密钥）。
pub fn endpoint_body(app_id: &str, app_secret: &str) -> serde_json::Value {
    serde_json::json!({ "AppID": app_id, "AppSecret": app_secret })
}

/// 数据帧的 ack 载荷（官方 Response：code/headers/data）。
pub fn ack_payload() -> Vec<u8> {
    serde_json::json!({ "code": 200, "headers": {}, "data": null })
        .to_string()
        .into_bytes()
}

/// 上行消息体：`content` 统一是字符串化的 JSON（官方要求）。
pub fn message_body(
    receive_id: &str,
    msg_type: &str,
    content: &serde_json::Value,
) -> serde_json::Value {
    serde_json::json!({
        "receive_id": receive_id,
        "msg_type": msg_type,
        "content": content.to_string(),
    })
}

/// 文本消息的上行内容：飞书要求 content 是字符串化的 JSON。
pub fn text_message_body(receive_id: &str, text: &str) -> serde_json::Value {
    message_body(receive_id, "text", &serde_json::json!({ "text": text }))
}
