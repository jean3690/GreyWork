//! QQ 通道（QQ 开放平台机器人，官方 WebSocket 网关 + OpenAPI）。
//!
//! 与其余通道同构：协议差异在本模块收敛，宿主侧动作（事件广播、凭证落盘、代际可中断
//! 等待）复用 [`crate::channel_common`]。选它的理由是 QQ 官方给的是**网关长连接**
//! （`/gateway/bot` 下发 wss 地址 + 心跳 + 断线 resume），桌面端不需要公网回调。
//!
//! 安全与边界：
//! - AppSecret 与 access_token 都只在宿主内存/磁盘（0600），渲染端只传文本与对端 id；
//! - 归属人策略：第一个来消息的 QQ 用户成为默认主人，其他人是否答复由设置决定；
//! - **被动回复**：QQ 要求带着入站消息的 `msg_id` 回（5 分钟有效，同一 `msg_id +
//!   msg_seq` 只能发一次），所以回发凭据（msg_id）与序号都留在宿主，渲染端不碰。

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message;

use crate::channel_common::{
    app_sink, channel_dir, now_ms, read_json, sleep_or_stop, write_private, EventSink,
};
use crate::http::{read_text, shared_client, RESPONSE_READ_TIMEOUT};
use crate::log;

const DIR_NAME: &str = "qq";
const CREDENTIALS_FILE: &str = "credentials.json";
const PEERS_FILE: &str = "peers.json";

pub const STATE_EVENT: &str = "qq://state";
pub const INBOUND_EVENT: &str = "qq://inbound";

/// 取 access_token（官方新版接入票据接口）。
const TOKEN_URL: &str = "https://api.bot.qq.com/app/getAppAccessToken";
/// OpenAPI 根（网关地址也在这里取）。
const API_BASE: &str = "https://api.sgroup.qq.com";
/// 机器人接入票据：公域群 / C2C 消息事件（`GROUP_AND_C2C_EVENT`，1 << 25）。
/// 只订阅这一位：频道（公会）事件与论坛事件与「手机 QQ 里跟机器人聊天」无关。
const INTENTS_PUBLIC_MESSAGES: i64 = 1 << 25;
/// 心跳兜底间隔：正常用网关 hello 下发的 `heartbeat_interval`，缺失时按 30s。
const FALLBACK_HEARTBEAT: Duration = Duration::from_secs(30);
/// 单条文本上限（QQ 文本消息 1000 字符量级，这里取保守值）。
const MAX_TEXT_CHARS: usize = 1000;
/// access_token 提前刷新窗口（官方说明：到期前 60s 内取会拿到新 token）。
const TOKEN_REFRESH_MARGIN_SECS: i64 = 60;

/* ===== 协议形状 ===== */

