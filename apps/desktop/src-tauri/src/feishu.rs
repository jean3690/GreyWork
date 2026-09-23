//! 飞书通道：自建应用 + 长连接（WebSocket）事件订阅。
//!
//! 与钉钉 Stream 同属「客户端主动连出」的收消息方式：不需要公网回调地址，也不需要
//! 在开放平台填写请求网址。差别在协议细节：
//! 1. `POST /callback/ws/endpoint`（AppID/AppSecret）→ `{data:{URL, ClientConfig}}`
//! 2. 连接 `wss://…`；帧是 **protobuf**（`pbbp2.Frame`：SeqID/LogID/service/method/headers/payload），
//!    `method=0` 是控制帧（客户端发 ping，服务端回 pong，pong 里可能带新的 ClientConfig），
//!    `method=1` 是数据帧（headers.type=event，payload 是事件 JSON）
//! 3. 每个数据帧都要在 3 秒内回一个「同 SeqID + 复制 headers + 追加 biz_rt」的 ack 帧，
//!    payload 是 `{"code":200,…}`；长于一个包的消息按 `sum/seq` 分片，要拼回去
//! 4. 发消息走 HTTP：先换 `tenant_access_token`，再调 `im/v1/messages`
//!
//! 本文件里的 protobuf 只覆盖这两个消息、手写 varint 编解码 —— 为一个已知的小协议
//! 引整个 prost 代码生成不划算，字段号与官方 `pbbp2.pb.go` 一一对应。
//!
//! 安全口径：AppSecret 只落宿主数据目录（`feishu/credentials.json`，0600）；
//! 渲染端拿不到密钥，也拿不到 tenant token。

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::SinkExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message;

use crate::channel_common::{
    app_sink, channel_dir, now_ms, read_json, sleep_or_stop, write_private, EventSink,
};
use crate::channel_media::{
    inbox_dir, prune_inbox, store_inbound_media, MediaKind, MediaRefDto, OutboundMedia,
    MAX_MEDIA_BYTES,
};
use crate::log;

/// 默认开放平台域名（可换 Lark 域名，见设置里的说明）。
pub const DEFAULT_DOMAIN: &str = "https://open.feishu.cn";
/// 长连接入口路径（官方 SDK 的 GenEndpointUri）。
pub const ENDPOINT_PATH: &str = "/callback/ws/endpoint";
/// 机器人消息事件的 event_type。
pub const MESSAGE_EVENT: &str = "im.message.receive_v1";
/// 普通请求超时。
const API_TIMEOUT: Duration = Duration::from_secs(15);
/// 服务端没下发 PingInterval 时的兜底（官方默认 2 分钟）。
const DEFAULT_PING_INTERVAL: Duration = Duration::from_secs(120);
/// 收不到任何帧的容忍窗口（官方 pongWait = 2 × pingInterval + 5s）。
const PONG_GRACE: Duration = Duration::from_secs(5);
/// 分片重组缓存上限与 TTL。
const FRAGMENT_LIMIT: usize = 32;
const FRAGMENT_TTL: Duration = Duration::from_secs(5);
/// 单条消息最多收几条媒体（防止一条消息拖垮一整轮下载）。
const MAX_INBOUND_MEDIA: usize = 4;
/// 重连退避上限。
const RECONNECT_MAX_DELAY: Duration = Duration::from_secs(60);

pub const STATE_EVENT: &str = "feishu://state";
pub const INBOUND_EVENT: &str = "feishu://inbound";

const CREDENTIALS_FILE: &str = "credentials.json";
const PEERS_FILE: &str = "peers.json";
const DIR_NAME: &str = "feishu";

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

fn write_varint_field(out: &mut Vec<u8>, field: u64, value: u64) {
    write_varint(out, field << 3);
    write_varint(out, value);
}

fn write_bytes_field(out: &mut Vec<u8>, field: u64, value: &[u8]) {
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
    kind: MediaKind,
    name: String,
    /// 资源类型（`image` / `file`）——下载端点的 `type` 参数。
    resource_type: &'static str,
    file_key: String,
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

pub async fn fetch_endpoint(
    client: &reqwest::Client,
    domain: &str,
    app_id: &str,
    app_secret: &str,
) -> Result<EndpointData, String> {
    let url = format!("{}{ENDPOINT_PATH}", domain.trim_end_matches('/'));
    let response = client
        .post(&url)
        .header("locale", "zh")
        .header("Content-Type", "application/json")
        .json(&endpoint_body(app_id, app_secret))
        .timeout(API_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("长连接入口请求失败: {error}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("长连接入口响应读取失败: {error}"))?;
    if !status.is_success() {
        return Err(format!("长连接入口 HTTP {status}: {}", brief(&text)));
    }
    let parsed: EndpointResponse = serde_json::from_str(&text)
        .map_err(|error| format!("长连接入口解析失败: {error}: {}", brief(&text)))?;
    if parsed.code != 0 {
        return Err(format!(
            "长连接入口业务失败 code={} msg={}",
            parsed.code,
            parsed.msg.unwrap_or_default()
        ));
    }
    parsed
        .data
        .filter(|data| !data.url.trim().is_empty())
        .ok_or_else(|| "长连接入口未返回 URL".to_string())
}

/// 换 tenant_access_token（发消息用）。
pub async fn tenant_access_token(
    client: &reqwest::Client,
    domain: &str,
    app_id: &str,
    app_secret: &str,
) -> Result<String, String> {
    let url = format!(
        "{}/open-apis/auth/v3/tenant_access_token/internal",
        domain.trim_end_matches('/')
    );
    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "app_id": app_id, "app_secret": app_secret }))
        .timeout(API_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("换取 token 失败: {error}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("token 响应读取失败: {error}"))?;
    if !status.is_success() {
        return Err(format!("换取 token HTTP {status}: {}", brief(&text)));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&text).map_err(|error| format!("token 响应解析失败: {error}"))?;
    let code = parsed
        .get("code")
        .and_then(|value| value.as_i64())
        .unwrap_or(-1);
    if code != 0 {
        let message = parsed
            .get("msg")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        return Err(format!("换取 token 失败 code={code} msg={message}"));
    }
    parsed
        .get("tenant_access_token")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "token 响应缺少 tenant_access_token".to_string())
}

/// 发一条文本消息。
pub async fn send_text(
    client: &reqwest::Client,
    domain: &str,
    token: &str,
    receive_id_type: &str,
    receive_id: &str,
    text: &str,
) -> Result<(), String> {
    send_message(
        client,
        domain,
        token,
        receive_id_type,
        text_message_body(receive_id, text),
    )
    .await
}

/// 发一条消息（body 已按 msg_type 组装好）；文本与媒体共用同一条 REST 路径。
async fn send_message(
    client: &reqwest::Client,
    domain: &str,
    token: &str,
    receive_id_type: &str,
    body: serde_json::Value,
) -> Result<(), String> {
    let url = format!(
        "{}/open-apis/im/v1/messages?receive_id_type={receive_id_type}",
        domain.trim_end_matches('/')
    );
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .json(&body)
        .timeout(API_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("发送消息失败: {error}"))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("发送失败 HTTP {status}: {}", brief(&body)));
    }
    check_code(&body, "发送")?;
    Ok(())
}

/// 校验飞书统一响应体：`code != 0` 一律当失败（把 msg 带出去），成功则回解析后的 JSON。
fn check_code(body: &str, action: &str) -> Result<serde_json::Value, String> {
    let parsed: serde_json::Value =
        serde_json::from_str(body).map_err(|error| format!("{action}响应解析失败: {error}"))?;
    let code = parsed
        .get("code")
        .and_then(|value| value.as_i64())
        .unwrap_or(-1);
    if code != 0 {
        let message = parsed
            .get("msg")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        return Err(format!("{action}失败 code={code} msg={message}"));
    }
    Ok(parsed)
}

/// 上传图片（`im/v1/images`）→ image_key。
async fn upload_image(
    client: &reqwest::Client,
    domain: &str,
    token: &str,
    bytes: Vec<u8>,
    name: String,
) -> Result<String, String> {
    let url = format!("{}/open-apis/im/v1/images", domain.trim_end_matches('/'));
    let part = reqwest::multipart::Part::bytes(bytes).file_name(name);
    let form = reqwest::multipart::Form::new()
        .text("image_type", "message")
        .part("image", part);
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {token}"))
        .multipart(form)
        .timeout(API_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("上传图片失败: {error}"))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("上传图片 HTTP {status}: {}", brief(&body)));
    }
    let parsed = check_code(&body, "上传图片")?;
    parsed
        .get("data")
        .and_then(|data| data.get("image_key"))
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "上传图片响应缺少 image_key".to_string())
}

/// 上传文件（`im/v1/files`）→ file_key。
async fn upload_file(
    client: &reqwest::Client,
    domain: &str,
    token: &str,
    bytes: Vec<u8>,
    name: &str,
) -> Result<String, String> {
    let url = format!("{}/open-apis/im/v1/files", domain.trim_end_matches('/'));
    let part = reqwest::multipart::Part::bytes(bytes).file_name(name.to_string());
    let form = reqwest::multipart::Form::new()
        .text("file_type", "stream")
        .text("file_name", name.to_string())
        .part("file", part);
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {token}"))
        .multipart(form)
        .timeout(API_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("上传文件失败: {error}"))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("上传文件 HTTP {status}: {}", brief(&body)));
    }
    let parsed = check_code(&body, "上传文件")?;
    parsed
        .get("data")
        .and_then(|data| data.get("file_key"))
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "上传文件响应缺少 file_key".to_string())
}

