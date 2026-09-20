//! Discord 通道（官方 Gateway 长连接 + REST 发消息）。
//!
//! 与其余通道同构：协议差异在本模块收敛，宿主侧动作（事件广播、凭证落盘、代际可中断
//! 等待）复用 [`crate::channel_common`]。选它的理由是 Discord 给的是**网关长连接**
//! （`/gateway/bot` 下发 wss 地址 + hello 心跳 + 断线 resume），桌面端不需要公网回调。
//!
//! **只做私聊（DM）**，这是刻意的取舍：
//! - 官方文档明确「Content in DMs with the user」不受 `MESSAGE_CONTENT (1 << 15)` 特权
//!   intent 限制，所以只申请 `DIRECT_MESSAGES (1 << 12)` 就能读到私聊正文 —— 用户只需
//!   粘一枚 bot token，不必去应用页勾选特权 intent，也就不会撞上 4014 断连；
//! - 服务器频道还要处理 @ 提及、频道白名单与成员权限，收益远低于私聊；
//! - 频道消息（含服务器群里 @ 机器人）**不在本通道范围**，事件直接丢弃。
//!
//! 安全与边界：
//! - bot token 只在宿主内存/磁盘（0600），渲染端只传文本与对端 id；
//! - 归属人策略：第一个私聊机器人的 Discord 用户成为默认主人，其他人是否答复由设置决定；
//! - 对端 id 编成 `dm:<channel_id>`，且 `channel_id` 必须是纯数字雪花 id —— 回发要拼进
//!   URL 路径，不校验就等于把路径交给渲染端。

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

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

const DIR_NAME: &str = "discord";
const CREDENTIALS_FILE: &str = "credentials.json";
const PEERS_FILE: &str = "peers.json";

pub const STATE_EVENT: &str = "discord://state";
pub const INBOUND_EVENT: &str = "discord://inbound";

/// REST / 网关地址根（版本写死在路径里，见 `API_VERSION`）。
const API_BASE: &str = "https://discord.com/api/v10";
/// 网关查询串里的 API 版本。
const API_VERSION: &str = "10";
/// 私聊消息事件（`DIRECT_MESSAGES`，1 << 12）。
///
/// 刻意不带 `MESSAGE_CONTENT`：私聊正文不受特权 intent 限制（见模块文档），
/// 带上它反而会因为应用页没勾选而收到 4014。
const INTENTS_DIRECT_MESSAGES: i64 = 1 << 12;
/// 心跳兜底间隔：正常用 hello 下发的 `heartbeat_interval`（约 41.25s），缺失时按 41s。
const FALLBACK_HEARTBEAT: Duration = Duration::from_secs(41);
/// 单条文本上限（Discord 消息正文 2000 字符）。
const MAX_TEXT_CHARS: usize = 2000;
/// token 长度上限（官方 token 约 72 字符，留足余量）。
const MAX_TOKEN_CHARS: usize = 200;
/// 雪花 id 的十进制长度上限（Discord id 是 64 位，最长 20 位）。
const MAX_SNOWFLAKE_CHARS: usize = 20;

/* ===== 协议形状 ===== */

/// `GET /users/@me` 的 bot 用户（只为「填完能确认填对了」）。
#[derive(Debug, Clone, Default, Deserialize)]
struct BotUser {
    #[serde(default)]
    id: String,
    #[serde(default)]
    username: String,
    #[serde(default)]
    global_name: Option<String>,
}

impl BotUser {
    /// 展示名：优先全局名，回落用户名。
    fn display_name(&self) -> String {
        self.global_name
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| self.username.clone())
    }
}