#[derive(Debug, Clone, Deserialize)]
struct TokenResponse {
    #[serde(default)]
    access_token: Option<String>,
    /// 官方返回的是字符串（`"7200"`），这里按兼容处理。
    #[serde(default)]
    expires_in: Option<serde_json::Value>,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct GatewayResponse {
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

/// 网关下行帧。
#[derive(Debug, Clone, Deserialize)]
struct GatewayFrame {
    op: i64,
    #[serde(default)]
    t: Option<String>,
    #[serde(default)]
    s: Option<i64>,
    #[serde(default)]
    d: Option<serde_json::Value>,
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
    pub at: i64,
}

/// 归一条 dispatch 事件；不认识的 `t` 返回 None。
pub fn normalize_dispatch(
    event: &str,
    data: &serde_json::Value,
    received_at: i64,
) -> Option<QqInboundDto> {
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
    let at = payload
        .timestamp
        .as_deref()
        .and_then(|raw| raw.parse::<i64>().ok())
        .filter(|seconds| *seconds > 0)
        .map(|seconds| seconds.saturating_mul(1000))
        .unwrap_or(received_at);
    let peer_id = encode_peer(&scope, &openid);
    Some(QqInboundDto {
        message_id: payload.id,
        nick: peer_id.clone(),
        peer_id,
        sender_id,
        text: payload.content.unwrap_or_default(),
        at,
    })
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
fn parse_expires_in(raw: Option<&serde_json::Value>) -> i64 {
    match raw {
        Some(serde_json::Value::String(text)) => text.parse::<i64>().unwrap_or(7200),
        Some(serde_json::Value::Number(number)) => number.as_i64().unwrap_or(7200),
        _ => 7200,
    }
}

/// 鉴权头：官方格式 `QQBot {access_token}`。
fn auth_header(token: &str) -> String {
    format!("QQBot {token}")
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

/// 联系人与「谁在用这台机器」的归属人 + 被动回复凭据。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerBook {
    /// 第一个来消息的 QQ 用户 = 默认只答复的主人。
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub peers: BTreeMap<String, PeerRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerRecord {
    #[serde(default)]
    pub msg_id: String,
    /// 同一 `msg_id` 的回复序号：每次回发 +1（重复的 msg_id + msg_seq 会被服务端拒绝）。
    #[serde(default)]
    pub msg_seq: u64,
    #[serde(default)]
    pub last_at: i64,
}

impl PeerBook {
    /// 记录被动回复凭据；`msg_id` 变了就把序号重置为 0（新消息重新计数）。
    pub fn remember(&mut self, peer: &str, msg_id: &str, at: i64) {
        let entry = self.peers.entry(peer.to_string()).or_insert(PeerRecord {
            msg_id: msg_id.to_string(),
            msg_seq: 0,
            last_at: at,
        });
        if entry.msg_id != msg_id {
            entry.msg_id = msg_id.to_string();
            entry.msg_seq = 0;
        }
        entry.last_at = at;
    }

    /// 取下一次回发要用的 (msg_id, msg_seq)。
    pub fn next_reply(&mut self, peer: &str) -> Option<(String, u64)> {
        let entry = self.peers.get_mut(peer)?;
        if entry.msg_id.is_empty() {
            return None;
        }
        entry.msg_seq += 1;
        Some((entry.msg_id.clone(), entry.msg_seq))
    }

    pub fn claim_owner(&mut self, sender: &str) -> bool {
        if self.owner.is_some() {
            return false;
        }
        self.owner = Some(sender.to_string());
        true
    }

    pub fn allows(&self, sender: &str, allow_other_senders: bool) -> bool {
        allow_other_senders || self.owner.as_deref() == Some(sender)
    }
}

/* ===== 宿主层：状态与命令 ===== */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QqStatusDto {
    /// 是否已保存 AppID + AppSecret。
    pub configured: bool,
    /// 非秘密的 AppID（展示出来便于确认填对了）。
    pub app_id: Option<String>,
    /// stopped / connecting / connected / error
    pub state: String,
    pub detail: Option<String>,
    pub last_message_at: Option<i64>,
    pub peer_count: usize,
}

#[derive(Default)]
pub(crate) struct Inner {
    loaded: bool,
    credentials: Option<StoredCredentials>,
    peers: PeerBook,
    state: String,
    detail: Option<String>,
    last_message_at: Option<i64>,
    /// access_token 缓存（含过期时间戳，秒）。
    access_token: Option<String>,
    token_expires_at: i64,
    /// 网关会话：断线 resume 用（session_id + 最后事件序号）。
    session_id: Option<String>,
    last_seq: i64,
}

impl Inner {
    fn status(&self) -> QqStatusDto {
        QqStatusDto {
            configured: self.credentials.is_some(),
            app_id: self.credentials.as_ref().map(|item| item.app_id.clone()),
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

/// QQ 通道宿主：凭证、联系人凭据与网关任务代际。
pub struct QqHost {
    inner: Arc<Mutex<Inner>>,
    epoch: Arc<AtomicU64>,
}

impl Default for QqHost {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner::default())),
            epoch: Arc::new(AtomicU64::new(0)),
        }
    }
}

impl QqHost {
    async fn lock(&self) -> tokio::sync::MutexGuard<'_, Inner> {
        self.inner.lock().await
    }
}

fn ensure_loaded(app: &AppHandle, inner: &mut Inner) -> Result<(), String> {
    if inner.loaded {
        return Ok(());
    }
    let dir = channel_dir(app, DIR_NAME)?;
    inner.credentials = read_json::<StoredCredentials>(&dir.join(CREDENTIALS_FILE))
        .filter(|item| !item.app_id.trim().is_empty() && !item.app_secret.trim().is_empty());
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
                log::warn("qq", format!("联系人凭据落盘失败: {error}"));
            }
        }
        Err(error) => log::warn("qq", format!("联系人凭据序列化失败: {error}")),
    }
}

