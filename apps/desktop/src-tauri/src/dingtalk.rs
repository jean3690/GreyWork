//! 钉钉通道：企业内部机器人 + Stream 模式（WebSocket 反向连接）。
//!
//! 为什么是 Stream 模式：它在钉钉开放平台侧订阅事件，由**客户端主动**连出 WebSocket，
//! 不需要公网回调地址，也不需要注册加解密密钥 —— 桌面端在内网即可收发消息。
//!
//! 链路（与官方 `dingtalk-stream-sdk-python` 同形）：
//! 1. `POST /v1.0/gateway/connections/open`（clientId/clientSecret + 订阅表）→ `{endpoint, ticket}`
//! 2. `wss://<endpoint>?ticket=<ticket>` 建连；帧是 JSON 文本，`type` ∈ SYSTEM / EVENT / CALLBACK
//! 3. 机器人消息走 CALLBACK，`topic=/v1.0/im/bot/messages/get`，`data` 是**字符串**包一层 JSON；
//!    每条带 `sessionWebhook`（约 30 分钟有效），回消息就是 POST 到它 —— 不需要额外鉴权
//! 4. 每条帧都要回 ack（同一 messageId），SYSTEM 的 `disconnect` 表示服务端要断开，重连即可
//!
//! 安全口径：`sessionWebhook` 是「能替机器人发言」的凭据，只留在宿主（`dingtalk/peers.json`，
//! 0600），不经过渲染端；渲染端只拿得到联系人 id 与文本。

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::SinkExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message;

use crate::channel_common::{
    app_sink, channel_dir, now_ms, read_json, sleep_or_stop, write_private, EventSink,
};
use crate::log;

/// Stream 建连入口（钉钉开放平台）。
pub const STREAM_OPEN_URL: &str = "https://api.dingtalk.com/v1.0/gateway/connections/open";
/// 机器人单聊/群聊消息的订阅 topic。
pub const CHATBOT_TOPIC: &str = "/v1.0/im/bot/messages/get";
/// `ua` 上报串：官方 SDK 也带，服务端据此放行/统计。
const UA: &str = "greywork-desktop/1.0";
/// 普通请求超时。
const API_TIMEOUT: Duration = Duration::from_secs(15);
/// 主动心跳间隔（服务端也心跳，但官方 SDK 仍每 30–60s 发一次 ping 保活）。
const PING_INTERVAL: Duration = Duration::from_secs(60);
/// 断线重连退避上限。
const RECONNECT_MAX_DELAY: Duration = Duration::from_secs(60);
/// sessionWebhook 兜底有效期（协议给绝对时间戳，这里只用作缺失时的默认值）。
const DEFAULT_WEBHOOK_TTL_MS: i64 = 30 * 60 * 1000;

pub const STATE_EVENT: &str = "dingtalk://state";
pub const INBOUND_EVENT: &str = "dingtalk://inbound";