/// 发一条媒体：图片先传 `im/v1/images` 换 image_key，文件先传 `im/v1/files` 换 file_key，
/// 再以 `msg_type=image|file` 发出去（飞书没有「一步直传」的消息接口）。
pub(crate) async fn send_media_impl(
    app: &AppHandle,
    peer_id: &str,
    media: OutboundMedia,
) -> Result<(), String> {
    let (credentials, record) = {
        let host = app.state::<FeishuHost>();
        let mut inner = host.lock().await;
        ensure_loaded(app, &mut inner)?;
        let credentials = inner.credentials.clone().ok_or("尚未配置飞书应用凭证")?;
        let record = inner
            .peers
            .target(peer_id)
            .cloned()
            .ok_or("会话信息不可用：等对方再发一条消息")?;
        (credentials, record)
    };
    let client = crate::http::shared_client(10)?;
    let token = tenant_access_token(
        &client,
        DEFAULT_DOMAIN,
        &credentials.app_id,
        &credentials.app_secret,
    )
    .await?;
    let (msg_type, content) = match media.kind {
        MediaKind::Image => {
            let image_key =
                upload_image(&client, DEFAULT_DOMAIN, &token, media.bytes, media.name).await?;
            ("image", serde_json::json!({ "image_key": image_key }))
        }
        // 视频 / 语音无原生出站端点（media 需封面、audio 需 opus），共享层已降级为文件。
        MediaKind::Video | MediaKind::Audio | MediaKind::File => {
            let file_key =
                upload_file(&client, DEFAULT_DOMAIN, &token, media.bytes, &media.name).await?;
            ("file", serde_json::json!({ "file_key": file_key }))
        }
    };
    send_message(
        &client,
        DEFAULT_DOMAIN,
        &token,
        &record.receive_id_type,
        message_body(&record.receive_id, msg_type, &content),
    )
    .await
}

fn brief(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= 200 {
        return trimmed.to_string();
    }
    let head: String = trimmed.chars().take(200).collect();
    format!("{head}…")
}

/* ===== 扫码创建应用（设备授权流程） =====
 *
 * 与「用户已在开放平台建好应用」的手填路径并列的另一条入口：手机飞书扫码 → 确认 →
 * 服务端直接把 AppID/AppSecret 交给宿主，用户不必去控制台抄两串密钥。
 *
 * 协议（官方 Go SDK `scene/registration` 的同一套，表单走 x-www-form-urlencoded）：
 * 1. `POST https://accounts.feishu.cn/oauth/v1/app/registration` `action=begin`
 *    → `{device_code, verification_uri_complete, user_code, interval, expires_in}`
 * 2. `verification_uri_complete` 编成二维码 → 手机扫码确认
 * 3. 每 `interval` 秒 `action=poll&device_code=…`，错误一律用 **HTTP 400 + JSON 体** 表达：
 *    `authorization_pending`（继续等）/ `slow_down`（退避 +5s）/ `access_denied` /
 *    `expired_token` / `invalid_grant`；成功时返回 `client_id` + `client_secret`
 * 4. 国际版租户（`user_info.tenant_brand == "lark"`）要换 `accounts.larksuite.com` 重试
 *
 * 与手填路径一致：密钥只落宿主磁盘（0600），`device_code` 也只留在宿主内存里。
 */

/// 注册入口在 accounts 域（开放平台域没有这个接口）。
pub const ACCOUNTS_DOMAIN: &str = "https://accounts.feishu.cn";
/// 国际版（Lark）租户的注册域。
pub const ACCOUNTS_LARK_DOMAIN: &str = "https://accounts.larksuite.com";
const REGISTRATION_PATH: &str = "/oauth/v1/app/registration";
/// 授权类型：个人 Agent —— 官方扫码流程创建的正是这种自带长连接的机器人应用。
const REGISTRATION_ARCHETYPE: &str = "PersonalAgent";
/// 二维码链接上的来源标记（官方 SDK 也带，便于服务端区分调用方）。
const REGISTRATION_SOURCE: &str = "greywork";
/// 服务端没给 `interval` / `expires_in` 时的兜底（官方 SDK 同值）。
const DEFAULT_POLL_INTERVAL: u64 = 5;
const DEFAULT_EXPIRE_IN: u64 = 600;
/// `slow_down` 时每个间隔增加的量（RFC 8628 / 官方 SDK：+5s）。
const SLOW_DOWN_STEP: u64 = 5;

#[derive(Debug, Clone, Deserialize)]
struct BeginResponse {
    device_code: String,
    verification_uri_complete: String,
    user_code: String,
    #[serde(default)]
    interval: Option<u64>,
    /// 服务端实际返回的是 `expires_in`；官方 Go SDK 读的是 `expire_in`（所以它总是落到兜底值）。
    /// 两个都收，避免跟着丢掉真实有效期。
    #[serde(default)]
    expires_in: Option<u64>,
    #[serde(default)]
    expire_in: Option<u64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct PollResponse {
    #[serde(default)]
    client_id: Option<String>,
    #[serde(default)]
    client_secret: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    error_description: Option<String>,
    #[serde(default)]
    user_info: Option<PollUserInfo>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct PollUserInfo {
    #[serde(default)]
    tenant_brand: Option<String>,
}

/// 一次轮询的判定（纯函数产出，便于单测）。
#[derive(Debug, Clone, PartialEq)]
pub enum PollOutcome {
    /// 还没扫码 / 还没在手机上确认。
    Pending,
    /// 轮询太密，按服务端要求放慢。
    SlowDown,
    /// 国际版租户：换注册域重试。
    SwitchDomain,
    Done {
        app_id: String,
        app_secret: String,
    },
    Denied(String),
    Expired(String),
    Failed(String),
}

/// 进行中的扫码会话（`device_code` 只在宿主内存，与 `begin_registration` 的接口同域）。
#[derive(Debug, Clone)]
pub struct RegisterSession {
    device_code: String,
    domain: String,
    interval: Duration,
    /// 过期时刻（毫秒时间戳），由 `expires_in` 推出。
    expires_at: i64,
    /// 是否已经因国际版租户切过域名（只切一次）。
    switched: bool,
}

/// 扫码引导信息（渲染端只需要这些：把 `qr_url` 编成二维码，显示配对码）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterStartDto {
    pub qr_url: String,
    pub user_code: String,
    pub expires_in: u64,
    pub interval: u64,
}

/// 一次轮询的结果。`state`：pending / done / denied / expired / error。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterPollDto {
    pub state: String,
    pub detail: Option<String>,
    pub app_id: Option<String>,
    /// 服务端要求的轮询间隔（毫秒）；`slow_down` 后会变大，渲染端据此放慢。
    pub interval_ms: Option<u64>,
}

impl PollOutcome {
    fn state(&self) -> &'static str {
        match self {
            PollOutcome::Done { .. } => "done",
            PollOutcome::Denied(_) => "denied",
            PollOutcome::Expired(_) => "expired",
            PollOutcome::Failed(_) => "error",
            PollOutcome::Pending | PollOutcome::SlowDown | PollOutcome::SwitchDomain => "pending",
        }
    }

    fn detail(&self) -> Option<String> {
        match self {
            PollOutcome::Denied(detail)
            | PollOutcome::Expired(detail)
            | PollOutcome::Failed(detail) => {
                let trimmed = detail.trim();
                // 空串交给界面出本地化文案，别把空提示丢上去。
                (!trimmed.is_empty()).then(|| trimmed.to_string())
            }
            _ => None,
        }
    }
}

/// 判定一次轮询响应。顺序与官方 SDK 一致：先看租户归属，再看凭证，最后看错误码。
fn classify_poll(response: &PollResponse) -> PollOutcome {
    let is_lark = response
        .user_info
        .as_ref()
        .and_then(|info| info.tenant_brand.as_deref())
        == Some("lark");
    let app_id = response.client_id.clone().unwrap_or_default();
    let app_secret = response.client_secret.clone().unwrap_or_default();
    if is_lark && (app_id.is_empty() || app_secret.is_empty()) {
        return PollOutcome::SwitchDomain;
    }
    if !app_id.is_empty() && !app_secret.is_empty() {
        return PollOutcome::Done { app_id, app_secret };
    }
    let described = |fallback: &str| {
        let detail = response
            .error_description
            .clone()
            .unwrap_or_default()
            .trim()
            .to_string();
        if detail.is_empty() {
            fallback.to_string()
        } else {
            detail
        }
    };
    match response.error.as_deref() {
        Some("authorization_pending") => PollOutcome::Pending,
        Some("slow_down") => PollOutcome::SlowDown,
        // 拒绝 / 失效的说明文案由界面出（这里只透传服务端给的描述，没给就留空）。
        Some("access_denied") => PollOutcome::Denied(described("")),
        Some("expired_token") | Some("invalid_grant") => PollOutcome::Expired(described("")),
        // 服务端没给错误码也没给凭证时继续等（与官方 SDK 一致，避免把瞬时状态当失败）。
        None | Some("") => PollOutcome::Pending,
        Some(other) => {
            let detail = described("");
            PollOutcome::Failed(if detail.is_empty() {
                other.to_string()
            } else {
                format!("{other}: {detail}")
            })
        }
    }
}