/// 网关的对外出口：事件广播 + 联系人凭据落盘 + 本次连接的发送者策略。
pub(crate) struct GatewayDeps {
    sink: EventSink,
    persist: Arc<dyn Fn(&PeerBook) + Send + Sync>,
    /// 除归属人外是否也答复其他人（连接建立时定下，改设置后重连生效）。
    allow_other_senders: bool,
}

impl GatewayDeps {
    fn for_app(app: &AppHandle) -> Self {
        let handle = app.clone();
        Self {
            sink: app_sink(app),
            persist: Arc::new(move |peers: &PeerBook| persist_peers(&handle, peers)),
            allow_other_senders: false,
        }
    }

    fn emit(&self, event: &str, payload: serde_json::Value) {
        (self.sink)(event, payload);
    }
}

fn emit_state(inner: &Inner, deps: &GatewayDeps) {
    deps.emit(
        STATE_EVENT,
        serde_json::to_value(inner.status()).unwrap_or(serde_json::Value::Null),
    );
}

async fn set_state(inner: &Mutex<Inner>, deps: &GatewayDeps, state: &str, detail: Option<String>) {
    let mut guard = inner.lock().await;
    guard.state = state.to_string();
    guard.detail = detail;
    emit_state(&guard, deps);
}

/* ===== 宿主层：HTTP（token 与网关地址） ===== */

/// 取/复用 access_token：到期前 `TOKEN_REFRESH_MARGIN_SECS` 内重新取。
pub(crate) async fn ensure_token(
    client: &reqwest::Client,
    inner: &Mutex<Inner>,
) -> Result<String, String> {
    let (app_id, app_secret, cached, expires_at) = {
        let guard = inner.lock().await;
        let credentials = guard
            .credentials
            .clone()
            .ok_or("尚未配置 QQ 机器人 AppID / AppSecret")?;
        (
            credentials.app_id,
            credentials.app_secret,
            guard.access_token.clone(),
            guard.token_expires_at,
        )
    };
    if let Some(token) = cached {
        if expires_at - TOKEN_REFRESH_MARGIN_SECS > chrono::Utc::now().timestamp() {
            return Ok(token);
        }
    }
    let response = client
        .post(TOKEN_URL)
        .json(&serde_json::json!({ "appId": app_id, "clientSecret": app_secret }))
        .send()
        .await
        .map_err(|error| format!("取 access_token 失败: {error}"))?;
    let status = response.status();
    let body = read_text(response, RESPONSE_READ_TIMEOUT)
        .await
        .map_err(|error| format!("access_token 响应读取失败: {error}"))?;
    if !status.is_success() {
        return Err(format!("取 access_token 返回 {status}: {}", brief(&body)));
    }
    let parsed: TokenResponse = serde_json::from_str(&body)
        .map_err(|error| format!("access_token 响应解析失败: {error}"))?;
    let token = parsed
        .access_token
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            format!(
                "取 access_token 被拒：{}",
                parsed
                    .message
                    .unwrap_or_else(|| "响应里没有 access_token".into())
            )
        })?;
    let ttl = parse_expires_in(parsed.expires_in.as_ref());
    let mut guard = inner.lock().await;
    guard.access_token = Some(token.clone());
    guard.token_expires_at = chrono::Utc::now().timestamp() + ttl;
    Ok(token)
}

/// 取网关地址（`GET /gateway/bot`）。
pub(crate) async fn gateway_url(client: &reqwest::Client, token: &str) -> Result<String, String> {
    let response = client
        .get(format!("{API_BASE}/gateway/bot"))
        .header("Authorization", auth_header(token))
        .send()
        .await
        .map_err(|error| format!("取网关地址失败: {error}"))?;
    let status = response.status();
    let body = read_text(response, RESPONSE_READ_TIMEOUT)
        .await
        .map_err(|error| format!("网关地址响应读取失败: {error}"))?;
    if !status.is_success() {
        return Err(format!("取网关地址返回 {status}: {}", brief(&body)));
    }
    let parsed: GatewayResponse =
        serde_json::from_str(&body).map_err(|error| format!("网关地址响应解析失败: {error}"))?;
    parsed
        .url
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            format!(
                "网关地址不可用：{}",
                parsed.message.unwrap_or_else(|| "响应里没有 url".into())
            )
        })
}