const CREDENTIALS_FILE: &str = "credentials.json";
const PEERS_FILE: &str = "peers.json";
const DIR_NAME: &str = "dingtalk";

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
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct MessageText {
    #[serde(default)]
    pub content: Option<String>,
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

fn percent_encode(value: &str) -> String {
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
fn brief(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= 200 {
        return trimmed.to_string();
    }
    let head: String = trimmed.chars().take(200).collect();
    format!("{head}…")
}

/* ===== 宿主层：持久化 ===== */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredCredentials {
    pub client_id: String,
    pub client_secret: String,
    #[serde(default)]
    pub saved_at: Option<String>,
}

/// 联系人凭据 + 「谁在用这台机器」的归属人。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerBook {
    /// 第一个来消息的人 = 默认只答复的本人（可在设置里放开）。
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub peers: BTreeMap<String, PeerRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerRecord {
    pub webhook: String,
    #[serde(default)]
    pub expires_at: i64,
    #[serde(default)]
    pub nick: String,
}

impl PeerBook {
    /// 记录（或刷新）某个联系人可用的回发凭据。
    pub fn remember(&mut self, peer: &str, message: &ChatbotMessage) -> bool {
        let Some(webhook) = message
            .session_webhook
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        else {
            return false;
        };
        let expires_at = message
            .session_webhook_expired_time
            .unwrap_or_else(|| now_ms() + DEFAULT_WEBHOOK_TTL_MS);
        self.peers.insert(
            peer.to_string(),
            PeerRecord {
                webhook: webhook.to_string(),
                expires_at,
                nick: message.display_nick(),
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

    /// 该联系人的回发凭据（过期即视为没有）。
    pub fn live_webhook(&self, peer: &str, now: i64) -> Option<&PeerRecord> {
        self.peers
            .get(peer)
            .filter(|record| record.expires_at > now)
    }
}

/* ===== 宿主层：状态与命令 ===== */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DingTalkStatusDto {
    /// 是否已保存应用凭证（clientId + clientSecret）。
    pub configured: bool,
    /// 凭证里的 clientId（AppKey 本身不是秘密，展示出来便于确认填对了）。
    pub client_id: Option<String>,
    /// stopped / connecting / connected / error
    pub state: String,
    pub detail: Option<String>,
    pub last_message_at: Option<i64>,
    /// 已建档联系人数量（会话页列表用）。
    pub peer_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DingTalkInboundDto {
    pub msg_id: Option<String>,
    pub peer_id: String,
    pub nick: String,
    pub text: String,
    /// 消息类型：text / picture / audio …（非文本由渲染端如实说明只认文字）。
    pub msg_type: Option<String>,
    pub conversation_type: Option<String>,
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
}

impl Inner {
    fn status(&self) -> DingTalkStatusDto {
        DingTalkStatusDto {
            configured: self.credentials.is_some(),
            client_id: self
                .credentials
                .as_ref()
                .map(|credentials| credentials.client_id.clone()),
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

/// 钉钉通道宿主：凭证、联系人凭据与长连接任务代际。
///
/// `epoch` 与微信通道同义：disconnect / 重连 / 清除凭证都会递增它，
/// 旧任务在下一轮检查时自行退出。
pub struct DingTalkHost {
    inner: Arc<Mutex<Inner>>,
    epoch: Arc<AtomicU64>,
}

impl Default for DingTalkHost {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner::default())),
            epoch: Arc::new(AtomicU64::new(0)),
        }
    }
}

impl DingTalkHost {
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
            !credentials.client_id.trim().is_empty() && !credentials.client_secret.trim().is_empty()
        });
    inner.peers = read_json::<PeerBook>(&dir.join(PEERS_FILE)).unwrap_or_default();
    inner.state = "stopped".into();
    inner.loaded = true;
    Ok(())
}

fn persist_peers(app: &AppHandle, peers: &PeerBook) {
    let Ok(dir) = channel_dir(app, DIR_NAME) else {
        return;
    };
    match serde_json::to_vec_pretty(peers) {
        Ok(bytes) => {
            if let Err(error) = write_private(&dir.join(PEERS_FILE), &bytes) {
                log::warn("dingtalk", format!("联系人凭据落盘失败: {error}"));
            }
        }
        Err(error) => log::warn("dingtalk", format!("联系人凭据序列化失败: {error}")),
    }
}

/// 长连接的对外出口：事件广播 + 联系人凭据落盘。
pub(crate) struct StreamDeps {
    sink: EventSink,
    persist: Arc<dyn Fn(&PeerBook) + Send + Sync>,
}

impl StreamDeps {
    fn for_app(app: &AppHandle) -> Self {
        let handle = app.clone();
        Self {
            sink: app_sink(app),
            persist: Arc::new(move |peers: &PeerBook| persist_peers(&handle, peers)),
        }
    }

    fn emit(&self, event: &str, payload: serde_json::Value) {
        (self.sink)(event, payload);
    }
}

/// 广播当前状态（调用方已持有锁，这里只做序列化与派发）。
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

/// 一次连接的结局：服务端要求断开 / 连接被关闭。
#[derive(Debug, PartialEq)]
pub(crate) enum StreamEnd {
    Disconnected,
    Closed,
}

/// 跑一条连接直到断开（可单测：url 是参数，测试里指向本地 mock WS 服务器）。
pub(crate) async fn stream_once(
    url: &str,
    deps: &StreamDeps,
    inner: &Mutex<Inner>,
    allow_other_senders: bool,
) -> Result<StreamEnd, String> {
    let (mut socket, _response) = tokio_tungstenite::connect_async(url)
        .await
        .map_err(|error| format!("WebSocket 建连失败: {error}"))?;
    set_state(inner, deps, "connected", None).await;

    let mut ping = tokio::time::interval(PING_INTERVAL);
    ping.tick().await; // 首个 tick 立即返回，跳过

    loop {
        tokio::select! {
            _ = ping.tick() => {
                if let Err(error) = socket.send(Message::Ping(Vec::new().into())).await {
                    return Err(format!("心跳失败: {error}"));
                }
            }
            incoming = futures_util::StreamExt::next(&mut socket) => {
                let Some(message) = incoming else {
                    return Ok(StreamEnd::Closed);
                };
                let message = message.map_err(|error| format!("连接读取失败: {error}"))?;
                match message {
                    Message::Text(raw) => {
                        let frame = match parse_frame(raw.as_str()) {
                            Ok(frame) => frame,
                            Err(error) => {
                                log::warn("dingtalk", error);
                                continue;
                            }
                        };
                        let message_id = frame.headers.message_id.clone();
                        match frame.kind.as_str() {
                            "SYSTEM" => {
                                if let Some(id) = message_id.as_deref() {
                                    let _ = socket.send(Message::text(ack_payload(id))).await;
                                }
                                if frame.headers.topic.as_deref() == Some("disconnect") {
                                    log::info("dingtalk", "服务端要求断开，准备重连");
                                    return Ok(StreamEnd::Disconnected);
                                }
                            }
                            "CALLBACK" if frame.headers.topic.as_deref() == Some(CHATBOT_TOPIC) => {
                                handle_chatbot_frame(&frame, deps, inner, allow_other_senders).await;
                                if let Some(id) = message_id.as_deref() {
                                    let _ = socket.send(Message::text(ack_payload(id))).await;
                                }
                            }
                            other => {
                                // 其它订阅（事件 / 卡片回调）：本项目只订阅机器人消息，回执后忽略。
                                log::info("dingtalk", format!("忽略未订阅的帧 type={other}"));
                                if let Some(id) = message_id.as_deref() {
                                    let _ = socket.send(Message::text(ack_payload(id))).await;
                                }
                            }
                        }
                    }
                    Message::Close(_) => return Ok(StreamEnd::Closed),
                    _ => {}
                }
            }
        }
    }
}

async fn handle_chatbot_frame(
    frame: &StreamFrame,
    deps: &StreamDeps,
    inner: &Mutex<Inner>,
    allow_other_senders: bool,
) {
    let message = match serde_json::from_str::<ChatbotMessage>(&frame.data) {
        Ok(message) => message,
        Err(error) => {
            log::warn("dingtalk", format!("机器人消息解析失败: {error}"));
            return;
        }
    };
    let Some(peer_id) = message.peer_key() else {
        log::warn("dingtalk", "消息缺少发送者标识，忽略");
        return;
    };
    let text = message.body_text();
    let inbound = {
        let mut guard = inner.lock().await;
        // 第一个发消息的人是这台机器的默认主人；其他人要不要答复由设置决定。
        guard.peers.claim_owner(&peer_id);
        guard.peers.remember(&peer_id, &message);
        let allowed = allow_other_senders || guard.peers.owner.as_deref() == Some(peer_id.as_str());
        let at = message
            .create_at
            .filter(|value| *value > 0)
            .unwrap_or_else(now_ms);
        if guard.last_message_at.map(|last| at > last).unwrap_or(true) {
            guard.last_message_at = Some(at);
        }
        emit_state(&guard, deps);
        (guard.peers.clone(), allowed, at)
    };
    let (peers, allowed, at) = inbound;
    (deps.persist)(&peers);
    if !allowed {
        log::info(
            "dingtalk",
            format!("忽略非授权发送者 {peer_id}（可在设置中允许其他联系人）"),
        );
        return;
    }
    let payload = DingTalkInboundDto {
        msg_id: message.msg_id.clone(),
        peer_id,
        nick: message.display_nick(),
        text,
        msg_type: message.msgtype.clone(),
        conversation_type: message.conversation_type.clone(),
        at,
    };
    deps.emit(
        INBOUND_EVENT,
        serde_json::to_value(payload).unwrap_or(serde_json::Value::Null),
    );
}

/* ===== 宿主层：Tauri 命令 ===== */

/// 当前通道状态（是否已配置凭证、长连接状态、已建档联系人数）。
#[tauri::command]
pub async fn dingtalk_status(
    app: AppHandle,
    host: State<'_, DingTalkHost>,
) -> Result<DingTalkStatusDto, String> {
    let mut inner = host.lock().await;
    ensure_loaded(&app, &mut inner)?;
    Ok(inner.status())
}

/// 保存应用凭证（clientId = AppKey，clientSecret = AppSecret）。
/// `client_secret` 缺省表示仅更新 clientId / 保持原密钥不变。
#[tauri::command]
pub async fn dingtalk_save_credentials(
    app: AppHandle,
    host: State<'_, DingTalkHost>,
    client_id: String,
    client_secret: Option<String>,
) -> Result<DingTalkStatusDto, String> {
    let client_id = client_id.trim().to_string();
    if client_id.is_empty() {
        return Err("clientId 不能为空".into());
    }
    let mut inner = host.lock().await;
    ensure_loaded(&app, &mut inner)?;
    let secret = client_secret
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            inner
                .credentials
                .as_ref()
                .map(|credentials| credentials.client_secret.clone())
        });
    let Some(secret) = secret else {
        return Err("clientSecret 不能为空".into());
    };
    let credentials = StoredCredentials {
        client_id,
        client_secret: secret,
        saved_at: Some(chrono::Utc::now().to_rfc3339()),
    };
    let dir = channel_dir(&app, DIR_NAME)?;
    let bytes = serde_json::to_vec_pretty(&credentials)
        .map_err(|error| format!("凭证序列化失败: {error}"))?;
    write_private(&dir.join(CREDENTIALS_FILE), &bytes)?;
    inner.credentials = Some(credentials);
    inner.detail = None;
    log::info("dingtalk", "应用凭证已保存");
    Ok(inner.status())
}

/// 清除凭证与联系人凭据（相当于退出登录）。
#[tauri::command]
pub async fn dingtalk_clear_credentials(
    app: AppHandle,
    host: State<'_, DingTalkHost>,
) -> Result<DingTalkStatusDto, String> {
    host.epoch.fetch_add(1, Ordering::SeqCst);
    let mut inner = host.lock().await;
    ensure_loaded(&app, &mut inner)?;
    inner.credentials = None;
    inner.peers = PeerBook::default();
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
    log::info("dingtalk", "凭证已清除");
    Ok(inner.status())
}

/// 启动 Stream 长连接（未配置凭证时报错，由界面引导去设置里填）。
#[tauri::command]
pub async fn dingtalk_connect(
    app: AppHandle,
    host: State<'_, DingTalkHost>,
    allow_other_senders: bool,
) -> Result<(), String> {
    let (client_id, client_secret) = {
        let mut inner = host.lock().await;
        ensure_loaded(&app, &mut inner)?;
        let credentials = inner.credentials.clone().ok_or("尚未配置钉钉应用凭证")?;
        inner.state = "connecting".into();
        inner.detail = None;
        (credentials.client_id, credentials.client_secret)
    };
    let epoch = host.epoch.fetch_add(1, Ordering::SeqCst) + 1;
    let inner = host.inner.clone();
    let epochs = host.epoch.clone();
    let deps = StreamDeps::for_app(&app);
    let handle = app.clone();
    set_state(&inner, &deps, "connecting", None).await;
    tauri::async_runtime::spawn(async move {
        run_stream(
            &handle,
            deps,
            inner,
            epochs,
            epoch,
            StreamCredentials {
                client_id,
                client_secret,
            },
            allow_other_senders,
        )
        .await;
    });
    Ok(())
}

/// 停止长连接（保留凭证与联系人凭据）。
#[tauri::command]
pub async fn dingtalk_disconnect(
    app: AppHandle,
    host: State<'_, DingTalkHost>,
) -> Result<(), String> {
    host.epoch.fetch_add(1, Ordering::SeqCst);
    let mut inner = host.lock().await;
    ensure_loaded(&app, &mut inner)?;
    let deps = StreamDeps::for_app(&app);
    inner.state = "stopped".into();
    inner.detail = None;
    emit_state(&inner, &deps);
    Ok(())
}

/// 回一条文本给联系人（凭据在宿主侧：sessionWebhook 不出宿主）。
#[tauri::command]
pub async fn dingtalk_send(
    app: AppHandle,
    host: State<'_, DingTalkHost>,
    peer_id: String,
    text: String,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("回复内容为空".into());
    }
    let (record, owner) = {
        let mut inner = host.lock().await;
        ensure_loaded(&app, &mut inner)?;
        let now = now_ms();
        let record = inner
            .peers
            .live_webhook(&peer_id, now)
            .cloned()
            .ok_or("会话凭据不可用：等对方再发一条消息（钉钉的回复凭据约 30 分钟过期）")?;
        (record, Some(peer_id.clone()))
    };
    let client = crate::http::shared_client(10)?;
    reply_via_webhook(&client, &record.webhook, text.trim(), owner.as_deref()).await
}