/// 二维码内容：在 `verification_uri_complete` 上补来源标记（官方 SDK 也这么做）。
fn qr_url(verification_uri_complete: &str) -> Result<String, String> {
    let mut parsed = reqwest::Url::parse(verification_uri_complete)
        .map_err(|error| format!("扫码链接解析失败: {error}"))?;
    parsed
        .query_pairs_mut()
        .append_pair("from", "sdk")
        .append_pair("tp", "sdk")
        .append_pair("source", REGISTRATION_SOURCE);
    Ok(parsed.to_string())
}

/// 表单体：官方流程全用 x-www-form-urlencoded。
fn form_body(pairs: &[(&str, &str)]) -> String {
    let mut serializer = form_urlencoded::Serializer::new(String::new());
    for (key, value) in pairs {
        serializer.append_pair(key, value);
    }
    serializer.finish()
}
async fn post_registration(
    client: &reqwest::Client,
    domain: &str,
    pairs: &[(&str, &str)],
) -> Result<String, String> {
    let url = format!("{}{REGISTRATION_PATH}", domain.trim_end_matches('/'));
    let response = client
        .post(&url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(form_body(pairs))
        .timeout(API_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("扫码注册请求失败: {error}"))?;
    let status = response.status();
    let body = crate::http::read_text(response, API_TIMEOUT).await?;
    // 这个接口把「等待中」也表达成 HTTP 400 + JSON 体，所以状态码不能当失败判据；
    // 体不是 JSON 时才是真异常（网关 5xx 页面之类）。
    if serde_json::from_str::<serde_json::Value>(&body).is_err() {
        return Err(format!("扫码注册返回 HTTP {status}: {}", brief(&body)));
    }
    Ok(body)
}

/// 发起扫码：拿回 `device_code`（留宿主）与二维码链接。
pub async fn begin_registration(
    client: &reqwest::Client,
    domain: &str,
) -> Result<(RegisterSession, RegisterStartDto), String> {
    let body = post_registration(
        client,
        domain,
        &[
            ("action", "begin"),
            ("archetype", REGISTRATION_ARCHETYPE),
            ("auth_method", "client_secret"),
            ("request_user_info", "open_id"),
        ],
    )
    .await?;
    let parsed: BeginResponse =
        serde_json::from_str(&body).map_err(|error| format!("扫码注册响应解析失败: {error}"))?;
    if parsed.device_code.trim().is_empty() || parsed.verification_uri_complete.trim().is_empty() {
        return Err("扫码注册响应缺少 device_code / 扫码链接".into());
    }
    let expires_in = parsed
        .expires_in
        .or(parsed.expire_in)
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_EXPIRE_IN);
    let interval = parsed
        .interval
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_POLL_INTERVAL);
    let session = RegisterSession {
        device_code: parsed.device_code,
        domain: domain.to_string(),
        interval: Duration::from_secs(interval),
        expires_at: now_ms() + (expires_in as i64) * 1000,
        switched: false,
    };
    let dto = RegisterStartDto {
        qr_url: qr_url(&parsed.verification_uri_complete)?,
        user_code: parsed.user_code,
        expires_in,
        interval,
    };
    Ok((session, dto))
}

/// 轮询一次。`session` 会被就地更新（轮询间隔 / 域名切换）。
pub async fn poll_registration(
    client: &reqwest::Client,
    session: &mut RegisterSession,
) -> Result<PollOutcome, String> {
    let body = post_registration(
        client,
        &session.domain.clone(),
        &[("action", "poll"), ("device_code", &session.device_code)],
    )
    .await?;
    let parsed: PollResponse =
        serde_json::from_str(&body).map_err(|error| format!("扫码轮询响应解析失败: {error}"))?;
    let outcome = classify_poll(&parsed);
    match outcome {
        PollOutcome::SlowDown => {
            session.interval += Duration::from_secs(SLOW_DOWN_STEP);
            Ok(PollOutcome::Pending)
        }
        PollOutcome::SwitchDomain => {
            // 只切一次：切完还报 lark 就当普通等待，避免在两个域之间来回撞。
            if session.switched {
                return Ok(PollOutcome::Pending);
            }
            session.switched = true;
            session.domain = ACCOUNTS_LARK_DOMAIN.to_string();
            Ok(PollOutcome::Pending)
        }
        other => Ok(other),
    }
}

/* ===== 宿主层：持久化 ===== */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredCredentials {
    pub app_id: String,
    pub app_secret: String,
    #[serde(default)]
    pub saved_at: Option<String>,
}

/// 联系人档案：回消息需要的接收方信息 + 「谁在用这台机器」的归属人。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerBook {
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub peers: BTreeMap<String, PeerRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerRecord {
    /// "open_id" / "chat_id"。
    pub receive_id_type: String,
    pub receive_id: String,
    #[serde(default)]
    pub nick: String,
    #[serde(default)]
    pub last_message_id: Option<String>,
    #[serde(default)]
    pub last_at: i64,
}

impl PeerBook {
    pub fn remember(&mut self, peer: &str, event: &MessageEvent) -> bool {
        let Some((receive_id_type, receive_id)) = event.reply_target() else {
            return false;
        };
        let last_message_id = event
            .event
            .message
            .as_ref()
            .and_then(|message| message.message_id.clone());
        self.peers.insert(
            peer.to_string(),
            PeerRecord {
                receive_id_type: receive_id_type.to_string(),
                receive_id,
                nick: event.display_nick(),
                last_message_id,
                last_at: now_ms(),
            },
        );
        true
    }

    pub fn claim_owner(&mut self, peer: &str) -> bool {
        if self.owner.is_some() {
            return false;
        }
        self.owner = Some(peer.to_string());
        true
    }

    pub fn target(&self, peer: &str) -> Option<&PeerRecord> {
        self.peers.get(peer)
    }
}

/* ===== 宿主层：状态与命令 ===== */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeishuStatusDto {
    pub configured: bool,
    /// AppID（应用凭证里唯一可外露的一半，便于确认填对了）。
    pub app_id: Option<String>,
    pub state: String,
    pub detail: Option<String>,
    pub last_message_at: Option<i64>,
    pub peer_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeishuInboundDto {
    pub message_id: Option<String>,
    pub peer_id: String,
    pub nick: String,
    pub text: String,
    /// text / image / audio …（非文本由界面如实说明）。
    pub message_type: Option<String>,
    pub chat_type: Option<String>,
    /// 随消息到达的图片 / 视频 / 语音 / 文件；字节在宿主 inbox，凭 `path` 取走。
    pub media: Vec<MediaRefDto>,
    pub at: i64,
}

#[derive(Default)]
pub(crate) struct Inner {
    loaded: bool,
    credentials: Option<StoredCredentials>,
    peers: PeerBook,
    state: String,
    detail: Option<String>,
    last_message_at: Option<i64>,
    /// 进行中的扫码创建应用会话（device_code 只在内存里，不落盘）。
    registration: Option<RegisterSession>,
}

impl Inner {
    fn status(&self) -> FeishuStatusDto {
        FeishuStatusDto {
            configured: self.credentials.is_some(),
            app_id: self
                .credentials
                .as_ref()
                .map(|credentials| credentials.app_id.clone()),
            state: if self.state.is_empty() {
                "stopped".into()
            } else {
                self.state.clone()
            },
            detail: self.detail.clone(),
            last_message_at: self.last_message_at,
            peer_count: self.peers.peers.len(),
        }
    }
}

/// 飞书通道宿主：凭证、联系人档案与长连接任务代际。
pub struct FeishuHost {
    inner: Arc<Mutex<Inner>>,
    epoch: Arc<AtomicU64>,
}

impl Default for FeishuHost {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner::default())),
            epoch: Arc::new(AtomicU64::new(0)),
        }
    }
}

impl FeishuHost {
    async fn lock(&self) -> tokio::sync::MutexGuard<'_, Inner> {
        self.inner.lock().await
    }
}

fn ensure_loaded(app: &AppHandle, inner: &mut Inner) -> Result<(), String> {
    if inner.loaded {
        return Ok(());
    }
    let dir = channel_dir(app, DIR_NAME)?;
    inner.credentials =
        read_json::<StoredCredentials>(&dir.join(CREDENTIALS_FILE)).filter(|credentials| {
            !credentials.app_id.trim().is_empty() && !credentials.app_secret.trim().is_empty()
        });
    inner.peers = read_json::<PeerBook>(&dir.join(PEERS_FILE)).unwrap_or_default();
    inner.state = "stopped".into();
    inner.loaded = true;
    Ok(())
}