/// 被动回复一条文本（5 分钟窗口内、同一 msg_id 至多 5 条）。
pub(crate) async fn send_text(
    client: &reqwest::Client,
    token: &str,
    peer_id: &str,
    text: &str,
    msg_id: &str,
    msg_seq: u64,
) -> Result<(), String> {
    let (scope, openid) = decode_peer(peer_id).ok_or(format!("对端 id 无法解析: {peer_id:?}"))?;
    let path = match scope {
        ChatScope::C2c => format!("{API_BASE}/v2/users/{openid}/messages"),
        ChatScope::Group => format!("{API_BASE}/v2/groups/{openid}/messages"),
    };
    let response = client
        .post(path)
        .header("Authorization", auth_header(token))
        .json(&reply_payload(text, msg_id, msg_seq))
        .send()
        .await
        .map_err(|error| format!("发送消息失败: {error}"))?;
    let status = response.status();
    let body = read_text(response, RESPONSE_READ_TIMEOUT)
        .await
        .map_err(|error| format!("发送响应读取失败: {error}"))?;
    if !status.is_success() {
        return Err(format!("发送消息返回 {status}: {}", brief(&body)));
    }
    // 业务错误也走 200 + 错误码：能解析出 code 就按错误处理，否则视为成功。
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&body) {
        if let Some(code) = parsed.get("code").and_then(serde_json::Value::as_i64) {
            if code != 0 {
                let message = parsed
                    .get("message")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("unknown error");
                return Err(format!("QQ 拒绝了这条消息（{code}）：{message}"));
            }
        }
    }
    Ok(())
}

/// 错误体只留一段摘要。
fn brief(text: &str) -> String {
    let trimmed = text.trim();
    let head: String = trimmed.chars().take(200).collect();
    if trimmed.chars().count() > 200 {
        format!("{head}…")
    } else {
        head
    }
}

/* ===== 宿主层：网关主循环 ===== */

/// 一次连接的结果（与钉钉同形：可单测、可被代际打断）。
#[derive(Debug, PartialEq)]
pub(crate) enum GatewayEnd {
    /// 服务端要求重新连接（op 7）或连接自然断开。
    Reconnect,
    Closed,
}