/* ===== 宿主层：长连接主循环（带重连退避） ===== */

struct StreamCredentials {
    client_id: String,
    client_secret: String,
}

async fn run_stream(
    app: &AppHandle,
    deps: StreamDeps,
    inner: Arc<Mutex<Inner>>,
    epochs: Arc<AtomicU64>,
    epoch: u64,
    credentials: StreamCredentials,
    allow_other_senders: bool,
) {
    let mut attempt: u32 = 0;
    log::info("dingtalk", "Stream 长连接启动");
    while epochs.load(Ordering::SeqCst) == epoch {
        let client = match crate::http::shared_client(10) {
            Ok(client) => client,
            Err(error) => {
                set_state(&inner, &deps, "error", Some(error)).await;
                return;
            }
        };
        let connection =
            match open_stream(&client, &credentials.client_id, &credentials.client_secret).await {
                Ok(connection) => connection,
                Err(error) => {
                    attempt = attempt.saturating_add(1);
                    let wait = reconnect_delay(attempt);
                    log::warn("dingtalk", format!("建连失败({attempt}): {error}"));
                    set_state(&inner, &deps, "error", Some(error)).await;
                    if !sleep_or_stop(&epochs, epoch, wait).await {
                        break;
                    }
                    continue;
                }
            };
        let url = stream_url(&connection.endpoint, &connection.ticket);
        match stream_once(&url, &deps, &inner, allow_other_senders).await {
            Ok(end) => {
                log::info("dingtalk", format!("连接结束: {end:?}"));
                attempt = 0;
            }
            Err(error) => {
                attempt = attempt.saturating_add(1);
                log::warn("dingtalk", format!("连接异常({attempt}): {error}"));
                set_state(&inner, &deps, "error", Some(error)).await;
            }
        }
        if !sleep_or_stop(&epochs, epoch, reconnect_delay(attempt)).await {
            break;
        }
        set_state(&inner, &deps, "connecting", None).await;
    }
    log::info("dingtalk", "Stream 长连接已停止");
    let _ = app;
}