#[derive(Debug, Clone, Deserialize)]
struct GatewayResponse {
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

/// 网关下行帧：`s` 只在 dispatch 上出现，`t` 表示事件类型。
#[derive(Debug, Clone, Deserialize)]
struct GatewayFrame {
    op: i64,
    #[serde(default)]
    d: Option<serde_json::Value>,
    #[serde(default)]
    s: Option<i64>,
    #[serde(default)]
    t: Option<String>,
}

/// `MESSAGE_CREATE` 的消息体（只取用得到的字段）。
#[derive(Debug, Clone, Default, Deserialize)]
struct MessagePayload {
    #[serde(default)]
    id: String,
    #[serde(default)]
    channel_id: String,
    /// 服务器消息才带 guild_id —— 带了就不是私聊，丢弃。
    #[serde(default)]
    guild_id: Option<String>,
    #[serde(default)]
    content: String,
    #[serde(default)]
    author: Author,
    /// RFC3339（`2024-01-01T00:00:00.000000+00:00`）。
    #[serde(default)]
    timestamp: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct Author {
    #[serde(default)]
    id: String,
    #[serde(default)]
    username: String,
    #[serde(default)]
    global_name: Option<String>,
    /// 别的机器人：不答复（否则两个 bot 会互相刷）。
    #[serde(default)]
    bot: bool,
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
    pub at: i64,
}

/// 归一条 dispatch 事件；不认识的 `t`、服务器消息、机器人消息、空正文都返回 None。
pub fn normalize_dispatch(
    event: &str,
    data: &serde_json::Value,
    received_at: i64,
) -> Option<DiscordInboundDto> {
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
    // 附件 / 贴纸 / 纯 embed 没有正文，渲染端只认文字。
    let text = payload.content.trim();
    if text.is_empty() {
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
    Some(DiscordInboundDto {
        message_id: payload.id,
        peer_id: encode_peer(payload.channel_id.trim()),
        nick,
        sender_id: payload.author.id.trim().to_string(),
        text: text.to_string(),
        at: parse_timestamp(payload.timestamp.as_deref(), received_at),
    })
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
fn auth_header(token: &str) -> String {
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
fn close_hint(code: u16) -> &'static str {
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

/* ===== 宿主层：持久化 ===== */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredCredentials {
    pub token: String,
    /// 保存时探针取回的 bot 用户（展示用，非秘密）。
    #[serde(default)]
    pub bot_user_id: String,
    #[serde(default)]
    pub bot_username: String,
    #[serde(default)]
    pub saved_at: Option<String>,
}

/// 私聊会话档案 + 归属人。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerBook {
    /// 第一个私聊机器人的 Discord 用户 id = 默认只答复的主人。
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub peers: BTreeMap<String, PeerRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerRecord {
    /// 私聊对端的用户 id。
    #[serde(default)]
    pub user_id: String,
    #[serde(default)]
    pub nick: String,
    #[serde(default)]
    pub last_at: i64,
}

impl PeerBook {
    /// 记一条私聊：对端 id 是私聊频道 id，展示名与用户 id 随最新一条消息更新。
    pub fn remember(&mut self, peer: &str, user_id: &str, nick: &str, at: i64) {
        let entry = self.peers.entry(peer.to_string()).or_insert(PeerRecord {
            user_id: user_id.to_string(),
            nick: nick.to_string(),
            last_at: at,
        });
        entry.user_id = user_id.to_string();
        entry.nick = nick.to_string();
        entry.last_at = at;
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
pub struct DiscordStatusDto {
    /// 是否已保存 bot token。
    pub configured: bool,
    /// bot 用户名（非秘密，展示出来便于确认填对了）。
    pub bot_username: Option<String>,
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
    /// 网关会话：断线 resume 用。
    session_id: Option<String>,
    resume_url: Option<String>,
    last_seq: Option<i64>,
}

impl Inner {
    fn status(&self) -> DiscordStatusDto {
        DiscordStatusDto {
            configured: self.credentials.is_some(),
            bot_username: self
                .credentials
                .as_ref()
                .map(|item| item.bot_username.clone())
                .filter(|value| !value.is_empty()),
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

    fn token(&self) -> Result<String, String> {
        self.credentials
            .as_ref()
            .map(|item| item.token.clone())
            .ok_or_else(|| "尚未配置 Discord bot token".into())
    }

    /// 丢掉会话：下次建连直接 identify（resume 的凭据已经不可信）。
    fn forget_session(&mut self) {
        self.session_id = None;
        self.resume_url = None;
        self.last_seq = None;
    }
}

/// Discord 通道宿主：凭证、私聊档案与网关任务代际。
pub struct DiscordHost {
    inner: Arc<Mutex<Inner>>,
    epoch: Arc<AtomicU64>,
}

impl Default for DiscordHost {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner::default())),
            epoch: Arc::new(AtomicU64::new(0)),
        }
    }
}

impl DiscordHost {
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
        .filter(|item| is_valid_token(&item.token));
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
                log::warn("discord", format!("私聊档案落盘失败: {error}"));
            }
        }
        Err(error) => log::warn("discord", format!("私聊档案序列化失败: {error}")),
    }
}

/// 网关的对外出口：事件广播 + 私聊档案落盘 + 本次连接的发送者策略。
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

/* ===== 宿主层：HTTP（探针、网关地址、发消息） ===== */

/// 探针：确认 token 有效并取回 bot 身份（保存凭证前跑一次，比「填完连不上」友好）。
async fn probe_bot_user(client: &reqwest::Client, token: &str) -> Result<BotUser, String> {
    let response = client
        .get(format!("{API_BASE}/users/@me"))
        .header("Authorization", auth_header(token))
        .send()
        .await
        .map_err(|error| format!("校验 bot token 失败: {error}"))?;
    let status = response.status();
    let body = read_text(response, RESPONSE_READ_TIMEOUT)
        .await
        .map_err(|error| format!("校验响应读取失败: {error}"))?;
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(
            "Discord 拒绝这枚 token（401）：请确认复制的是 Bot token，必要时在门户里 Reset Token"
                .into(),
        );
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err("Discord 限流（429）：稍后再试".into());
    }
    if !status.is_success() {
        return Err(format!("校验 bot token 返回 {status}: {}", brief(&body)));
    }
    let parsed: BotUser =
        serde_json::from_str(&body).map_err(|error| format!("校验响应解析失败: {error}"))?;
    if parsed.id.trim().is_empty() {
        return Err("校验响里没有 bot 用户 id".into());
    }
    Ok(parsed)
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

/// 往私聊频道发一条文本。
pub(crate) async fn send_text(
    client: &reqwest::Client,
    token: &str,
    peer_id: &str,
    text: &str,
) -> Result<(), String> {
    let channel_id =
        decode_peer(peer_id).ok_or_else(|| format!("对端 id 无法解析: {peer_id:?}"))?;
    let response = client
        .post(format!("{API_BASE}/channels/{channel_id}/messages"))
        .header("Authorization", auth_header(token))
        .json(&serde_json::json!({ "content": text }))
        .send()
        .await
        .map_err(|error| format!("发送消息失败: {error}"))?;
    let status = response.status();
    let body = read_text(response, RESPONSE_READ_TIMEOUT)
        .await
        .map_err(|error| format!("发送响应读取失败: {error}"))?;
    if status.is_success() {
        return Ok(());
    }
    if status == reqwest::StatusCode::FORBIDDEN {
        return Err(
            "Discord 拒绝了这条消息（403）：私聊需要对方先发起过会话，且不能给已拉黑机器人的用户发"
                .into(),
        );
    }
    Err(format!("发送消息返回 {status}: {}", brief(&body)))
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

/// 一次连接的结果。
#[derive(Debug, PartialEq)]
pub(crate) enum GatewayEnd {
    /// 可重连（断线 / op 7 / op 9 可恢复）。
    Reconnect,
    /// 对端正常关闭。
    Closed,
    /// 致命错误：重试无用，停下等用户改配置。
    Fatal(String),
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

    // 有会话就 resume（官方建议 resume 时改用 ready 给的 resume_gateway_url，由调用方负责）。
    let resume = {
        let guard = inner.lock().await;
        guard
            .session_id
            .clone()
            .filter(|value| !value.is_empty())
            .map(|session_id| (session_id, guard.last_seq.unwrap_or(0)))
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
        .unwrap_or(FALLBACK_HEARTBEAT);

    let auth = match resume {
        Some((session_id, seq)) => resume_frame(token, &session_id, seq),
        None => identify_frame(token, INTENTS_DIRECT_MESSAGES),
    };
    socket
        .send(Message::text(auth.to_string()))
        .await
        .map_err(|error| format!("鉴权帧发送失败: {error}"))?;
    set_state(inner, deps, "connected", None).await;

    let mut heartbeat_task = tokio::time::interval(interval);
    heartbeat_task.tick().await; // 跳过立即触发的首个 tick
                                 // 上一拍心跳是否还没等到 ACK：没等到说明连接已经「僵尸」，必须重连。
    let mut pending_ack: Option<Instant> = None;

    loop {
        tokio::select! {
            _ = heartbeat_task.tick() => {
                if pending_ack.map(|sent| sent.elapsed() >= interval).unwrap_or(false) {
                    return Err("心跳未收到 ACK，连接已失效".into());
                }
                let seq = { inner.lock().await.last_seq };
                let payload = heartbeat_frame(seq);
                if let Err(error) = socket.send(Message::text(payload.to_string())).await {
                    return Err(format!("心跳发送失败: {error}"));
                }
                pending_ack = Some(Instant::now());
            }
            incoming = socket.next() => {
                let Some(frame) = incoming else {
                    return Ok(GatewayEnd::Closed);
                };
                let raw = match frame {
                    Ok(Message::Text(text)) => text.to_string(),
                    Ok(Message::Close(frame)) => {
                        let code = frame.map(|item| u16::from(item.code));
                        return Ok(match classify_close(code) {
                            CloseAction::Fatal => GatewayEnd::Fatal(match code {
                                Some(code) => format!("Discord 关闭连接 {code}（{}）", close_hint(code)),
                                None => "Discord 关闭连接（原因未知）".into(),
                            }),
                            CloseAction::Reidentify => {
                                inner.lock().await.forget_session();
                                GatewayEnd::Reconnect
                            }
                            CloseAction::Resume => GatewayEnd::Reconnect,
                        });
                    }
                    Ok(_) => continue,
                    Err(error) => return Err(format!("网关读取失败: {error}")),
                };
                let parsed: GatewayFrame = match serde_json::from_str(&raw) {
                    Ok(parsed) => parsed,
                    Err(error) => {
                        log::warn("discord", format!("网关帧解析失败: {error}"));
                        continue;
                    }
                };
                match parsed.op {
                    // 事件下发
                    0 => {
                        if let Some(seq) = parsed.s {
                            let mut guard = inner.lock().await;
                            guard.last_seq = Some(seq);
                        }
                        if let Some(kind) = parsed.t.as_deref() {
                            match kind {
                                "READY" => {
                                    let data = parsed.d.as_ref();
                                    let mut guard = inner.lock().await;
                                    guard.session_id = data
                                        .and_then(|item| item.get("session_id"))
                                        .and_then(serde_json::Value::as_str)
                                        .map(|value| value.to_string());
                                    guard.resume_url = data
                                        .and_then(|item| item.get("resume_gateway_url"))
                                        .and_then(serde_json::Value::as_str)
                                        .map(|value| value.to_string());
                                    guard.last_seq = None;
                                    drop(guard);
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
                    // 服务端要求立刻补一拍心跳
                    1 => {
                        let seq = { inner.lock().await.last_seq };
                        let payload = heartbeat_frame(seq);
                        if let Err(error) = socket.send(Message::text(payload.to_string())).await {
                            return Err(format!("心跳发送失败: {error}"));
                        }
                        pending_ack = Some(Instant::now());
                    }
                    // 心跳 ACK
                    11 => pending_ack = None,
                    // 服务端要求重连（resume 即可）
                    7 => return Ok(GatewayEnd::Reconnect),
                    // 会话失效：Discord 的 `d` 语义与 QQ 相反 —— true 表示可 resume，false 必须重新 identify。
                    9 => {
                        let resumable = parsed.d.as_ref().and_then(serde_json::Value::as_bool).unwrap_or(false);
                        if !resumable {
                            inner.lock().await.forget_session();
                        }
                        return Ok(GatewayEnd::Reconnect);
                    }
                    other => {
                        log::info("discord", format!("忽略未处理的网关帧 op={other}"));
                    }
                }
            }
        }
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

/// 一条业务事件：归属人判定 → 更新档案 → 允许则广播。
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
        guard.peers.remember(
            &message.peer_id,
            &message.sender_id,
            &message.nick,
            message.at,
        );
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
            "discord",
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
    log::info("discord", "网关长连接启动");
    while epochs.load(Ordering::SeqCst) == epoch {
        let client = match shared_client(10) {
            Ok(client) => client,
            Err(error) => {
                set_state(&inner, &deps, "error", Some(error)).await;
                return;
            }
        };
        let token = match inner.lock().await.token() {
            Ok(token) => token,
            Err(error) => {
                set_state(&inner, &deps, "error", Some(error)).await;
                return;
            }
        };
        // 已有会话就按官方建议改用 resume_gateway_url，不再打 /gateway/bot。
        let cached = {
            let guard = inner.lock().await;
            guard
                .session_id
                .as_ref()
                .and_then(|_| guard.resume_url.clone())
        };
        let url = match cached {
            Some(url) => Some(url),
            None => match gateway_url(&client, &token).await {
                Ok(url) => Some(url),
                Err(error) => {
                    attempt = attempt.saturating_add(1);
                    set_state(&inner, &deps, "error", Some(error.clone())).await;
                    log::warn("discord", format!("取网关地址失败({attempt}): {error}"));
                    None
                }
            },
        };
        if let Some(url) = url {
            let url = gateway_ws_url(&url);
            match gateway_once(&url, &token, &deps, &inner).await {
                Ok(GatewayEnd::Fatal(reason)) => {
                    log::warn("discord", format!("通道致命错误: {reason}"));
                    set_state(&inner, &deps, "error", Some(reason)).await;
                    return;
                }
                Ok(end) => {
                    log::info("discord", format!("网关连接结束: {end:?}"));
                    if end == GatewayEnd::Closed {
                        attempt = 0;
                    }
                }
                Err(error) => {
                    attempt = attempt.saturating_add(1);
                    log::warn("discord", format!("网关连接异常({attempt}): {error}"));
                    set_state(&inner, &deps, "error", Some(error)).await;
                }
            }
        }
        if !sleep_or_stop(&epochs, epoch, reconnect_delay(attempt)).await {
            break;
        }
        set_state(&inner, &deps, "connecting", None).await;
    }
    log::info("discord", "网关长连接已停止");
}

/* ===== 宿主层：Tauri 命令 ===== */

/// 当前通道状态（是否已配置 token、网关状态、已建档私聊数）。
#[tauri::command]
pub async fn discord_status(
    app: AppHandle,
    host: State<'_, DiscordHost>,
) -> Result<DiscordStatusDto, String> {
    let mut inner = host.lock().await;
    ensure_loaded(&app, &mut inner)?;
    Ok(inner.status())
}

/// 保存 bot token：先探针确认有效并取回 bot 身份，再落盘。
#[tauri::command]
pub async fn discord_save_credentials(
    app: AppHandle,
    host: State<'_, DiscordHost>,
    token: String,
) -> Result<DiscordStatusDto, String> {
    let token = token.trim().to_string();
    if !is_valid_token(&token) {
        return Err(
            "bot token 形状不对：应为 `xxx.yyy.zzz` 三段（门户 → Bot → Reset Token）".into(),
        );
    }
    let client = shared_client(10)?;
    let bot = probe_bot_user(&client, &token).await?;
    let credentials = StoredCredentials {
        token,
        bot_user_id: bot.id.clone(),
        bot_username: bot.display_name(),
        saved_at: Some(chrono::Utc::now().to_rfc3339()),
    };
    let mut inner = host.lock().await;
    ensure_loaded(&app, &mut inner)?;
    let dir = channel_dir(&app, DIR_NAME)?;
    let bytes = serde_json::to_vec_pretty(&credentials)
        .map_err(|error| format!("凭证序列化失败: {error}"))?;
    write_private(&dir.join(CREDENTIALS_FILE), &bytes)?;
    // 换了 token 就作废会话：旧会话属于上一个 bot。
    inner.forget_session();
    inner.credentials = Some(credentials);
    inner.detail = None;
    log::info("discord", format!("bot token 已保存（{}）", bot.id));
    Ok(inner.status())
}

/// 清除 token 与私聊档案（相当于退出登录）。
#[tauri::command]
pub async fn discord_clear_credentials(
    app: AppHandle,
    host: State<'_, DiscordHost>,
) -> Result<DiscordStatusDto, String> {
    host.epoch.fetch_add(1, Ordering::SeqCst);
    let mut inner = host.lock().await;
    ensure_loaded(&app, &mut inner)?;
    inner.credentials = None;
    inner.peers = PeerBook::default();
    inner.forget_session();
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
    log::info("discord", "凭证已清除");
    Ok(inner.status())
}

/// 启动网关长连接（未配置 token 时报错，由界面引导去填）。
#[tauri::command]
pub async fn discord_connect(
    app: AppHandle,
    host: State<'_, DiscordHost>,
    allow_other_senders: bool,
) -> Result<(), String> {
    {
        let mut inner = host.lock().await;
        ensure_loaded(&app, &mut inner)?;
        if inner.credentials.is_none() {
            return Err("尚未配置 Discord bot token".into());
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

/// 停止网关长连接（保留 token 与私聊档案）。
#[tauri::command]
pub async fn discord_disconnect(
    app: AppHandle,
    host: State<'_, DiscordHost>,
) -> Result<(), String> {
    host.epoch.fetch_add(1, Ordering::SeqCst);
    let mut inner = host.lock().await;
    ensure_loaded(&app, &mut inner)?;
    let deps = GatewayDeps::for_app(&app);
    inner.state = "stopped".into();
    inner.detail = None;
    emit_state(&inner, &deps);
    Ok(())
}

/// 往已建档的私聊频道发一条文本。
#[tauri::command]
pub async fn discord_send(
    app: AppHandle,
    host: State<'_, DiscordHost>,
    peer_id: String,
    text: String,
) -> Result<(), String> {
    let text = clamp_text(&text)?;
    let client = shared_client(10)?;
    let token = {
        // 只做首次装载与凭据读取，随后立刻放锁：发消息要等网络，不能套着锁。
        let mut inner = host.lock().await;
        ensure_loaded(&app, &mut inner)?;
        if !inner.peers.peers.contains_key(&peer_id) {
            return Err("该私聊尚未建档：等对方先发一条消息，本机才知道这个会话".into());
        }
        inner.token()?
    };
    send_text(&client, &token, &peer_id, &text).await
}

/* ===== 单测（纯函数） ===== */

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
    use tokio_tungstenite::tungstenite::protocol::CloseFrame;

    #[test]
    fn peer_id_roundtrip_requires_snowflake() {
        assert_eq!(encode_peer("123"), "dm:123");
        assert_eq!(decode_peer("dm:123"), Some("123".into()));
        assert_eq!(decode_peer("123"), None, "缺少前缀");
        assert_eq!(decode_peer("group:123"), None, "未知前缀");
        assert_eq!(decode_peer("dm:"), None, "空 id");
        assert_eq!(
            decode_peer("dm:12a"),
            None,
            "非数字必须挡住（要拼进 URL 路径）"
        );
        assert_eq!(decode_peer("dm:12/../x"), None, "路径穿越必须挡住");
        assert_eq!(decode_peer(&format!("dm:{}", "9".repeat(21))), None, "超长");
    }

    #[test]
    fn token_shape_requires_three_segments() {
        assert!(is_valid_token("MTIzNDU2.Nzg5MA.abcdefghijklmnop"));
        assert!(!is_valid_token(""), "空");
        assert!(!is_valid_token("MTIzNDU2.Nzg5MA"), "两段");
        assert!(!is_valid_token("MTIz.Nz.a-b_c"), "段太短");
        assert!(!is_valid_token("MTIzNDU2.Nzg5M A.abcdef"), "含空格");
        assert!(!is_valid_token(&"a".repeat(MAX_TOKEN_CHARS + 1)), "超长");
        assert!(
            is_valid_token("  MTIzNDU2.Nzg5MA.abcdefghijklmnop  "),
            "两侧空白容忍"
        );
    }

    #[test]
    fn normalize_private_message_only() {
        let data = json!({
            "id": "111",
            "channel_id": "222",
            "content": "你好",
            "timestamp": "2024-01-02T03:04:05.000000+00:00",
            "author": { "id": "333", "username": "jean", "global_name": "Jean" },
        });
        let inbound = normalize_dispatch("MESSAGE_CREATE", &data, 999).expect("私聊消息");
        assert_eq!(inbound.peer_id, "dm:222");
        assert_eq!(inbound.sender_id, "333");
        assert_eq!(inbound.nick, "Jean", "优先全局名");
        assert_eq!(inbound.text, "你好");
        assert_eq!(inbound.at, 1_704_164_645_000, "RFC3339 转毫秒");
    }

    #[test]
    fn normalize_rejects_non_private_and_noise() {
        let base = json!({
            "id": "111",
            "channel_id": "222",
            "content": "hi",
            "author": { "id": "333", "username": "jean" },
        });
        assert!(
            normalize_dispatch("READY", &base, 1).is_none(),
            "非消息事件"
        );

        let mut guild = base.clone();
        guild["guild_id"] = json!("444");
        assert!(
            normalize_dispatch("MESSAGE_CREATE", &guild, 1).is_none(),
            "服务器频道不在范围"
        );

        let mut from_bot = base.clone();
        from_bot["author"]["bot"] = json!(true);
        assert!(
            normalize_dispatch("MESSAGE_CREATE", &from_bot, 1).is_none(),
            "别的机器人不答复"
        );

        let mut empty = base.clone();
        empty["content"] = json!("   ");
        assert!(
            normalize_dispatch("MESSAGE_CREATE", &empty, 1).is_none(),
            "附件/贴纸没有正文"
        );

        let mut bad_channel = base.clone();
        bad_channel["channel_id"] = json!("22a");
        assert!(
            normalize_dispatch("MESSAGE_CREATE", &bad_channel, 1).is_none(),
            "非雪花频道 id"
        );

        let mut nameless = base;
        nameless["author"] = json!({ "id": "333" });
        let inbound = normalize_dispatch("MESSAGE_CREATE", &nameless, 5).expect("无用户名仍可");
        assert_eq!(inbound.nick, "333", "展示名回落到用户 id");
        assert_eq!(inbound.at, 5, "缺时间戳用收包时间");
    }

    #[test]
    fn frames_carry_official_fields() {
        let identify = identify_frame("aaa.bbb.ccc", INTENTS_DIRECT_MESSAGES);
        assert_eq!(identify["op"], 2);
        assert_eq!(
            identify["d"]["token"], "aaa.bbb.ccc",
            "identify 不带 Bot 前缀"
        );
        assert_eq!(identify["d"]["intents"], 4096);
        assert!(identify["d"]["properties"].is_object(), "properties 必填");

        let resume = resume_frame("aaa.bbb.ccc", "sess-1", 7);
        assert_eq!(resume["op"], 6);
        assert_eq!(resume["d"]["session_id"], "sess-1");
        assert_eq!(resume["d"]["seq"], 7);

        assert_eq!(heartbeat_frame(Some(9))["d"], 9);
        assert_eq!(heartbeat_frame(None)["d"], serde_json::Value::Null);

        assert_eq!(auth_header("aaa.bbb.ccc"), "Bot aaa.bbb.ccc", "REST 要前缀");
    }

    #[test]
    fn intents_cover_only_direct_messages() {
        assert_eq!(INTENTS_DIRECT_MESSAGES, 4096);
        assert_eq!(INTENTS_DIRECT_MESSAGES, 1 << 12);
        assert_eq!(
            INTENTS_DIRECT_MESSAGES & (1 << 15),
            0,
            "不带 MESSAGE_CONTENT，私聊正文本就豁免"
        );
    }

    #[test]
    fn gateway_url_appends_version_and_encoding() {
        assert_eq!(
            gateway_ws_url("wss://gateway.discord.gg"),
            "wss://gateway.discord.gg/?v=10&encoding=json"
        );
        assert_eq!(
            gateway_ws_url("wss://gateway.discord.gg/"),
            "wss://gateway.discord.gg/?v=10&encoding=json",
            "结尾斜杠不重复"
        );
        assert_eq!(
            gateway_ws_url("wss://resume.example/ws?ticket=1"),
            "wss://resume.example/ws?ticket=1&v=10&encoding=json"
        );
    }

    #[test]
    fn close_codes_map_to_actions() {
        assert_eq!(classify_close(Some(4004)), CloseAction::Fatal, "token 无效");
        assert_eq!(
            classify_close(Some(4014)),
            CloseAction::Fatal,
            "intents 被拒"
        );
        assert_eq!(
            classify_close(Some(4007)),
            CloseAction::Reidentify,
            "seq 失效"
        );
        assert_eq!(classify_close(Some(4009)), CloseAction::Reidentify);
        assert_eq!(
            classify_close(Some(1001)),
            CloseAction::Reidentify,
            "主动关闭"
        );
        assert_eq!(classify_close(Some(4000)), CloseAction::Resume);
        assert_eq!(
            classify_close(Some(4008)),
            CloseAction::Resume,
            "限流后重试"
        );
        assert_eq!(classify_close(None), CloseAction::Resume, "没有关闭码");
        assert!(!close_hint(4004).is_empty());
    }

    #[test]
    fn timestamp_fallback_and_parsing() {
        assert_eq!(parse_timestamp(None, 7), 7);
        assert_eq!(parse_timestamp(Some("not-a-time"), 7), 7);
        assert_eq!(
            parse_timestamp(Some("1970-01-01T00:00:01Z"), 7),
            1000,
            "带 Z 的 RFC3339 也认"
        );
    }

    #[test]
    fn peer_book_owner_policy_gates_other_senders() {
        let mut book = PeerBook::default();
        book.remember("dm:1", "U1", "Jean", 10);
        assert_eq!(book.peers["dm:1"].nick, "Jean");
        assert!(book.claim_owner("U1"));
        assert!(!book.claim_owner("U2"));
        assert!(book.allows("U1", false));
        assert!(!book.allows("U2", false));
        assert!(book.allows("U2", true));
    }

    #[test]
    fn text_clamp_rejects_empty_and_truncates() {
        assert!(clamp_text("   ").is_err());
        let long: String = "字".repeat(MAX_TEXT_CHARS + 5);
        assert_eq!(clamp_text(&long).unwrap().chars().count(), MAX_TEXT_CHARS);
    }

    /// 本地假网关：验证「hello → identify(intents 正确) → READY → MESSAGE_CREATE → 广播」
    /// 这条主链真的跑得通，而不只是各段纯函数各自正确。
    #[tokio::test]
    async fn gateway_handshake_identifies_and_broadcasts_inbound() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("本地端口");
        let addr = listener.local_addr().expect("端口地址");
        let identify_seen = Arc::new(std::sync::Mutex::new(None));

        let server_witness = identify_seen.clone();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("接受连接");
            let mut socket = tokio_tungstenite::accept_async(stream).await.expect("握手");
            // hello：心跳间隔给足，避免测试期间触发「未收到 ACK」分支。
            let hello = json!({ "op": 10, "d": { "heartbeat_interval": 3000 } });
            socket
                .send(Message::text(hello.to_string()))
                .await
                .expect("发 hello");
            let frame = socket
                .next()
                .await
                .expect("等 identify")
                .expect("identify 帧");
            *server_witness.lock().expect("锁") =
                Some(frame.into_text().expect("文本帧").to_string());
            let ready = json!({
                "op": 0,
                "s": 1,
                "t": "READY",
                "d": { "session_id": "sess-1", "resume_gateway_url": "wss://resume.example" },
            });
            socket
                .send(Message::text(ready.to_string()))
                .await
                .expect("发 READY");
            let message = json!({
                "op": 0,
                "s": 2,
                "t": "MESSAGE_CREATE",
                "d": {
                    "id": "111",
                    "channel_id": "222",
                    "content": "干活",
                    "author": { "id": "333", "username": "jean" },
                },
            });
            socket
                .send(Message::text(message.to_string()))
                .await
                .expect("发消息");
            // 等广播落地再关，避免竞态：客户端读到 Close 就返回了。
            // 明确带 1000：官方的「会话已作废」路径要靠关闭码判定，不带码只能按可 resume 处理。
            tokio::time::sleep(Duration::from_millis(200)).await;
            let close = CloseFrame {
                code: CloseCode::Normal,
                reason: "".into(),
            };
            socket.close(Some(close)).await.ok();
        });

        let events: Arc<std::sync::Mutex<Vec<(String, serde_json::Value)>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let collector = events.clone();
        let deps = GatewayDeps {
            sink: Arc::new(move |event, payload| {
                collector
                    .lock()
                    .expect("锁")
                    .push((event.to_string(), payload));
            }),
            persist: Arc::new(|_peers: &PeerBook| {}),
            allow_other_senders: false,
        };
        let inner = Mutex::new(Inner::default());

        let ended = gateway_once(
            &gateway_ws_url(&format!("ws://{addr}")),
            "MTIzNDU2Nzg5.GxYzAb.abcdefghij",
            &deps,
            &inner,
        )
        .await
        .expect("本地网关应正常收尾");
        server.await.expect("服务端任务");

        let identify: serde_json::Value = serde_json::from_str(
            identify_seen
                .lock()
                .expect("锁")
                .as_deref()
                .expect("应当 identify"),
        )
        .expect("identify 是 JSON");
        assert_eq!(identify["op"], 2);
        assert_eq!(identify["d"]["intents"], 4096, "只申请 DIRECT_MESSAGES");
        assert_eq!(
            identify["d"]["token"], "MTIzNDU2Nzg5.GxYzAb.abcdefghij",
            "identify 不带 Bot 前缀"
        );

        let (channel, inbound) = {
            let guard = events.lock().expect("锁");
            let inbound = guard
                .iter()
                .find(|(event, _)| event == INBOUND_EVENT)
                .expect("应广播入站消息")
                .clone();
            (inbound.0, inbound.1)
        };
        assert_eq!(channel, "discord://inbound");
        assert_eq!(inbound["peerId"], "dm:222");
        assert_eq!(inbound["senderId"], "333");
        assert_eq!(inbound["text"], "干活");

        // 连接期间状态广播过 connected，界面据此点亮徽章。
        assert!(
            events
                .lock()
                .expect("锁")
                .iter()
                .any(|(event, payload)| event == STATE_EVENT && payload["state"] == "connected"),
            "应广播 connected 状态"
        );
        // 1000 是「会话已作废」：不能拿去 resume，必须丢掉。
        assert_eq!(ended, GatewayEnd::Reconnect, "对端关闭后重连");
        assert!(
            inner.lock().await.session_id.is_none(),
            "1000 关闭后会话作废"
        );
    }

    #[test]
    fn bot_display_name_falls_back_to_username() {
        let mut user = BotUser {
            id: "1".into(),
            username: "greywork".into(),
            global_name: None,
        };
        assert_eq!(user.display_name(), "greywork");
        user.global_name = Some("  ".into());
        assert_eq!(user.display_name(), "greywork", "空白全局名不算");
        user.global_name = Some("GreyWork".into());
        assert_eq!(user.display_name(), "GreyWork");
    }
}