/// 建连 → hello → identify/resume → 收帧直到断开。
pub(crate) async fn gateway_once(
    url: &str,
    token: &str,
    deps: &GatewayDeps,
    inner: &Mutex<Inner>,
) -> Result<GatewayEnd, String> {
    let (mut socket, _response) = tokio_tungstenite::connect_async(url)
        .await
        .map_err(|error| format!("WebSocket 建连失败: {error}"))?;

    let (resume, heartbeat) = {
        let guard = inner.lock().await;
        (
            guard
                .session_id
                .clone()
                .filter(|value| !value.is_empty())
                .map(|session_id| (session_id, guard.last_seq)),
            FALLBACK_HEARTBEAT,
        )
    };

    // 第一帧应是 hello（op 10），拿心跳间隔。
    let hello = next_text(&mut socket).await?;
    let hello: GatewayFrame =
        serde_json::from_str(&hello).map_err(|error| format!("网关 hello 解析失败: {error}"))?;
    if hello.op != 10 {
        return Err(format!("网关首帧不是 hello（op={}）", hello.op));
    }
    let interval = hello
        .d
        .as_ref()
        .and_then(|data| data.get("heartbeat_interval"))
        .and_then(serde_json::Value::as_u64)
        .filter(|value| *value > 0)
        .map(Duration::from_millis)
        .unwrap_or(heartbeat);

    // identify 或 resume。
    let auth = match resume {
        Some((session_id, seq)) => serde_json::json!({
            "op": 6,
            "d": { "token": auth_header(token), "session_id": session_id, "seq": seq },
        }),
        None => serde_json::json!({
            "op": 2,
            "d": { "token": auth_header(token), "intents": INTENTS_PUBLIC_MESSAGES, "shard": [0, 1] },
        }),
    };
    socket
        .send(Message::text(auth.to_string()))
        .await
        .map_err(|error| format!("鉴权帧发送失败: {error}"))?;
    set_state(inner, deps, "connected", None).await;

    let mut heartbeat_task = tokio::time::interval(interval);
    heartbeat_task.tick().await; // 跳过立即触发的首个 tick

    loop {
        tokio::select! {
            _ = heartbeat_task.tick() => {
                let seq = { inner.lock().await.last_seq };
                let payload = serde_json::json!({ "op": 1, "d": seq });
                if let Err(error) = socket.send(Message::text(payload.to_string())).await {
                    return Err(format!("心跳发送失败: {error}"));
                }
            }
            incoming = socket.next() => {
                let Some(frame) = incoming else {
                    return Ok(GatewayEnd::Closed);
                };
                let raw = match frame {
                    Ok(Message::Text(text)) => text.to_string(),
                    Ok(Message::Close(_)) => return Ok(GatewayEnd::Closed),
                    Ok(_) => continue,
                    Err(error) => return Err(format!("网关读取失败: {error}")),
                };
                let parsed: GatewayFrame = match serde_json::from_str(&raw) {
                    Ok(parsed) => parsed,
                    Err(error) => {
                        log::warn("qq", format!("网关帧解析失败: {error}"));
                        continue;
                    }
                };
                match parsed.op {
                    // 事件下发
                    0 => {
                        if let Some(seq) = parsed.s {
                            let mut guard = inner.lock().await;
                            guard.last_seq = seq;
                        }
                        if let Some(kind) = parsed.t.as_deref() {
                            match kind {
                                "READY" => {
                                    if let Some(session_id) = parsed
                                        .d
                                        .as_ref()
                                        .and_then(|data| data.get("session_id"))
                                        .and_then(serde_json::Value::as_str)
                                    {
                                        let mut guard = inner.lock().await;
                                        guard.session_id = Some(session_id.to_string());
                                        guard.last_seq = 0;
                                    }
                                    set_state(inner, deps, "connected", None).await;
                                }
                                "RESUMED" => set_state(inner, deps, "connected", None).await,
                                _ => {
                                    if let Some(data) = parsed.d.as_ref() {
                                        handle_dispatch(kind, data, deps, inner).await;
                                    }
                                }
                            }
                        }
                    }
                    // 心跳 ACK / hello（重复）
                    11 | 10 => {}
                    // 服务端要求重连
                    7 => return Ok(GatewayEnd::Reconnect),
                    // 鉴权失败：清掉 token 与会话，下轮 identify 重新取
                    9 => {
                        let mut guard = inner.lock().await;
                        guard.access_token = None;
                        guard.token_expires_at = 0;
                        guard.session_id = None;
                        if guard.invalid_session_fatal(parsed.d.as_ref()) {
                            return Err("网关拒绝本次鉴权（intents 或票据无效）".into());
                        }
                        return Ok(GatewayEnd::Reconnect);
                    }
                    other => {
                        log::info("qq", format!("忽略未处理的网关帧 op={other}"));
                    }
                }
            }
        }
    }
}

impl Inner {
    /// op 9 的 `d` 为 true 表示「不可恢复」，只能重新 identify；false 可直接 resume。
    fn invalid_session_fatal(&self, data: Option<&serde_json::Value>) -> bool {
        data.and_then(serde_json::Value::as_bool).unwrap_or(true)
    }
}