/// 指数退避（1s → 60s 上限）。
fn reconnect_delay(attempt: u32) -> Duration {
    let seconds = 1u64 << attempt.min(6);
    Duration::from_secs(seconds.min(RECONNECT_MAX_DELAY.as_secs()))
}

/* ===== 单测（纯函数） ===== */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_url_percent_encodes_ticket() {
        let url = stream_url("wss://example.com/stream", "a+b/c=d");
        assert_eq!(url, "wss://example.com/stream?ticket=a%2Bb%2Fc%3Dd");
    }

    #[test]
    fn open_body_subscribes_chatbot_topic() {
        let body = open_body("app-key", "app-secret");
        assert_eq!(body["clientId"], "app-key");
        assert_eq!(body["subscriptions"][0]["topic"], CHATBOT_TOPIC);
        assert_eq!(body["subscriptions"][0]["type"], "CALLBACK");
    }

    #[test]
    fn parse_frame_reads_type_headers_and_data_string() {
        let raw = r#"{"specVersion":"1.0","type":"CALLBACK","headers":{"messageId":"m-1","topic":"/v1.0/im/bot/messages/get","contentType":"application/json"},"data":"{\"text\":{\"content\":\"你好\"}}"}"#;
        let frame = parse_frame(raw).expect("frame");
        assert_eq!(frame.kind, "CALLBACK");
        assert_eq!(frame.headers.message_id.as_deref(), Some("m-1"));
        let message: ChatbotMessage = serde_json::from_str(&frame.data).expect("message");
        assert_eq!(message.body_text(), "你好");
    }

    #[test]
    fn ack_payload_echoes_message_id() {
        let ack: serde_json::Value = serde_json::from_str(&ack_payload("m-9")).expect("ack");
        assert_eq!(ack["code"], 200);
        assert_eq!(ack["headers"]["messageId"], "m-9");
        assert_eq!(ack["headers"]["contentType"], "application/json");
    }

    #[test]
    fn chatbot_message_maps_peer_text_and_webhook() {
        let raw = r#"{"msgId":"msg-1","senderStaffId":"staff-1","senderNick":"阿甲","conversationId":"cid-1","conversationType":"1","sessionWebhook":"https://oapi.dingtalk.com/robot/sendBySession?session=x","sessionWebhookExpiredTime":1730000000000,"createAt":1729999999000,"text":{"content":"@机器人 帮我看看今天的安排"}}"#;
        let message: ChatbotMessage = serde_json::from_str(raw).expect("message");
        assert_eq!(message.peer_key().as_deref(), Some("staff-1"));
        assert_eq!(message.display_nick(), "阿甲");
        // 群聊 @ 前缀被剥掉
        assert_eq!(message.body_text(), "帮我看看今天的安排");
    }

    #[test]
    fn reply_body_carries_at_and_text() {
        let body = reply_body("收到", Some("staff-1"));
        assert_eq!(body["msgtype"], "text");
        assert_eq!(body["text"]["content"], "收到");
        assert_eq!(body["at"]["atUserIds"][0], "staff-1");
        // 没有 staffId（群聊兜底）时不拼 at 字段，避免 @ 到空气
        let no_at = reply_body("收到", None);
        assert!(no_at["at"]
            .as_object()
            .map(|map| map.is_empty())
            .unwrap_or(false));
    }

    #[test]
    fn peer_book_claims_owner_once_and_tracks_webhook_ttl() {
        let mut book = PeerBook::default();
        let raw = r#"{"senderStaffId":"staff-1","sessionWebhook":"https://x.test/hook","sessionWebhookExpiredTime":2000,"senderNick":"甲"}"#;
        let message: ChatbotMessage = serde_json::from_str(raw).expect("message");
        assert!(book.claim_owner("staff-1"));
        assert!(!book.claim_owner("staff-2"), "主人只认第一个发消息的人");
        assert!(book.remember("staff-1", &message));
        assert!(book.live_webhook("staff-1", 1000).is_some());
        assert!(
            book.live_webhook("staff-1", 3000).is_none(),
            "过期凭据不再可用"
        );
    }

    /* ===== 长连接：对本地 mock WS 服务器跑完整一轮 ===== */

    /// 起一个 mock Stream 服务端：推一条机器人消息 → 校验 ack → 推一条他人消息 → 要求断开。
    async fn spawn_stream_server() -> String {
        use futures_util::StreamExt;
        use tokio_tungstenite::tungstenite::Message;

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
            let message = |id: &str, staff: &str, content: &str| {
                let payload = serde_json::json!({
                    "msgId": format!("msg-{id}"),
                    "senderStaffId": staff,
                    "senderNick": staff,
                    "conversationId": "cid-1",
                    "conversationType": "1",
                    "sessionWebhook": "https://oapi.dingtalk.com/robot/sendBySession?session=x",
                    "sessionWebhookExpiredTime": now_ms() + 60_000,
                    "createAt": now_ms(),
                    "msgtype": "text",
                    "text": { "content": content },
                });
                serde_json::json!({
                    "specVersion": "1.0",
                    "type": "CALLBACK",
                    "headers": { "messageId": id, "topic": CHATBOT_TOPIC, "contentType": "application/json" },
                    "data": payload.to_string(),
                })
                .to_string()
            };
            let _ = socket
                .send(Message::text(message(
                    "m-1",
                    "staff-1",
                    "帮我看看今天的安排",
                )))
                .await;
            // 等服务端回执（必须是同一 messageId）
            if let Some(Ok(Message::Text(ack))) = socket.next().await {
                let ack: serde_json::Value = serde_json::from_str(ack.as_str()).expect("ack json");
                assert_eq!(ack["code"], 200);
                assert_eq!(ack["headers"]["messageId"], "m-1");
            }
            let _ = socket
                .send(Message::text(message("m-2", "staff-2", "外人的消息")))
                .await;
            let _ = socket.next().await;
            let disconnect = serde_json::json!({
                "specVersion": "1.0",
                "type": "SYSTEM",
                "headers": { "messageId": "sys-1", "topic": "disconnect" },
                "data": "{}",
            })
            .to_string();
            let _ = socket.send(Message::text(disconnect)).await;
            let _ = socket.next().await;
            // 让连接活到客户端读完
            tokio::time::sleep(Duration::from_millis(200)).await;
        });
        format!("ws://{addr}")
    }

    #[tokio::test]
    async fn stream_once_emits_authorized_inbound_and_acks_frames() {
        let url = spawn_stream_server().await;
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
        };
        let inner = Mutex::new(Inner::default());

        let end = tokio::time::timeout(
            Duration::from_secs(5),
            stream_once(&url, &deps, &inner, false),
        )
        .await
        .expect("长连接应自行结束")
        .expect("连接不应报错");
        assert_eq!(
            end,
            StreamEnd::Disconnected,
            "服务端 disconnect 应作为断开结局"
        );

        let inbound: Vec<serde_json::Value> = events
            .lock()
            .iter()
            .filter(|(event, _)| event == INBOUND_EVENT)
            .map(|(_, payload)| payload.clone())
            .collect();
        assert_eq!(inbound.len(), 1, "默认只放行归属人的消息：{inbound:?}");
        assert_eq!(inbound[0]["peerId"], "staff-1");
        assert_eq!(inbound[0]["text"], "帮我看看今天的安排");
        assert_eq!(inbound[0]["msgType"], "text");
        assert_eq!(inbound[0]["msgId"], "msg-m-1");

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

        let book = persisted.lock().clone().expect("联系人凭据应落盘");
        assert_eq!(book.owner.as_deref(), Some("staff-1"));
        assert!(
            book.live_webhook("staff-1", now_ms()).is_some(),
            "应记住可回发的 webhook"
        );
    }

    #[test]
    fn reconnect_delay_caps_at_one_minute() {
        assert_eq!(reconnect_delay(0), Duration::from_secs(1));
        assert_eq!(reconnect_delay(3), Duration::from_secs(8));
        assert_eq!(reconnect_delay(20), RECONNECT_MAX_DELAY);
    }
}