/// 凭证落盘（0600）。扫码创建与手填两条路径共用，避免两处各写一遍。
fn store_credentials(app: &AppHandle, credentials: &StoredCredentials) -> Result<(), String> {
    let dir = channel_dir(app, DIR_NAME)?;
    let bytes = serde_json::to_vec_pretty(credentials)
        .map_err(|error| format!("凭证序列化失败: {error}"))?;
    write_private(&dir.join(CREDENTIALS_FILE), &bytes)
}

fn persist_peers(app: &AppHandle, peers: &PeerBook) {
    let Ok(dir) = channel_dir(app, DIR_NAME) else {
        return;
    };
    match serde_json::to_vec_pretty(peers) {
        Ok(bytes) => {
            if let Err(error) = write_private(&dir.join(PEERS_FILE), &bytes) {
                log::warn("feishu", format!("联系人档案落盘失败: {error}"));
            }
        }
        Err(error) => log::warn("feishu", format!("联系人档案序列化失败: {error}")),
    }
}

/// 长连接的对外出口：事件广播 + 联系人档案落盘。
pub(crate) struct StreamDeps {
    sink: EventSink,
    persist: Arc<dyn Fn(&PeerBook) + Send + Sync>,
    /// 入站媒体收件目录（连上时解析一次；不可用时入站媒体整体丢弃并记日志）。
    inbox: Option<PathBuf>,
}

impl StreamDeps {
    fn for_app(app: &AppHandle) -> Self {
        let handle = app.clone();
        let inbox = inbox_dir(app, DIR_NAME)
            .inspect_err(|error| log::warn("feishu", format!("收件目录不可用: {error}")))
            .ok();
        Self {
            sink: app_sink(app),
            persist: Arc::new(move |peers: &PeerBook| persist_peers(&handle, peers)),
            inbox,
        }
    }

    fn emit(&self, event: &str, payload: serde_json::Value) {
        (self.sink)(event, payload);
    }
}

fn emit_state(inner: &Inner, deps: &StreamDeps) {
    deps.emit(
        STATE_EVENT,
        serde_json::to_value(inner.status()).unwrap_or(serde_json::Value::Null),
    );
}

async fn set_state(inner: &Mutex<Inner>, deps: &StreamDeps, state: &str, detail: Option<String>) {
    let mut guard = inner.lock().await;
    guard.state = state.to_string();
    guard.detail = detail;
    emit_state(&guard, deps);
}

/* ===== 宿主层：长连接 ===== */

/// 分片重组：`sum > 1` 的消息按 `message_id` 拼回（官方 SDK 用 5s TTL 的缓存）。
/// 分片缓存条目：(写入时刻, 按 seq 排好的分片)。
type FragmentEntry = (i64, Vec<Option<Vec<u8>>>);

#[derive(Default)]
struct Fragments {
    entries: BTreeMap<String, FragmentEntry>,
}

impl Fragments {
    fn push(
        &mut self,
        message_id: &str,
        sum: usize,
        seq: usize,
        payload: Vec<u8>,
    ) -> Option<Vec<u8>> {
        let now = now_ms();
        self.entries
            .retain(|_, (at, _)| now - *at < FRAGMENT_TTL.as_millis() as i64);
        if self.entries.len() >= FRAGMENT_LIMIT {
            return None;
        }
        let entry = self
            .entries
            .entry(message_id.to_string())
            .or_insert_with(|| (now, vec![None; sum]));
        if entry.1.len() < sum {
            entry.1.resize(sum, None);
        }
        if seq < entry.1.len() {
            entry.1[seq] = Some(payload);
        }
        if entry.1.iter().any(|part| part.is_none()) {
            return None;
        }
        let mut joined = Vec::new();
        for part in entry.1.iter().flatten() {
            joined.extend_from_slice(part);
        }
        self.entries.remove(message_id);
        Some(joined)
    }
}

/// 一次连接的结局。
#[derive(Debug, PartialEq)]
pub(crate) enum StreamEnd {
    Closed,
}

/// 跑一条长连接直到断开（可单测：url 是参数，测试里指向本地 mock WS 服务器）。
pub(crate) async fn stream_once(
    url: &str,
    ping_interval: Duration,
    deps: &StreamDeps,
    inner: &Mutex<Inner>,
    allow_other_senders: bool,
) -> Result<StreamEnd, String> {
    let (mut socket, _response) = tokio_tungstenite::connect_async(url)
        .await
        .map_err(|error| format!("WebSocket 建连失败: {error}"))?;
    set_state(inner, deps, "connected", None).await;

    let mut ping = tokio::time::interval(ping_interval.max(Duration::from_secs(5)));
    ping.tick().await; // 首个 tick 立即返回，跳过
    let mut fragments = Fragments::default();
    let idle_window = ping_interval * 2 + PONG_GRACE;
    let mut last_frame_at = tokio::time::Instant::now();

    loop {
        let next = tokio::select! {
            _ = ping.tick() => {
                let frame = Frame {
                    method: 0,
                    headers: vec![("type".into(), "ping".into())],
                    ..Default::default()
                };
                if let Err(error) = socket.send(Message::Binary(frame.encode().into())).await {
                    return Err(format!("心跳发送失败: {error}"));
                }
                if last_frame_at.elapsed() > idle_window {
                    return Err("长时间没有收到任何帧，判定连接已死".into());
                }
                continue;
            }
            incoming = futures_util::StreamExt::next(&mut socket) => incoming,
        };
        let Some(message) = next else {
            return Ok(StreamEnd::Closed);
        };
        let message = message.map_err(|error| format!("连接读取失败: {error}"))?;
        let raw: Vec<u8> = match message {
            Message::Binary(bytes) => bytes.to_vec(),
            Message::Text(text) => text.as_bytes().to_vec(),
            Message::Close(_) => return Ok(StreamEnd::Closed),
            _ => continue,
        };
        last_frame_at = tokio::time::Instant::now();
        let frame = match Frame::decode(&raw) {
            Ok(frame) => frame,
            Err(error) => {
                log::warn("feishu", format!("帧解析失败: {error}"));
                continue;
            }
        };
        match frame.method {
            0 => {
                // 控制帧：pong 的 payload 可能带新的客户端配置（当前只用默认心跳）。
                if frame.header("type") == Some("pong") {
                    log::info("feishu", "收到 pong");
                }
            }
            1 => {
                let message_id = frame.header("message_id").unwrap_or_default().to_string();
                let sum: usize = frame
                    .header("sum")
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(1);
                let seq: usize = frame
                    .header("seq")
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(0);
                let payload = if sum > 1 {
                    match fragments.push(&message_id, sum, seq, frame.payload.clone()) {
                        Some(joined) => joined,
                        None => continue, // 还没拼齐
                    }
                } else {
                    frame.payload.clone()
                };
                if frame.header("type") == Some("event") {
                    // 先回执再处理：官方要求 3 秒内回执，而事件处理（含媒体下载）要走网络，
                    // 绝不能挡在回执前面 —— 否则服务端会判定超时并重推同一条事件。
                    let mut ack = frame.clone();
                    ack.set_header("biz_rt", "0");
                    ack.payload = ack_payload();
                    if let Err(error) = socket.send(Message::Binary(ack.encode().into())).await {
                        return Err(format!("回执发送失败: {error}"));
                    }
                    handle_event_payload(&payload, deps, inner, allow_other_senders).await;
                } else {
                    // 非事件帧也要在同 SeqID 上回执。
                    let mut ack = frame.clone();
                    ack.set_header("biz_rt", "0");
                    ack.payload = ack_payload();
                    if let Err(error) = socket.send(Message::Binary(ack.encode().into())).await {
                        return Err(format!("回执发送失败: {error}"));
                    }
                }
            }
            other => log::warn("feishu", format!("未知帧 method={other}")),
        }
    }
}

async fn handle_event_payload(
    payload: &[u8],
    deps: &StreamDeps,
    inner: &Mutex<Inner>,
    allow_other_senders: bool,
) {
    let event: MessageEvent = match serde_json::from_slice(payload) {
        Ok(event) => event,
        Err(error) => {
            log::warn("feishu", format!("事件解析失败: {error}"));
            return;
        }
    };
    if event.header.event_type.as_deref() != Some(MESSAGE_EVENT) {
        return;
    }
    let Some(peer_id) = event.peer_key() else {
        log::warn("feishu", "消息缺少发送者标识，忽略");
        return;
    };
    let message = event.event.message.clone().unwrap_or_default();
    let text = message_text(&message);
    let (peers, allowed, at) = {
        let mut guard = inner.lock().await;
        // 第一个来消息的人是这台机器的默认主人；其他人要不要答复由设置决定。
        guard.peers.claim_owner(&peer_id);
        guard.peers.remember(&peer_id, &event);
        let allowed = allow_other_senders || guard.peers.owner.as_deref() == Some(peer_id.as_str());
        let at = now_ms();
        guard.last_message_at = Some(at);
        let snapshot = guard.peers.clone();
        emit_state(&guard, deps);
        (snapshot, allowed, at)
    };
    (deps.persist)(&peers);
    if !allowed {
        log::info(
            "feishu",
            format!("忽略非授权发送者 {peer_id}（可在设置中允许其他联系人）"),
        );
        return;
    }
    // 回执已在 stream_once 里先行发出；这里才做网络下载，不占 3 秒回执窗口。
    let media = materialize_inbound(deps, inner, &message).await;
    let payload = FeishuInboundDto {
        message_id: message.message_id.clone(),
        peer_id,
        nick: event.display_nick(),
        text,
        message_type: message.message_type.clone(),
        chat_type: message.chat_type.clone(),
        media,
        at,
    };
    deps.emit(
        INBOUND_EVENT,
        serde_json::to_value(payload).unwrap_or(serde_json::Value::Null),
    );
}