async fn next_text(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> Result<String, String> {
    loop {
        let frame = socket
            .next()
            .await
            .ok_or("网关在握手前关闭")?
            .map_err(|error| format!("网关握手读取失败: {error}"))?;
        match frame {
            Message::Text(text) => return Ok(text.to_string()),
            Message::Close(_) => return Err("网关在握手前关闭".into()),
            _ => continue,
        }
    }
}

/// 一条业务事件：归属人判定 → 更新凭据与状态 → 允许则广播。
async fn handle_dispatch(
    event: &str,
    data: &serde_json::Value,
    deps: &GatewayDeps,
    inner: &Mutex<Inner>,
) {
    let Some(message) = normalize_dispatch(event, data, now_ms()) else {
        return;
    };
    let (peers, allowed) = {
        let mut guard = inner.lock().await;
        guard.peers.claim_owner(&message.sender_id);
        guard
            .peers
            .remember(&message.peer_id, &message.message_id, message.at);
        if guard
            .last_message_at
            .map(|last| message.at > last)
            .unwrap_or(true)
        {
            guard.last_message_at = Some(message.at);
        }
        let allowed = guard
            .peers
            .allows(&message.sender_id, deps.allow_other_senders);
        emit_state(&guard, deps);
        (guard.peers.clone(), allowed)
    };
    (deps.persist)(&peers);
    if !allowed {
        log::info(
            "qq",
            format!(
                "忽略非授权发送者 {}（可在设置中允许其他联系人）",
                message.sender_id
            ),
        );
        return;
    }
    deps.emit(
        INBOUND_EVENT,
        serde_json::to_value(message).unwrap_or(serde_json::Value::Null),
    );
}

/// 指数退避（1s → 60s）。
fn reconnect_delay(attempt: u32) -> Duration {
    let seconds = 1u64 << attempt.min(6);
    Duration::from_secs(seconds.min(60))
}

async fn run_gateway(
    deps: GatewayDeps,
    inner: Arc<Mutex<Inner>>,
    epochs: Arc<AtomicU64>,
    epoch: u64,
) {
    let mut attempt: u32 = 0;
    log::info("qq", "网关长连接启动");
    while epochs.load(Ordering::SeqCst) == epoch {
        let client = match shared_client(10) {
            Ok(client) => client,
            Err(error) => {
                set_state(&inner, &deps, "error", Some(error)).await;
                return;
            }
        };
        let url = match ensure_token(&client, &inner).await {
            Ok(token) => match gateway_url(&client, &token).await {
                Ok(url) => Some((url, token)),
                Err(error) => {
                    attempt = attempt.saturating_add(1);
                    set_state(&inner, &deps, "error", Some(error.clone())).await;
                    log::warn("qq", format!("取网关地址失败({attempt}): {error}"));
                    None
                }
            },
            Err(error) => {
                attempt = attempt.saturating_add(1);
                set_state(&inner, &deps, "error", Some(error.clone())).await;
                log::warn("qq", format!("取 access_token 失败({attempt}): {error}"));
                None
            }
        };
        if let Some((url, token)) = url {
            match gateway_once(&url, &token, &deps, &inner).await {
                Ok(end) => {
                    log::info("qq", format!("网关连接结束: {end:?}"));
                    if end == GatewayEnd::Closed {
                        attempt = 0;
                    }
                }
                Err(error) => {
                    attempt = attempt.saturating_add(1);
                    log::warn("qq", format!("网关连接异常({attempt}): {error}"));
                    set_state(&inner, &deps, "error", Some(error)).await;
                }
            }
        }
        if !sleep_or_stop(&epochs, epoch, reconnect_delay(attempt)).await {
            break;
        }
        set_state(&inner, &deps, "connecting", None).await;
    }
    log::info("qq", "网关长连接已停止");
}

/* ===== 宿主层：Tauri 命令 ===== */

/// 当前通道状态（是否已配置凭证、网关状态、已建档联系人数）。
#[tauri::command]
pub async fn qq_status(app: AppHandle, host: State<'_, QqHost>) -> Result<QqStatusDto, String> {
    let mut inner = host.lock().await;
    ensure_loaded(&app, &mut inner)?;
    Ok(inner.status())
}

/// 保存 AppID / AppSecret（AppSecret 留空表示沿用已存密钥）。
#[tauri::command]
pub async fn qq_save_credentials(
    app: AppHandle,
    host: State<'_, QqHost>,
    app_id: String,
    app_secret: Option<String>,
) -> Result<QqStatusDto, String> {
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
                .map(|item| item.app_secret.clone())
        });
    let Some(secret) = secret else {
        return Err("AppSecret 不能为空".into());
    };
    let credentials = StoredCredentials {
        app_id,
        app_secret: secret,
        saved_at: Some(chrono::Utc::now().to_rfc3339()),
    };
    let dir = channel_dir(&app, DIR_NAME)?;
    let bytes = serde_json::to_vec_pretty(&credentials)
        .map_err(|error| format!("凭证序列化失败: {error}"))?;
    write_private(&dir.join(CREDENTIALS_FILE), &bytes)?;
    inner.credentials = Some(credentials);
    // 换了凭证就作废 token 与会话：旧票据属于上一个机器人。
    inner.access_token = None;
    inner.token_expires_at = 0;
    inner.session_id = None;
    inner.detail = None;
    log::info("qq", "AppID / AppSecret 已保存");
    Ok(inner.status())
}

/// 清除凭证与联系人凭据（相当于退出登录）。
#[tauri::command]
pub async fn qq_clear_credentials(
    app: AppHandle,
    host: State<'_, QqHost>,
) -> Result<QqStatusDto, String> {
    host.epoch.fetch_add(1, Ordering::SeqCst);
    let mut inner = host.lock().await;
    ensure_loaded(&app, &mut inner)?;
    inner.credentials = None;
    inner.peers = PeerBook::default();
    inner.access_token = None;
    inner.token_expires_at = 0;
    inner.session_id = None;
    inner.last_seq = 0;
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
    log::info("qq", "凭证已清除");
    Ok(inner.status())
}

/// 启动网关长连接（未配置凭证时报错，由界面引导去填）。
#[tauri::command]
pub async fn qq_connect(
    app: AppHandle,
    host: State<'_, QqHost>,
    allow_other_senders: bool,
) -> Result<(), String> {
    {
        let mut inner = host.lock().await;
        ensure_loaded(&app, &mut inner)?;
        if inner.credentials.is_none() {
            return Err("尚未配置 QQ 机器人 AppID / AppSecret".into());
        }
        inner.state = "connecting".into();
        inner.detail = None;
    }
    let epoch = host.epoch.fetch_add(1, Ordering::SeqCst) + 1;
    let inner = host.inner.clone();
    let epochs = host.epoch.clone();
    let mut deps = GatewayDeps::for_app(&app);
    deps.allow_other_senders = allow_other_senders;
    set_state(&inner, &deps, "connecting", None).await;
    tauri::async_runtime::spawn(async move {
        run_gateway(deps, inner, epochs, epoch).await;
    });
    Ok(())
}

/// 停止网关长连接（保留凭证与联系人凭据）。
#[tauri::command]
pub async fn qq_disconnect(app: AppHandle, host: State<'_, QqHost>) -> Result<(), String> {
    host.epoch.fetch_add(1, Ordering::SeqCst);
    let mut inner = host.lock().await;
    ensure_loaded(&app, &mut inner)?;
    let deps = GatewayDeps::for_app(&app);
    inner.state = "stopped".into();
    inner.detail = None;
    emit_state(&inner, &deps);
    Ok(())
}

/// 回一条文本（被动回复：带该会话最近一条入站消息的 msg_id）。
#[tauri::command]
pub async fn qq_send(
    app: AppHandle,
    host: State<'_, QqHost>,
    peer_id: String,
    text: String,
) -> Result<(), String> {
    let text = clamp_text(&text)?;
    let client = shared_client(10)?;
    {
        // 只做首次装载，随后立刻放锁：下面两步各自加锁，不能套着锁等网络。
        let mut inner = host.lock().await;
        ensure_loaded(&app, &mut inner)?;
    }
    let token = ensure_token(&client, &host.inner).await?;
    let (msg_id, msg_seq) = {
        let mut inner = host.lock().await;
        let reply = inner.peers.next_reply(&peer_id).ok_or(
            "会话凭据不可用：等对方再发一条消息（QQ 要求带回该消息的 msg_id，且只有 5 分钟窗口）",
        )?;
        let snapshot = inner.peers.clone();
        persist_peers(&app, &snapshot);
        reply
    };
    send_text(&client, &token, &peer_id, &text, &msg_id, msg_seq).await
}