/// 下载一条入站媒体资源：`im/v1/messages/{message_id}/resources/{file_key}?type=...`。
async fn download_resource(
    client: &reqwest::Client,
    domain: &str,
    token: &str,
    message_id: &str,
    pending: &PendingMedia,
) -> Result<Vec<u8>, String> {
    let url = format!(
        "{}/open-apis/im/v1/messages/{message_id}/resources/{}?type={}",
        domain.trim_end_matches('/'),
        pending.file_key,
        pending.resource_type,
    );
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {token}"))
        .timeout(API_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("下载媒体失败: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("下载媒体 HTTP {status}: {}", brief(&body)));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("读取媒体字节失败: {error}"))?;
    if bytes.len() as u64 > MAX_MEDIA_BYTES {
        return Err(format!(
            "媒体超过 {} MB 上限",
            MAX_MEDIA_BYTES / (1024 * 1024)
        ));
    }
    Ok(bytes.to_vec())
}

/// 把入站消息里的媒体下载进 inbox（单条失败只记日志，不中断整轮）。
async fn materialize_inbound(
    deps: &StreamDeps,
    inner: &Mutex<Inner>,
    message: &EventMessage,
) -> Vec<MediaRefDto> {
    let pending = content_media(message);
    if pending.is_empty() {
        return Vec::new();
    }
    let Some(inbox) = deps.inbox.as_deref() else {
        log::warn("feishu", "收件目录不可用，丢弃入站媒体");
        return Vec::new();
    };
    let Some(message_id) = message
        .message_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        log::warn("feishu", "消息缺少 message_id，无法下载媒体");
        return Vec::new();
    };
    let credentials = {
        let guard = inner.lock().await;
        guard.credentials.clone()
    };
    let Some(credentials) = credentials else {
        log::warn("feishu", "缺少凭证，无法下载入站媒体");
        return Vec::new();
    };
    let client = match crate::http::shared_client(10) {
        Ok(client) => client,
        Err(error) => {
            log::warn("feishu", format!("下载媒体前建客户端失败: {error}"));
            return Vec::new();
        }
    };
    let token = match tenant_access_token(
        &client,
        DEFAULT_DOMAIN,
        &credentials.app_id,
        &credentials.app_secret,
    )
    .await
    {
        Ok(token) => token,
        Err(error) => {
            log::warn("feishu", format!("换取 token 失败，跳过入站媒体: {error}"));
            return Vec::new();
        }
    };
    let received_at = now_ms();
    let mut refs = Vec::new();
    for (index, item) in pending.iter().enumerate() {
        match download_resource(&client, DEFAULT_DOMAIN, &token, message_id, item).await {
            Ok(bytes) => {
                if let Some(dto) = store_inbound_media(
                    inbox,
                    DIR_NAME,
                    received_at,
                    index,
                    item.kind,
                    &item.name,
                    bytes,
                ) {
                    refs.push(dto);
                }
            }
            Err(error) => log::warn("feishu", format!("入站媒体下载失败: {error}")),
        }
    }
    refs
}

/* ===== 宿主层：Tauri 命令 ===== */

/// 当前通道状态（是否已配置凭证、长连接状态、已建档联系人数）。
#[tauri::command]
pub async fn feishu_status(
    app: AppHandle,
    host: State<'_, FeishuHost>,
) -> Result<FeishuStatusDto, String> {
    let mut inner = host.lock().await;
    ensure_loaded(&app, &mut inner)?;
    Ok(inner.status())
}

/// 保存应用凭证（AppID + AppSecret）。`app_secret` 传 None 表示沿用已存密钥。
#[tauri::command]
pub async fn feishu_save_credentials(
    app: AppHandle,
    host: State<'_, FeishuHost>,
    app_id: String,
    app_secret: Option<String>,
) -> Result<FeishuStatusDto, String> {
    let app_id = app_id.trim().to_string();
    if app_id.is_empty() {
        return Err("AppID 不能为空".into());
    }
    let mut inner = host.lock().await;
    ensure_loaded(&app, &mut inner)?;
    let secret = app_secret
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            inner
                .credentials
                .as_ref()
                .map(|credentials| credentials.app_secret.clone())
        });
    let Some(secret) = secret else {
        return Err("AppSecret 不能为空".into());
    };
    let credentials = StoredCredentials {
        app_id,
        app_secret: secret,
        saved_at: Some(chrono::Utc::now().to_rfc3339()),
    };
    store_credentials(&app, &credentials)?;
    inner.credentials = Some(credentials);
    inner.detail = None;
    log::info("feishu", "应用凭证已保存");
    Ok(inner.status())
}

/// 清除凭证与联系人档案。
#[tauri::command]
pub async fn feishu_clear_credentials(
    app: AppHandle,
    host: State<'_, FeishuHost>,
) -> Result<FeishuStatusDto, String> {
    host.epoch.fetch_add(1, Ordering::SeqCst);
    let mut inner = host.lock().await;
    ensure_loaded(&app, &mut inner)?;
    inner.credentials = None;
    inner.peers = PeerBook::default();
    inner.registration = None;
    inner.state = "stopped".into();
    inner.detail = None;
    inner.last_message_at = None;
    let dir = channel_dir(&app, DIR_NAME)?;
    for name in [CREDENTIALS_FILE, PEERS_FILE] {
        let path = dir.join(name);
        if path.exists() {
            let _ = std::fs::remove_file(&path);
        }
    }
    prune_inbox(&app, DIR_NAME, true);
    log::info("feishu", "凭证已清除");
    Ok(inner.status())
}

/// 发起扫码创建应用：返回二维码链接与配对码（`device_code` 留在宿主内存）。
#[tauri::command]
pub async fn feishu_register_begin(
    host: State<'_, FeishuHost>,
) -> Result<RegisterStartDto, String> {
    let client = crate::http::shared_client(10)?;
    let (session, dto) = begin_registration(&client, ACCOUNTS_DOMAIN).await?;
    log::info("feishu", "已发起扫码创建应用");
    host.lock().await.registration = Some(session);
    Ok(dto)
}

/// 轮询扫码结果：`pending` 期间间隔由服务端给（`slow_down` 会变大）；
/// 成功时凭证直接落盘并写进宿主状态，渲染端只需刷新状态。
#[tauri::command]
pub async fn feishu_register_poll(
    app: AppHandle,
    host: State<'_, FeishuHost>,
) -> Result<RegisterPollDto, String> {
    let mut session = {
        let mut inner = host.lock().await;
        ensure_loaded(&app, &mut inner)?;
        inner
            .registration
            .clone()
            .ok_or_else(|| "没有进行中的扫码创建流程".to_string())?
    };
    if now_ms() >= session.expires_at {
        let mut inner = host.lock().await;
        if current_device_code(&inner).as_deref() == Some(session.device_code.as_str()) {
            inner.registration = None;
        }
        return Ok(RegisterPollDto {
            state: "expired".into(),
            detail: None,
            app_id: None,
            interval_ms: None,
        });
    }

    let client = crate::http::shared_client(10)?;
    // 传输层错误直接抛给渲染端计次重试；协议层的 pending / 失败走返回的 DTO。
    let outcome = poll_registration(&client, &mut session).await?;
    let mut inner = host.lock().await;
    let same_session = current_device_code(&inner).as_deref() == Some(session.device_code.as_str());
    if let PollOutcome::Done { app_id, app_secret } = &outcome {
        let credentials = StoredCredentials {
            app_id: app_id.clone(),
            app_secret: app_secret.clone(),
            saved_at: Some(chrono::Utc::now().to_rfc3339()),
        };
        // 落盘失败就留着会话（服务端在有效期内还会给凭证），让用户能重试。
        store_credentials(&app, &credentials)?;
        inner.credentials = Some(credentials);
        inner.detail = None;
        if same_session {
            inner.registration = None;
        }
        log::info("feishu", "扫码创建应用成功，凭证已落盘");
        return Ok(RegisterPollDto {
            state: outcome.state().into(),
            detail: None,
            app_id: Some(app_id.clone()),
            interval_ms: None,
        });
    }
    if same_session {
        if outcome.state() == "pending" {
            inner.registration = Some(session.clone());
        } else {
            inner.registration = None;
        }
    }
    Ok(RegisterPollDto {
        state: outcome.state().into(),
        detail: outcome.detail(),
        app_id: None,
        interval_ms: Some(session.interval.as_millis() as u64),
    })
}

/// 取消扫码创建（作废本次 device_code，不再轮询）。
#[tauri::command]
pub async fn feishu_register_cancel(host: State<'_, FeishuHost>) -> Result<(), String> {
    host.lock().await.registration = None;
    Ok(())
}