/* ===== 单测（纯函数） ===== */

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn peer_id_roundtrip_by_scope() {
        assert_eq!(encode_peer(&ChatScope::C2c, "u1"), "c2c:u1");
        assert_eq!(encode_peer(&ChatScope::Group, "g1"), "group:g1");
        assert_eq!(decode_peer("c2c:u1"), Some((ChatScope::C2c, "u1".into())));
        assert_eq!(
            decode_peer("group:g1"),
            Some((ChatScope::Group, "g1".into()))
        );
        assert_eq!(decode_peer("u1"), None, "缺少范围前缀");
        assert_eq!(decode_peer("dm:u1"), None, "未知前缀");
        assert_eq!(decode_peer("c2c:"), None, "空 openid");
    }

    #[test]
    fn normalize_c2c_message_uses_sender_as_peer() {
        let data = json!({
            "id": "msg-1",
            "content": "你好",
            "timestamp": "1700000000",
            "author": { "user_openid": "USER1" },
        });
        let inbound = normalize_dispatch("C2C_MESSAGE_CREATE", &data, 999).expect("单聊消息");
        assert_eq!(inbound.peer_id, "c2c:USER1");
        assert_eq!(inbound.sender_id, "USER1");
        assert_eq!(inbound.message_id, "msg-1");
        assert_eq!(inbound.text, "你好");
        assert_eq!(inbound.at, 1_700_000_000_000);
    }

    #[test]
    fn normalize_group_message_keeps_group_peer_and_member_sender() {
        let data = json!({
            "id": "msg-2",
            "content": "<@!123> 干活",
            "group_openid": "GROUP1",
            "author": { "member_openid": "MEMBER1" },
        });
        let inbound = normalize_dispatch("GROUP_AT_MESSAGE_CREATE", &data, 1_700_000_000_500)
            .expect("群消息");
        assert_eq!(inbound.peer_id, "group:GROUP1", "回发要回群里");
        assert_eq!(inbound.sender_id, "MEMBER1", "归属人按成员判");
        assert_eq!(inbound.at, 1_700_000_000_500, "缺 timestamp 时用收包时间");
    }

    #[test]
    fn normalize_ignores_unknown_events_and_incomplete_payloads() {
        let data = json!({ "id": "msg-3", "author": { "user_openid": "U" } });
        assert!(
            normalize_dispatch("AT_MESSAGE_CREATE", &data, 1).is_none(),
            "频道消息不订阅"
        );
        assert!(normalize_dispatch("READY", &json!({}), 1).is_none());
        assert!(
            normalize_dispatch(
                "C2C_MESSAGE_CREATE",
                &json!({ "author": { "user_openid": "U" } }),
                1
            )
            .is_none(),
            "没有消息 id 无法被动回复"
        );
        assert!(
            normalize_dispatch(
                "GROUP_AT_MESSAGE_CREATE",
                &json!({ "id": "m", "author": {} }),
                1
            )
            .is_none(),
            "群消息缺 group_openid"
        );
    }

    #[test]
    fn peer_book_resets_seq_when_message_changes() {
        let mut book = PeerBook::default();
        book.remember("c2c:U", "m1", 10);
        assert_eq!(book.next_reply("c2c:U"), Some(("m1".into(), 1)));
        assert_eq!(book.next_reply("c2c:U"), Some(("m1".into(), 2)));
        book.remember("c2c:U", "m2", 20);
        assert_eq!(
            book.next_reply("c2c:U"),
            Some(("m2".into(), 1)),
            "新消息序号重置"
        );
        assert_eq!(book.next_reply("c2c:absent"), None, "没凭据就不发");
    }

    #[test]
    fn peer_book_owner_policy_gates_other_senders() {
        let mut book = PeerBook::default();
        assert!(book.claim_owner("U1"));
        assert!(!book.claim_owner("U2"));
        assert!(book.allows("U1", false));
        assert!(!book.allows("U2", false));
        assert!(book.allows("U2", true));
    }

    #[test]
    fn reply_payload_carries_passive_reply_fields() {
        let payload = reply_payload("hi", "msg-1", 3);
        assert_eq!(payload["content"], "hi");
        assert_eq!(payload["msg_type"], 0);
        assert_eq!(payload["msg_id"], "msg-1");
        assert_eq!(payload["msg_seq"], 3);
    }

    #[test]
    fn text_clamp_rejects_empty_and_truncates() {
        assert!(clamp_text("   ").is_err());
        let long: String = "字".repeat(MAX_TEXT_CHARS + 5);
        assert_eq!(clamp_text(&long).unwrap().chars().count(), MAX_TEXT_CHARS);
    }

    #[test]
    fn expires_in_accepts_string_and_number() {
        assert_eq!(parse_expires_in(Some(&json!("7200"))), 7200);
        assert_eq!(parse_expires_in(Some(&json!(1800))), 1800);
        assert_eq!(parse_expires_in(None), 7200);
        assert_eq!(parse_expires_in(Some(&json!("oops"))), 7200);
    }

    #[test]
    fn auth_header_matches_official_format() {
        assert_eq!(auth_header("abc"), "QQBot abc");
    }

    #[test]
    fn intents_cover_only_public_c2c_and_group_events() {
        assert_eq!(INTENTS_PUBLIC_MESSAGES, 33_554_432);
        assert_eq!(INTENTS_PUBLIC_MESSAGES, 1 << 25);
    }
}