fn current_device_code(inner: &Inner) -> Option<String> {
    inner
        .registration
        .as_ref()
        .map(|session| session.device_code.clone())
}

/// 启动长连接（未配置凭证时报错，由界面引导去设置里填）。
#[tauri::command]
pub async fn feishu_connect(
    app: AppHandle,
    host: State<'_, FeishuHost>,
    allow_other_senders: bool,
) -> Result<(), String> {
    let (app_id, app_secret) = {
        let mut inner = host.lock().await;
        ensure_loaded(&app, &mut inner)?;
        let credentials = inner.credentials.clone().ok_or("尚未配置飞书应用凭证")?;
        (credentials.app_id, credentials.app_secret)
    };
    let epoch = host.epoch.fetch_add(1, Ordering::SeqCst) + 1;
    // 上次会话遗留的未取走收件文件先清掉（渲染端崩溃 / 未取走）。
    prune_inbox(&app, DIR_NAME, false);
    let inner = host.inner.clone();
    let epochs = host.epoch.clone();
    let deps = StreamDeps::for_app(&app);
    set_state(&inner, &deps, "connecting", None).await;
    tauri::async_runtime::spawn(async move {
        run_stream(
            deps,
            inner,
            epochs,
            epoch,
            StreamCredentials { app_id, app_secret },
            allow_other_senders,
        )
        .await;
    });
    Ok(())
}

/// 停止长连接（保留凭证与联系人档案）。
#[tauri::command]
pub async fn feishu_disconnect(app: AppHandle, host: State<'_, FeishuHost>) -> Result<(), String> {
    host.epoch.fetch_add(1, Ordering::SeqCst);
    let mut inner = host.lock().await;
    ensure_loaded(&app, &mut inner)?;
    let deps = StreamDeps::for_app(&app);
    inner.state = "stopped".into();
    inner.detail = None;
    emit_state(&inner, &deps);
    Ok(())
}

/// 回一条文本给联系人（接收方信息在宿主侧，渲染端只传对端与文本）。
#[tauri::command]
pub async fn feishu_send(
    app: AppHandle,
    host: State<'_, FeishuHost>,
    peer_id: String,
    text: String,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("回复内容为空".into());
    }
    let (credentials, record) = {
        let mut inner = host.lock().await;
        ensure_loaded(&app, &mut inner)?;
        let credentials = inner.credentials.clone().ok_or("尚未配置飞书应用凭证")?;
        let record = inner
            .peers
            .target(&peer_id)
            .cloned()
            .ok_or("会话信息不可用：等对方再发一条消息")?;
        (credentials, record)
    };
    let client = crate::http::shared_client(10)?;
    let token = tenant_access_token(
        &client,
        DEFAULT_DOMAIN,
        &credentials.app_id,
        &credentials.app_secret,
    )
    .await?;
    send_text(
        &client,
        DEFAULT_DOMAIN,
        &token,
        &record.receive_id_type,
        &record.receive_id,
        text.trim(),
    )
    .await
}

/* ===== 宿主层：长连接主循环（带重连退避） ===== */

struct StreamCredentials {
    app_id: String,
    app_secret: String,
}

async fn run_stream(
    deps: StreamDeps,
    inner: Arc<Mutex<Inner>>,
    epochs: Arc<AtomicU64>,
    epoch: u64,
    credentials: StreamCredentials,
    allow_other_senders: bool,
) {
    let mut attempt: u32 = 0;
    log::info("feishu", "长连接启动");
    while epochs.load(Ordering::SeqCst) == epoch {
        let client = match crate::http::shared_client(10) {
            Ok(client) => client,
            Err(error) => {
                set_state(&inner, &deps, "error", Some(error)).await;
                return;
            }
        };
        let endpoint = match fetch_endpoint(
            &client,
            DEFAULT_DOMAIN,
            &credentials.app_id,
            &credentials.app_secret,
        )
        .await
        {
            Ok(endpoint) => endpoint,
            Err(error) => {
                attempt = attempt.saturating_add(1);
                log::warn("feishu", format!("取长连接入口失败({attempt}): {error}"));
                set_state(&inner, &deps, "error", Some(error)).await;
                if !sleep_or_stop(&epochs, epoch, reconnect_delay(attempt)).await {
                    break;
                }
                continue;
            }
        };
        let ping_interval = endpoint
            .client_config
            .as_ref()
            .and_then(|config| {
                (config.ping_interval > 0).then(|| Duration::from_secs(config.ping_interval as u64))
            })
            .unwrap_or(DEFAULT_PING_INTERVAL);
        let url = endpoint.url;
        match stream_once(&url, ping_interval, &deps, &inner, allow_other_senders).await {
            Ok(end) => {
                log::info("feishu", format!("连接结束: {end:?}"));
                attempt = 0;
            }
            Err(error) => {
                attempt = attempt.saturating_add(1);
                log::warn("feishu", format!("连接异常({attempt}): {error}"));
                set_state(&inner, &deps, "error", Some(error)).await;
            }
        }
        if !sleep_or_stop(&epochs, epoch, reconnect_delay(attempt)).await {
            break;
        }
        set_state(&inner, &deps, "connecting", None).await;
    }
    log::info("feishu", "长连接已停止");
}

fn reconnect_delay(attempt: u32) -> Duration {
    let seconds = 1u64 << attempt.min(6);
    Duration::from_secs(seconds.min(RECONNECT_MAX_DELAY.as_secs()))
}

/* ===== 单测 ===== */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_round_trips_through_protobuf_codec() {
        let frame = Frame {
            seq_id: 7,
            log_id: 42,
            service: 1,
            method: 1,
            headers: vec![
                ("type".into(), "event".into()),
                ("message_id".into(), "m-1".into()),
            ],
            payload_encoding: "json".into(),
            payload_type: "event".into(),
            payload: br#"{"hello":"world"}"#.to_vec(),
        };
        let encoded = frame.encode();
        let decoded = Frame::decode(&encoded).expect("decode");
        assert_eq!(decoded, frame);
    }

    #[test]
    fn frame_decode_skips_unknown_fields() {
        // 追加字段 9（LogIDNew，string）与 10（varint），应被跳过而不是报错。
        let mut bytes = Frame {
            seq_id: 3,
            method: 1,
            payload: b"x".to_vec(),
            ..Default::default()
        }
        .encode();
        write_bytes_field(&mut bytes, 9, b"log-new");
        write_varint_field(&mut bytes, 10, 5);
        let decoded = Frame::decode(&bytes).expect("decode");
        assert_eq!(decoded.seq_id, 3);
        assert_eq!(decoded.payload, b"x".to_vec());
    }

    #[test]
    fn ack_payload_is_official_response_shape() {
        let ack: serde_json::Value = serde_json::from_slice(&ack_payload()).expect("ack json");
        assert_eq!(ack["code"], 200);
        assert!(ack["headers"].is_object());
    }

    #[test]
    fn endpoint_body_uses_official_field_names() {
        let body = endpoint_body("cli_x", "secret");
        assert_eq!(body["AppID"], "cli_x");
        assert_eq!(body["AppSecret"], "secret");
    }

    #[test]
    fn message_event_maps_peer_text_and_reply_target() {
        let raw = r#"{
            "header": {"event_id":"e-1","event_type":"im.message.receive_v1"},
            "event": {
                "sender": {"sender_id": {"open_id":"ou_abc","user_id":"uid-1"}, "sender_type":"user"},
                "message": {"message_id":"om-1","chat_id":"oc-1","chat_type":"p2p","message_type":"text","content":"{\"text\":\"帮我看看今天的安排\"}"}
            }
        }"#;
        let event: MessageEvent = serde_json::from_str(raw).expect("event");
        assert_eq!(event.header.event_type.as_deref(), Some(MESSAGE_EVENT));
        assert_eq!(event.peer_key().as_deref(), Some("ou_abc"));
        assert_eq!(
            event.reply_target(),
            Some(("open_id", "ou_abc".to_string()))
        );
        let message = event.event.message.as_ref().expect("message");
        assert_eq!(message_text(message), "帮我看看今天的安排");
    }

    #[test]
    fn group_event_replies_to_chat_and_strips_mention() {
        let raw = r#"{
            "header": {"event_type":"im.message.receive_v1"},
            "event": {
                "sender": {"sender_id": {"open_id":"ou_abc"}},
                "message": {"message_id":"om-2","chat_id":"oc-9","chat_type":"group","message_type":"text","content":"{\"text\":\"@_user_1 在吗\"}"}
            }
        }"#;
        let event: MessageEvent = serde_json::from_str(raw).expect("event");
        assert_eq!(
            event.peer_key().as_deref(),
            Some("oc-9"),
            "群聊以会话为主体"
        );
        assert_eq!(event.reply_target(), Some(("chat_id", "oc-9".to_string())));
        // 文本原样保留（飞书会把 @ 替换成 @_user_N 占位，模型自己忽略即可）
        let message = event.event.message.as_ref().expect("message");
        assert_eq!(message_text(message), "@_user_1 在吗");
    }

    #[test]
    fn non_text_and_broken_content_yield_empty_text() {
        let image = EventMessage {
            message_type: Some("image".into()),
            content: Some("{\"image_key\":\"img-1\"}".into()),
            ..Default::default()
        };
        assert_eq!(message_text(&image), "");
        let broken = EventMessage {
            content: Some("not-json".into()),
            ..Default::default()
        };
        assert_eq!(message_text(&broken), "");
    }

    #[test]
    fn text_message_body_stringifies_content() {
        let body = text_message_body("ou_abc", "收到");
        assert_eq!(body["receive_id"], "ou_abc");
        assert_eq!(body["msg_type"], "text");
        let content: serde_json::Value =
            serde_json::from_str(body["content"].as_str().expect("content is api string"))
                .expect("inner json");
        assert_eq!(content["text"], "收到");
    }

    #[test]
    fn content_media_extracts_image_and_file_keys() {
        let image = EventMessage {
            message_type: Some("image".into()),
            content: Some(r#"{"image_key":"img_v2_abc"}"#.into()),
            ..Default::default()
        };
        let media = content_media(&image);
        assert_eq!(media.len(), 1);
        assert_eq!(media[0].kind, MediaKind::Image);
        assert_eq!(media[0].resource_type, "image");
        assert_eq!(media[0].file_key, "img_v2_abc");

        let file = EventMessage {
            message_type: Some("file".into()),
            content: Some(r#"{"file_key":"file_v2_x","file_name":"报表.xlsx"}"#.into()),
            ..Default::default()
        };
        let media = content_media(&file);
        assert_eq!(media[0].kind, MediaKind::File);
        assert_eq!(media[0].name, "报表.xlsx");
        assert_eq!(media[0].resource_type, "file");

        let audio = EventMessage {
            message_type: Some("audio".into()),
            content: Some(r#"{"file_key":"audio_v2_x","duration":3000}"#.into()),
            ..Default::default()
        };
        let media = content_media(&audio);
        assert_eq!(media[0].kind, MediaKind::Audio);
        assert_eq!(media[0].resource_type, "file");

        let video = EventMessage {
            message_type: Some("media".into()),
            content: Some(r#"{"file_key":"video_v2_x","file_name":"片.mp4"}"#.into()),
            ..Default::default()
        };
        let media = content_media(&video);
        assert_eq!(media[0].kind, MediaKind::Video);
        assert_eq!(media[0].name, "片.mp4");

        let text = EventMessage {
            message_type: Some("text".into()),
            content: Some(r#"{"text":"hi"}"#.into()),
            ..Default::default()
        };
        assert!(content_media(&text).is_empty(), "文本消息没有可下载资源");
    }

    #[test]
    fn message_body_stringifies_media_content() {
        let body = message_body(
            "ou_abc",
            "image",
            &serde_json::json!({ "image_key": "img_1" }),
        );
        assert_eq!(body["msg_type"], "image");
        let content: serde_json::Value =
            serde_json::from_str(body["content"].as_str().expect("content is api string"))
                .expect("inner json");
        assert_eq!(content["image_key"], "img_1");
    }

    #[test]
    fn fragments_reassemble_by_sum_and_seq() {
        let mut fragments = Fragments::default();
        assert!(fragments.push("m-1", 2, 0, b"hello ".to_vec()).is_none());
        let joined = fragments
            .push("m-1", 2, 1, b"world".to_vec())
            .expect("joined");
        assert_eq!(joined, b"hello world".to_vec());
    }

    #[test]
    fn peer_book_claims_owner_once_and_keeps_reply_target() {
        let raw = r#"{
            "header": {"event_type":"im.message.receive_v1"},
            "event": {
                "sender": {"sender_id": {"open_id":"ou_a"}},
                "message": {"message_id":"om-1","chat_id":"oc-1","chat_type":"p2p","message_type":"text","content":"{\"text\":\"你好\"}"}
            }
        }"#;
        let event: MessageEvent = serde_json::from_str(raw).expect("event");
        let mut book = PeerBook::default();
        assert!(book.claim_owner("ou_a"));
        assert!(!book.claim_owner("ou_b"), "主人只认第一个发消息的人");
        assert!(book.remember("ou_a", &event));
        let record = book.target("ou_a").expect("record");
        assert_eq!(record.receive_id_type, "open_id");
        assert_eq!(record.receive_id, "ou_a");
        assert_eq!(record.last_message_id.as_deref(), Some("om-1"));
    }

    #[test]
    fn reconnect_delay_caps_at_one_minute() {
        assert_eq!(reconnect_delay(0), Duration::from_secs(1));
        assert_eq!(reconnect_delay(4), Duration::from_secs(16));
        assert_eq!(reconnect_delay(20), RECONNECT_MAX_DELAY);
    }

    /* ===== 长连接：对本地 mock WS 服务器跑完整一轮 ===== */

    /// mock 服务端：推一条消息事件帧 → 校验回执（同 SeqID、code 200）→ 推一条他人的消息 → 断开。
    async fn spawn_feishu_server() -> String {
        use futures_util::StreamExt;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else {
                return;
            };
            let event_frame = |seq: u64, peer: &str, chat: &str, text: &str| {
                let payload = serde_json::json!({
                    "header": { "event_id": format!("e-{seq}"), "event_type": MESSAGE_EVENT },
                    "event": {
                        "sender": { "sender_id": { "open_id": peer } },
                        "message": {
                            "message_id": format!("om-{seq}"),
                            "chat_id": chat,
                            "chat_type": "p2p",
                            "message_type": "text",
                            "content": serde_json::json!({ "text": text }).to_string(),
                        }
                    }
                })
                .to_string();
                Frame {
                    seq_id: seq,
                    log_id: seq,
                    service: 1,
                    method: 1,
                    headers: vec![
                        ("type".into(), "event".into()),
                        ("message_id".into(), format!("m-{seq}")),
                        ("sum".into(), "1".into()),
                        ("seq".into(), "0".into()),
                    ],
                    payload: payload.into_bytes(),
                    ..Default::default()
                }
                .encode()
            };

            let _ = socket
                .send(Message::Binary(
                    event_frame(1, "ou_owner", "oc-1", "帮我看看今天的安排").into(),
                ))
                .await;
            if let Some(Ok(message)) = socket.next().await {
                let raw = match message {
                    Message::Binary(bytes) => bytes.to_vec(),
                    Message::Text(text) => text.as_bytes().to_vec(),
                    _ => Vec::new(),
                };
                let ack = Frame::decode(&raw).expect("ack frame");
                assert_eq!(ack.seq_id, 1, "回执必须落在同一个 SeqID 上");
                assert_eq!(ack.header("type"), Some("event"), "回执要继承原帧 headers");
                let payload: serde_json::Value =
                    serde_json::from_slice(&ack.payload).expect("ack payload");
                assert_eq!(payload["code"], 200);
            }
            let _ = socket
                .send(Message::Binary(
                    event_frame(2, "ou_stranger", "oc-2", "外人的消息").into(),
                ))
                .await;
            let _ = socket.next().await;
            let _ = socket.close(None).await;
            tokio::time::sleep(Duration::from_millis(150)).await;
        });
        format!("ws://{addr}")
    }

    #[tokio::test]
    async fn stream_once_acks_events_and_filters_foreign_senders() {
        let url = spawn_feishu_server().await;
        let events: Arc<parking_lot::Mutex<Vec<(String, serde_json::Value)>>> =
            Arc::new(parking_lot::Mutex::new(Vec::new()));
        let persisted: Arc<parking_lot::Mutex<Option<PeerBook>>> =
            Arc::new(parking_lot::Mutex::new(None));
        let deps = StreamDeps {
            sink: {
                let events = events.clone();
                Arc::new(move |event: &str, payload: serde_json::Value| {
                    events.lock().push((event.to_string(), payload));
                })
            },
            persist: {
                let persisted = persisted.clone();
                Arc::new(move |peers: &PeerBook| {
                    *persisted.lock() = Some(peers.clone());
                })
            },
            inbox: None,
        };
        let inner = Mutex::new(Inner::default());

        let end = tokio::time::timeout(
            Duration::from_secs(5),
            stream_once(&url, Duration::from_secs(30), &deps, &inner, false),
        )
        .await
        .expect("连接应自行结束")
        .expect("连接不应报错");
        assert_eq!(end, StreamEnd::Closed);

        let inbound: Vec<serde_json::Value> = events
            .lock()
            .iter()
            .filter(|(event, _)| event == INBOUND_EVENT)
            .map(|(_, payload)| payload.clone())
            .collect();
        assert_eq!(inbound.len(), 1, "默认只放行归属人：{inbound:?}");
        assert_eq!(inbound[0]["peerId"], "ou_owner");
        assert_eq!(inbound[0]["text"], "帮我看看今天的安排");
        assert_eq!(inbound[0]["messageId"], "om-1");

        let states: Vec<String> = events
            .lock()
            .iter()
            .filter(|(event, _)| event == STATE_EVENT)
            .map(|(_, payload)| payload["state"].as_str().unwrap_or_default().to_string())
            .collect();
        assert!(
            states.iter().any(|state| state == "connected"),
            "状态应翻到 connected：{states:?}"
        );

        let book = persisted.lock().clone().expect("联系人档案应落盘");
        assert_eq!(book.owner.as_deref(), Some("ou_owner"));
        assert_eq!(
            book.target("ou_owner")
                .map(|record| record.receive_id.as_str()),
            Some("ou_owner")
        );
    }

    /* ===== 扫码创建应用：对本地 mock HTTP 服务器跑完整一轮 ===== */

    /// 服务端真实形状的 begin 响应（`expires_in` 带 s、`interval` 单位是秒）。
    const BEGIN_BODY: &str = r#"{"device_code":"v1:abc.def","verification_uri_complete":"https://open.feishu.cn/page/launcher?user_code=LF7S-N6L6","verification_uri":"https://open.feishu.cn/page/launcher","user_code":"LF7S-N6L6","expires_in":3600,"interval":5}"#;

    /// 按脚本逐条应答的极简 HTTP 服务端（每连接一条请求，`Connection: close`），
    /// 请求原文记录下来供断言表单字段。
    async fn spawn_registration_mock(
        responses: Vec<(u16, &'static str)>,
    ) -> (String, Arc<parking_lot::Mutex<Vec<String>>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let recorded: Arc<parking_lot::Mutex<Vec<String>>> =
            Arc::new(parking_lot::Mutex::new(Vec::new()));
        let sink = recorded.clone();
        tokio::spawn(async move {
            let mut index = 0usize;
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                // 读到请求头结束 + Content-Length 指定的 body，再回响应。
                let mut buffer: Vec<u8> = Vec::new();
                let mut chunk = [0u8; 2048];
                loop {
                    let read = stream.read(&mut chunk).await.unwrap_or(0);
                    if read == 0 {
                        break;
                    }
                    buffer.extend_from_slice(&chunk[..read]);
                    let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n")
                    else {
                        continue;
                    };
                    let head = String::from_utf8_lossy(&buffer[..position]).to_string();
                    let length: usize = head
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())?
                        })
                        .unwrap_or(0);
                    if buffer.len() >= position + 4 + length {
                        break;
                    }
                }
                sink.lock()
                    .push(String::from_utf8_lossy(&buffer).to_string());
                let (status, payload) = responses.get(index).copied().unwrap_or((500, "{}"));
                index += 1;
                let response = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                    payload.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.shutdown().await;
                if index >= responses.len() {
                    break;
                }
            }
        });
        (format!("http://{addr}"), recorded)
    }

    #[test]
    fn form_body_percent_encodes_values() {
        // device_code 是带 `:` `-` 的 JWT 串，编码错了服务端只会回 invalid_grant。
        assert_eq!(
            form_body(&[("action", "poll"), ("device_code", "v1:a b")]),
            "action=poll&device_code=v1%3Aa+b"
        );
    }

    #[tokio::test]
    async fn begin_registration_uses_official_form_and_builds_qr_link() {
        let (base, recorded) = spawn_registration_mock(vec![(200, BEGIN_BODY)]).await;
        let client = crate::http::shared_client(5).expect("client");
        let (session, dto) = begin_registration(&client, &base).await.expect("begin");

        assert_eq!(dto.user_code, "LF7S-N6L6");
        assert_eq!(
            dto.expires_in, 3600,
            "服务端给的是 expires_in，不能落到兜底 600s"
        );
        assert_eq!(dto.interval, 5);
        assert!(dto.qr_url.contains("user_code=LF7S-N6L6"));
        for marker in ["from=sdk", "tp=sdk", "source=greywork"] {
            assert!(
                dto.qr_url.contains(marker),
                "二维码链接缺 {marker}: {}",
                dto.qr_url
            );
        }
        assert_eq!(session.interval, Duration::from_secs(5));
        assert!(
            session.expires_at > now_ms() + 3_500_000,
            "有效期应按 expires_in 推算"
        );

        let sent = recorded.lock().join("\n");
        for field in [
            "action=begin",
            "archetype=PersonalAgent",
            "auth_method=client_secret",
            "request_user_info=open_id",
        ] {
            assert!(sent.contains(field), "表单缺字段 {field}: {sent}");
        }
    }

    #[tokio::test]
    async fn poll_registration_reads_flow_state_from_http_400_body() {
        // 这个接口把「还没确认」表达成 HTTP 400 + JSON 体：4xx 不能当传输失败。
        let (base, recorded) = spawn_registration_mock(vec![
            (200, BEGIN_BODY),
            (
                400,
                r#"{"error":"authorization_pending","error_description":"","code":20094}"#,
            ),
        ])
        .await;
        let client = crate::http::shared_client(5).expect("client");
        let (mut session, _) = begin_registration(&client, &base).await.expect("begin");

        let outcome = poll_registration(&client, &mut session)
            .await
            .expect("poll");
        assert_eq!(outcome, PollOutcome::Pending);
        assert_eq!(session.interval, Duration::from_secs(5), "等待中不改间隔");
        assert_eq!(session.domain, base, "国内租户不换域");

        let sent = recorded.lock().join("\n");
        assert!(sent.contains("action=poll"), "轮询要带 action=poll: {sent}");
        assert!(
            sent.contains("device_code=v1%3Aabc.def"),
            "device_code 要按表单编码回传: {sent}"
        );
    }

    #[tokio::test]
    async fn poll_registration_slows_down_and_switches_domain_once() {
        let (base, _) = spawn_registration_mock(vec![
            (200, BEGIN_BODY),
            (400, r#"{"error":"slow_down"}"#),
            (200, r#"{"user_info":{"tenant_brand":"lark"}}"#),
            (200, r#"{"user_info":{"tenant_brand":"lark"}}"#),
        ])
        .await;
        let client = crate::http::shared_client(5).expect("client");
        let (mut session, _) = begin_registration(&client, &base).await.expect("begin");
        assert_eq!(session.domain, base);

        assert_eq!(
            poll_registration(&client, &mut session)
                .await
                .expect("poll"),
            PollOutcome::Pending
        );
        assert_eq!(
            session.interval,
            Duration::from_secs(10),
            "slow_down 要放慢到 5+5 秒"
        );

        assert_eq!(
            poll_registration(&client, &mut session)
                .await
                .expect("poll"),
            PollOutcome::Pending
        );
        assert_eq!(session.domain, ACCOUNTS_LARK_DOMAIN, "国际版租户换域重试");

        // 再报一次 lark 就按普通等待处理：不能在两个域之间来回撞。
        // （把域指回 mock：这一步只验「不再切换」，不该真的去打国际版域名。）
        session.domain = base.clone();
        assert_eq!(
            poll_registration(&client, &mut session)
                .await
                .expect("poll"),
            PollOutcome::Pending
        );
        assert_eq!(session.domain, base, "已经切过域就不再切");
    }

    #[tokio::test]
    async fn poll_registration_returns_credentials_when_confirmed() {
        let (base, _) = spawn_registration_mock(vec![
            (200, BEGIN_BODY),
            (
                200,
                r#"{"client_id":"cli_scan","client_secret":"sec_scan","user_info":{"tenant_brand":"feishu"}}"#,
            ),
        ])
        .await;
        let client = crate::http::shared_client(5).expect("client");
        let (mut session, _) = begin_registration(&client, &base).await.expect("begin");
        assert_eq!(
            poll_registration(&client, &mut session)
                .await
                .expect("poll"),
            PollOutcome::Done {
                app_id: "cli_scan".into(),
                app_secret: "sec_scan".into(),
            }
        );
    }

    #[test]
    fn classify_poll_covers_every_server_error_code() {
        let cases = [
            (
                r#"{"error":"access_denied","error_description":"用户取消"}"#,
                PollOutcome::Denied("用户取消".into()),
            ),
            // 服务端不给描述时留空串：界面出本地化文案
            (
                r#"{"error":"expired_token"}"#,
                PollOutcome::Expired(String::new()),
            ),
            (
                r#"{"error":"invalid_grant","error_description":"device_code is invalid"}"#,
                PollOutcome::Expired("device_code is invalid".into()),
            ),
            (
                r#"{"error":"invalid_client"}"#,
                PollOutcome::Failed("invalid_client".into()),
            ),
            (r#"{}"#, PollOutcome::Pending),
        ];
        for (raw, expected) in cases {
            let response: PollResponse = serde_json::from_str(raw).expect("poll json");
            assert_eq!(classify_poll(&response), expected, "{raw}");
        }

        // 拿到凭证时 lark 也算成功（换域只是重试手段）
        let done: PollResponse = serde_json::from_str(
            r#"{"client_id":"a","client_secret":"b","user_info":{"tenant_brand":"lark"}}"#,
        )
        .expect("json");
        assert_eq!(
            classify_poll(&done),
            PollOutcome::Done {
                app_id: "a".into(),
                app_secret: "b".into(),
            }
        );

        // 空说明不往界面上丢空提示
        assert_eq!(PollOutcome::Denied(String::new()).detail(), None);
        assert_eq!(PollOutcome::Expired("  ".into()).detail(), None);
        assert_eq!(
            PollOutcome::Failed("invalid_client".into())
                .detail()
                .as_deref(),
            Some("invalid_client")
        );
        assert_eq!(
            PollOutcome::Done {
                app_id: "a".into(),
                app_secret: "b".into(),
            }
            .state(),
            "done"
        );
    }
}
