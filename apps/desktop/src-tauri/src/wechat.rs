//! 微信通道：腾讯官方 ClawBot / iLink Bot API（`ilinkai.weixin.qq.com`）。
//!
//! 为什么是这套接口：个人微信没有 webhook 回调可用（公网不可达），iLink 提供的是
//! **扫码登录 + HTTP 长轮询**——桌面端在内网即可收发消息，不需要公网入口，也没有
//! 逆向 iPad / Hook PC 客户端的封号风险。协议是纯 HTTP/JSON，宿主直接实现，
//! 不引第三方运行时（Node/OpenClaw 插件都不需要）。
//!
//! 分层：
//! - **协议层**（本文件上半部分，`pub` 且不依赖 Tauri）：get_bot_qrcode / get_qrcode_status /
//!   getupdates / sendmessage / getconfig + sendtyping。集成测试直接打本地 mock 服务器验证这一层。
//! - **宿主层**：状态机（登录态 / 长轮询任务 / 暂停）、凭证落盘（0600）、Tauri 命令与事件。
//!
//! 安全约束：
//! - 只信任 https 且主机名以 `qq.com` 结尾的 `baseurl`（登录响应会下发后续请求的 base）；
//! - bot_token 只落本机应用数据目录（`wechat/session.json`，0600），不进设置快照、不进日志；
//! - 默认只答复扫码本人（`allowOtherSenders=false` 时其他发送者的消息在宿主层就被丢弃）。
//!
//! 事件与命令见 `wechat_status` 等命令的文档；渲染端封装在 `lib/wechat-backend.ts`。

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use reqwest::{Method, Url};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tokio::sync::Mutex;

use crate::channel_common::{
    app_sink, channel_dir, now_ms, read_json, sleep_or_stop, write_private, EventSink,
};
use crate::log;

/* ===== 常量 ===== */

/// iLink 服务入口；登录成功后服务端可能下发 `baseurl`（按 `validate_base_url` 校验后采用）。
const DEFAULT_BASE_URL: &str = "https://ilinkai.weixin.qq.com";
/// 微信 ClawBot 登录二维码的 bot_type（官方渠道插件的取值）。
const BOT_TYPE: &str = "3";
/// `base_info.channel_version`：对齐官方渠道插件声明的协议版本，服务端按此做兼容。
const CHANNEL_VERSION: &str = "1.0.2";
/// 普通 API（发消息 / 取配置）超时。
const API_TIMEOUT: Duration = Duration::from_secs(15);
/// 长轮询超时：服务端最多持有请求 ~35s，客户端超时按「本轮无消息」处理。
const LONG_POLL_TIMEOUT: Duration = Duration::from_secs(35);
/// 二维码过期后自动换码的次数上限（超过则要求用户重新发起登录）。
const MAX_QR_REFRESH: u32 = 3;
/// 服务端判定会话过期的 errcode（-14）；此时官方实现暂停一小时。
const SESSION_EXPIRED_ERRCODE: i64 = -14;
/// 会话过期后的冷却时长。
const SESSION_PAUSE: Duration = Duration::from_secs(60 * 60);
/// 长轮询连续失败次数达到该值后进入退避。
const MAX_CONSECUTIVE_FAILURES: u32 = 3;
const BACKOFF_DELAY: Duration = Duration::from_secs(30);
const RETRY_DELAY: Duration = Duration::from_secs(2);

pub const STATE_EVENT: &str = "wechat://state";
pub const INBOUND_EVENT: &str = "wechat://inbound";

const SESSION_FILE: &str = "session.json";
const SYNC_FILE: &str = "sync.json";
const DIR_NAME: &str = "wechat";

/* ===== 协议层：线格式 ===== */

/// `get_bot_qrcode` 响应：`qrcode` 是状态轮询的句柄，`qrcode_img_content` 是要编码成二维码的链接。
#[derive(Debug, Clone, Deserialize)]
pub struct LoginQr {
    pub qrcode: String,
    pub qrcode_img_content: String,
}

/// `get_qrcode_status` 响应。`status`：wait / scaned / confirmed / expired。
#[derive(Debug, Clone, Default, Deserialize)]
pub struct LoginStatus {
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub bot_token: Option<String>,
    #[serde(default)]
    pub ilink_bot_id: Option<String>,
    #[serde(default)]
    pub baseurl: Option<String>,
    #[serde(default)]
    pub ilink_user_id: Option<String>,
}

/// 协议里的消息条目（`item_list[]`）。
#[derive(Debug, Clone, Deserialize)]
pub struct MessageItem {
    #[serde(default)]
    pub r#type: Option<i64>,
    #[serde(default)]
    pub text_item: Option<TextItem>,
    #[serde(default)]
    pub voice_item: Option<VoiceItem>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TextItem {
    #[serde(default)]
    pub text: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct VoiceItem {
    /// 微信云端转写的文本（协议自带，无需本地语音识别）。
    #[serde(default)]
    pub text: Option<String>,
}

/// `getupdates` 返回的一条消息。
#[derive(Debug, Clone, Deserialize)]
pub struct WeixinMessage {
    #[serde(default)]
    pub message_id: Option<i64>,
    #[serde(default)]
    pub from_user_id: Option<String>,
    #[serde(default)]
    pub context_token: Option<String>,
    #[serde(default)]
    pub create_time_ms: Option<i64>,
    /// 1 = 用户消息，2 = bot 自己发出的消息。
    #[serde(default)]
    pub message_type: Option<i64>,
    #[serde(default)]
    pub item_list: Option<Vec<MessageItem>>,
}

/// `getupdates` 响应；`ret`/`errcode` 非 0 表示服务端业务错误。
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Updates {
    #[serde(default)]
    pub ret: Option<i64>,
    #[serde(default)]
    pub errcode: Option<i64>,
    #[serde(default)]
    pub errmsg: Option<String>,
    #[serde(default)]
    pub msgs: Option<Vec<WeixinMessage>>,
    #[serde(default)]
    pub get_updates_buf: Option<String>,
    #[serde(default)]
    pub longpolling_timeout_ms: Option<i64>,
}

impl Updates {
    /// 服务端业务错误码（ret 与 errcode 任一非 0 即错误）。
    pub fn error_code(&self) -> Option<i64> {
        match (self.ret.unwrap_or(0), self.errcode.unwrap_or(0)) {
            (0, 0) => None,
            (ret, 0) => Some(ret),
            (_, errcode) => Some(errcode),
        }
    }

    pub fn error_text(&self) -> String {
        format!(
            "ret={} errcode={} errmsg={}",
            self.ret.unwrap_or(0),
            self.errcode.unwrap_or(0),
            self.errmsg.as_deref().unwrap_or("")
        )
    }
}

/// `getconfig` 响应：主要拿 `typing_ticket`（发「正在输入」需要）。
#[derive(Debug, Clone, Default, Deserialize)]
pub struct BotConfig {
    #[serde(default)]
    pub typing_ticket: Option<String>,
}

/* ===== 协议层：请求构造 ===== */

/// `X-WECHAT-UIN`：随机 uint32 → 十进制字符串 → base64。官方实现每次请求都换一个。
pub fn random_wechat_uin() -> Result<String, String> {
    let mut bytes = [0u8; 4];
    getrandom::fill(&mut bytes).map_err(|error| format!("随机数生成失败: {error}"))?;
    Ok(BASE64.encode(u32::from_be_bytes(bytes).to_string()))
}

/// 校验并归一化登录响应下发的 `baseurl`：必须是 https 且主机名归属 qq.com。
///
/// 后续所有请求（含 bot_token）都会打到这个地址，放行任意主机等于把凭证交给对方。
pub fn validate_base_url(raw: &str) -> Result<String, String> {
    let parsed = Url::parse(raw.trim()).map_err(|error| format!("baseurl 非法: {error}"))?;
    if parsed.scheme() != "https" {
        return Err(format!("baseurl 必须是 https：{raw}"));
    }
    let host = parsed.host_str().unwrap_or_default();
    let trusted = host == "qq.com" || host.ends_with(".qq.com");
    if !trusted {
        return Err(format!("baseurl 主机不在 qq.com 域内：{host}"));
    }
    Ok(format!(
        "{}://{}",
        parsed.scheme(),
        parsed.host_str().unwrap_or_default()
    ))
}

fn api_request(
    client: &reqwest::Client,
    method: Method,
    url: &str,
    token: Option<&str>,
    body: Option<serde_json::Value>,
) -> Result<reqwest::RequestBuilder, String> {
    let mut request = client
        .request(method, url)
        .header("Content-Type", "application/json")
        .header("AuthorizationType", "ilink_bot_token")
        .header("X-WECHAT-UIN", random_wechat_uin()?);
    if let Some(token) = token.map(str::trim).filter(|value| !value.is_empty()) {
        request = request.header("Authorization", format!("Bearer {token}"));
    }
    if let Some(body) = body {
        request = request.json(&body);
    }
    Ok(request)
}

fn api_base(base_url: &str) -> String {
    base_url.trim().trim_end_matches('/').to_string()
}

/// 响应体截断：错误信息进日志与界面，不把整段响应塞进去。
fn brief(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= 300 {
        return trimmed.to_string();
    }
    let head: String = trimmed.chars().take(300).collect();
    format!("{head}…")
}

async fn read_body(response: reqwest::Response, label: &str) -> Result<String, String> {
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("{label} 响应读取失败: {error}"))?;
    if !status.is_success() {
        return Err(format!("{label} HTTP {status}: {}", brief(&text)));
    }
    Ok(text)
}

/// GET `get_bot_qrcode`：申请登录二维码。
pub async fn fetch_login_qr(client: &reqwest::Client, base_url: &str) -> Result<LoginQr, String> {
    let url = format!(
        "{}/ilink/bot/get_bot_qrcode?bot_type={BOT_TYPE}",
        api_base(base_url)
    );
    let response = api_request(client, Method::GET, &url, None, None)?
        .timeout(API_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("二维码请求失败: {error}"))?;
    let text = read_body(response, "get_bot_qrcode").await?;
    serde_json::from_str::<LoginQr>(&text).map_err(|error| format!("二维码响应解析失败: {error}"))
}

/// GET `get_qrcode_status`：长轮询扫码状态；客户端超时按 `wait` 处理（服务端 ~30s 回一次）。
pub async fn poll_login_status(
    client: &reqwest::Client,
    base_url: &str,
    qrcode: &str,
) -> Result<LoginStatus, String> {
    // 句柄会拼进查询串：只放行 URL-safe 字符，避免用它构造别的请求。
    if qrcode.is_empty()
        || !qrcode
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || value == '-' || value == '_')
    {
        return Err(format!("二维码句柄形状非法：{qrcode}"));
    }
    let url = format!(
        "{}/ilink/bot/get_qrcode_status?qrcode={qrcode}",
        api_base(base_url)
    );
    let response = client
        .get(&url)
        .header("iLink-App-ClientVersion", "1")
        .timeout(LONG_POLL_TIMEOUT)
        .send()
        .await;
    match response {
        Err(error) if error.is_timeout() => Ok(LoginStatus {
            status: "wait".into(),
            ..Default::default()
        }),
        Err(error) => Err(format!("二维码状态请求失败: {error}")),
        Ok(response) => {
            let text = read_body(response, "get_qrcode_status").await?;
            serde_json::from_str::<LoginStatus>(&text)
                .map_err(|error| format!("二维码状态解析失败: {error}"))
        }
    }
}

/// POST `getupdates`：长轮询收消息；客户端超时返回空结果（长轮询的正常形态，调用方继续下一轮）。
pub async fn get_updates(
    client: &reqwest::Client,
    base_url: &str,
    token: &str,
    cursor: &str,
    timeout: Duration,
) -> Result<Updates, String> {
    let url = format!("{}/ilink/bot/getupdates", api_base(base_url));
    let body = serde_json::json!({
        "get_updates_buf": cursor,
        "base_info": { "channel_version": CHANNEL_VERSION },
    });
    let response = api_request(client, Method::POST, &url, Some(token), Some(body))?
        .timeout(timeout)
        .send()
        .await;
    match response {
        Err(error) if error.is_timeout() => Ok(Updates {
            get_updates_buf: Some(cursor.to_string()),
            ..Default::default()
        }),
        Err(error) => Err(format!("收消息请求失败: {error}")),
        Ok(response) => {
            let text = read_body(response, "getupdates").await?;
            serde_json::from_str::<Updates>(&text)
                .map_err(|error| format!("收消息响应解析失败: {error}"))
        }
    }
}

/// POST `sendmessage`：回一条文本。`context_token` 必须来自对应入站消息，否则关联不到会话。
pub async fn send_text_message(
    client: &reqwest::Client,
    base_url: &str,
    token: &str,
    to_user_id: &str,
    context_token: &str,
    text: &str,
) -> Result<(), String> {
    let url = format!("{}/ilink/bot/sendmessage", api_base(base_url));
    let body = serde_json::json!({
        "msg": {
            "to_user_id": to_user_id,
            "message_type": 2,
            "message_state": 2,
            "context_token": context_token,
            "item_list": [{ "type": 1, "text_item": { "text": text } }],
        },
        "base_info": { "channel_version": CHANNEL_VERSION },
    });
    let response = api_request(client, Method::POST, &url, Some(token), Some(body))?
        .timeout(API_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("发送消息失败: {error}"))?;
    read_body(response, "sendmessage").await.map(|_| ())
}

/// POST `getconfig`：取 typing_ticket（发「正在输入」需要）。
pub async fn fetch_typing_ticket(
    client: &reqwest::Client,
    base_url: &str,
    token: &str,
    user_id: &str,
    context_token: &str,
) -> Result<Option<String>, String> {
    let url = format!("{}/ilink/bot/getconfig", api_base(base_url));
    let body = serde_json::json!({
        "ilink_user_id": user_id,
        "context_token": context_token,
        "base_info": { "channel_version": CHANNEL_VERSION },
    });
    let response = api_request(client, Method::POST, &url, Some(token), Some(body))?
        .timeout(API_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("取通道配置失败: {error}"))?;
    let text = read_body(response, "getconfig").await?;
    let config: BotConfig =
        serde_json::from_str(&text).map_err(|error| format!("通道配置解析失败: {error}"))?;
    Ok(config
        .typing_ticket
        .filter(|ticket| !ticket.trim().is_empty()))
}

/// POST `sendtyping`：发送 / 取消「正在输入」。
pub async fn send_typing(
    client: &reqwest::Client,
    base_url: &str,
    token: &str,
    user_id: &str,
    typing_ticket: &str,
    typing: bool,
) -> Result<(), String> {
    let url = format!("{}/ilink/bot/sendtyping", api_base(base_url));
    let body = serde_json::json!({
        "ilink_user_id": user_id,
        "typing_ticket": typing_ticket,
        "status": if typing { 1 } else { 2 },
        "base_info": { "channel_version": CHANNEL_VERSION },
    });
    let response = api_request(client, Method::POST, &url, Some(token), Some(body))?
        .timeout(API_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("输入状态请求失败: {error}"))?;
    read_body(response, "sendtyping").await.map(|_| ())
}

/* ===== 协议层：消息归一 ===== */

/// 是否为用户发来的消息（bot 自己发出的回声会被标成 2）。
pub fn is_user_message(message: &WeixinMessage) -> bool {
    message.message_type.unwrap_or(0) == 1
}

/// 取消息文本：文本条目直取；语音条目取微信云端转写（协议自带，无需本地识别）。
pub fn extract_text(message: &WeixinMessage) -> String {
    let mut parts: Vec<String> = Vec::new();
    for item in message.item_list.iter().flatten() {
        if let Some(text) = item.text_item.as_ref().and_then(|item| item.text.as_ref()) {
            if !text.trim().is_empty() {
                parts.push(text.trim().to_string());
            }
        }
        if let Some(text) = item.voice_item.as_ref().and_then(|item| item.text.as_ref()) {
            if !text.trim().is_empty() {
                parts.push(text.trim().to_string());
            }
        }
    }
    parts.join("\n")
}

/// 条目类型集合（1 文本 / 2 图片 / 3 语音 / 4 文件 / 5 视频），供界面如实说明收到了什么。
pub fn item_types(message: &WeixinMessage) -> Vec<i64> {
    message
        .item_list
        .iter()
        .flatten()
        .filter_map(|item| item.r#type)
        .collect()
}

/* ===== 宿主层：持久化 ===== */

/// 扫码登录得到的凭证（只落本机应用数据目录）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSession {
    pub token: String,
    pub base_url: String,
    pub bot_id: String,
    #[serde(default)]
    pub user_id: Option<String>,
    #[serde(default)]
    pub saved_at: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncState {
    #[serde(default)]
    cursor: String,
}

fn wechat_dir(app: &AppHandle) -> Result<PathBuf, String> {
    channel_dir(app, DIR_NAME)
}

/* ===== 宿主层：状态与命令 ===== */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WechatStatusDto {
    pub logged_in: bool,
    pub user_id: Option<String>,
    pub bot_id: Option<String>,
    /// stopped / connecting / connected / paused / error
    pub state: String,
    pub detail: Option<String>,
    pub last_message_at: Option<i64>,
    pub pending_login: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WechatQrDto {
    /// 要编码成二维码的链接文本。
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WechatLoginPollDto {
    pub status: String,
    /// `expired` 且宿主已自动换码时给出新二维码内容。
    pub qr_content: Option<String>,
    pub user_id: Option<String>,
    pub bot_id: Option<String>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WechatInboundDto {
    pub message_id: Option<i64>,
    pub from_user_id: String,
    pub context_token: String,
    pub text: String,
    pub item_types: Vec<i64>,
    pub create_time_ms: Option<i64>,
    pub at: i64,
}

struct PendingLogin {
    qrcode: String,
    refreshes: u32,
}

#[derive(Default)]
struct Inner {
    loaded: bool,
    session: Option<StoredSession>,
    cursor: String,
    pending: Option<PendingLogin>,
    state: String,
    detail: Option<String>,
    last_message_at: Option<i64>,
    running: bool,
}

impl Inner {
    fn status(&self) -> WechatStatusDto {
        WechatStatusDto {
            logged_in: self.session.is_some(),
            user_id: self
                .session
                .as_ref()
                .and_then(|session| session.user_id.clone()),
            bot_id: self.session.as_ref().map(|session| session.bot_id.clone()),
            state: if self.state.is_empty() {
                "stopped".into()
            } else {
                self.state.clone()
            },
            detail: self.detail.clone(),
            last_message_at: self.last_message_at,
            pending_login: self.pending.is_some(),
        }
    }
}

/// 通道宿主：凭证 / 游标 / 长轮询任务代际。
///
/// `epoch` 是长轮询任务的取消令牌：disconnect / 重连 / 退出登录都递增它，
/// 旧任务在下一轮检查时自行退出（不用 AbortHandle，任务边界天然是轮询往返）。
pub struct WechatHost {
    inner: Arc<Mutex<Inner>>,
    epoch: Arc<AtomicU64>,
}

impl Default for WechatHost {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner::default())),
            epoch: Arc::new(AtomicU64::new(0)),
        }
    }
}

impl WechatHost {
    async fn lock(&self) -> tokio::sync::MutexGuard<'_, Inner> {
        self.inner.lock().await
    }
}

/// 首次触碰时把磁盘上的凭证与游标读进内存（session 文件缺失即未登录）。
fn ensure_loaded(app: &AppHandle, inner: &mut Inner) -> Result<(), String> {
    if inner.loaded {
        return Ok(());
    }
    let dir = wechat_dir(app)?;
    inner.session = read_json::<StoredSession>(&dir.join(SESSION_FILE))
        .filter(|session| !session.token.trim().is_empty());
    inner.cursor = read_json::<SyncState>(&dir.join(SYNC_FILE))
        .map(|sync| sync.cursor)
        .unwrap_or_default();
    inner.state = "stopped".into();
    inner.loaded = true;
    Ok(())
}

fn save_cursor(app: &AppHandle, cursor: &str) {
    let Ok(dir) = wechat_dir(app) else { return };
    let state = SyncState {
        cursor: cursor.to_string(),
    };
    match serde_json::to_vec_pretty(&state) {
        Ok(bytes) => {
            if let Err(error) = std::fs::write(dir.join(SYNC_FILE), bytes) {
                log::warn("wechat", format!("游标落盘失败: {error}"));
            }
        }
        Err(error) => log::warn("wechat", format!("游标序列化失败: {error}")),
    }
}

/// 游标出口：长轮询同步游标需要落盘，重启后从上次位置继续。
type CursorSink = Arc<dyn Fn(&str) + Send + Sync>;

/// 长轮询循环的两个外部出口：事件广播与游标落盘。
///
/// 抽成闭包而不是直接依赖 `AppHandle`：循环是入站链路的骨架（收包 → 过滤 → 发事件），
/// 这两处是它唯一与宿主耦合的地方，拆开后它能在纯 Rust 测试里对着 mock 服务器跑完一整轮。
struct MonitorDeps {
    sink: EventSink,
    save_cursor: CursorSink,
}

impl MonitorDeps {
    fn for_app(app: &AppHandle) -> Self {
        let saver = app.clone();
        Self {
            sink: app_sink(app),
            save_cursor: Arc::new(move |cursor: &str| save_cursor(&saver, cursor)),
        }
    }

    fn emit(&self, event: &str, payload: serde_json::Value) {
        (self.sink)(event, payload);
    }
}

/// 广播当前状态（调用方已持有锁，这里只做序列化与派发）。
fn emit_state(inner: &Inner, deps: &MonitorDeps) {
    deps.emit(
        STATE_EVENT,
        serde_json::to_value(inner.status()).unwrap_or(serde_json::Value::Null),
    );
}

/// 宿主层统一的「一次 API 调用」客户端：连接超时 10s，长轮询超时按请求单独设。
fn api_client() -> Result<reqwest::Client, String> {
    crate::http::shared_client(10)
}

/// 一次长轮询往返的落点：正常收包 / 服务端业务错误 / 传输失败。
enum PollOutcome {
    Updates(Updates),
    ApiError(i64, String),
    Transport(String),
}

async fn poll_once(session: &StoredSession, cursor: &str, timeout: Duration) -> PollOutcome {
    let client = match api_client() {
        Ok(client) => client,
        Err(error) => return PollOutcome::Transport(error),
    };
    match get_updates(&client, &session.base_url, &session.token, cursor, timeout).await {
        Ok(updates) => match updates.error_code() {
            Some(code) => PollOutcome::ApiError(code, updates.error_text()),
            None => PollOutcome::Updates(updates),
        },
        Err(error) => PollOutcome::Transport(error),
    }
}

async fn set_state(inner: &Mutex<Inner>, deps: &MonitorDeps, state: &str, detail: Option<String>) {
    let mut guard = inner.lock().await;
    guard.state = state.to_string();
    guard.detail = detail;
    guard.running = state == "connecting" || state == "connected" || state == "paused";
    deps.emit(
        STATE_EVENT,
        serde_json::to_value(guard.status()).unwrap_or(serde_json::Value::Null),
    );
}

/// 长轮询主循环：收消息 → 发事件；会话过期暂停一小时；连续失败退避。
async fn run_monitor(
    deps: MonitorDeps,
    inner: Arc<Mutex<Inner>>,
    epochs: Arc<AtomicU64>,
    epoch: u64,
    session: StoredSession,
    mut cursor: String,
    allow_other_senders: bool,
) {
    let mut timeout = LONG_POLL_TIMEOUT;
    let mut failures: u32 = 0;
    log::info(
        "wechat",
        format!("通道长轮询启动 account={}", session.bot_id),
    );

    while epochs.load(Ordering::SeqCst) == epoch {
        match poll_once(&session, &cursor, timeout).await {
            PollOutcome::Transport(error) => {
                failures += 1;
                log::warn(
                    "wechat",
                    format!("收消息失败({failures}/{MAX_CONSECUTIVE_FAILURES}): {error}"),
                );
                set_state(&inner, &deps, "error", Some(error)).await;
                let wait = if failures >= MAX_CONSECUTIVE_FAILURES {
                    failures = 0;
                    BACKOFF_DELAY
                } else {
                    RETRY_DELAY
                };
                if !sleep_or_stop(&epochs, epoch, wait).await {
                    break;
                }
            }
            PollOutcome::ApiError(code, detail) => {
                if code == SESSION_EXPIRED_ERRCODE {
                    // 会话过期：官方实现暂停一小时再自动重试；期间发消息也会被服务端拒绝。
                    log::warn("wechat", "会话过期（-14），暂停一小时后自动重试");
                    set_state(
                        &inner,
                        &deps,
                        "paused",
                        Some(format!("登录态已过期，暂停一小时后重试（{detail}）")),
                    )
                    .await;
                    if !sleep_or_stop(&epochs, epoch, SESSION_PAUSE).await {
                        break;
                    }
                    set_state(&inner, &deps, "connecting", None).await;
                    continue;
                }
                failures += 1;
                log::warn(
                    "wechat",
                    format!("服务端错误({failures}/{MAX_CONSECUTIVE_FAILURES}): {detail}"),
                );
                set_state(&inner, &deps, "error", Some(detail)).await;
                let wait = if failures >= MAX_CONSECUTIVE_FAILURES {
                    failures = 0;
                    BACKOFF_DELAY
                } else {
                    RETRY_DELAY
                };
                if !sleep_or_stop(&epochs, epoch, wait).await {
                    break;
                }
            }
            PollOutcome::Updates(updates) => {
                failures = 0;
                if let Some(suggested) = updates.longpolling_timeout_ms.filter(|value| *value > 0) {
                    timeout = Duration::from_millis(suggested as u64);
                }
                if let Some(next) = updates
                    .get_updates_buf
                    .clone()
                    .filter(|value| !value.is_empty())
                {
                    cursor = next;
                    (deps.save_cursor)(&cursor);
                }
                let messages = updates.msgs.unwrap_or_default();
                if !messages.is_empty() {
                    log::info("wechat", format!("收到 {} 条消息", messages.len()));
                }
                for message in messages {
                    if !is_user_message(&message) {
                        continue;
                    }
                    let from = message.from_user_id.clone().unwrap_or_default();
                    if from.is_empty() {
                        continue;
                    }
                    if !allow_other_senders && session.user_id.as_deref() != Some(from.as_str()) {
                        log::info(
                            "wechat",
                            format!("忽略非授权发送者 {from}（可在设置中允许其他联系人）"),
                        );
                        continue;
                    }
                    let inbound = WechatInboundDto {
                        message_id: message.message_id,
                        from_user_id: from,
                        context_token: message.context_token.clone().unwrap_or_default(),
                        text: extract_text(&message),
                        item_types: item_types(&message),
                        create_time_ms: message.create_time_ms,
                        at: now_ms(),
                    };
                    {
                        let mut guard = inner.lock().await;
                        guard.last_message_at = Some(inbound.at);
                        deps.emit(
                            STATE_EVENT,
                            serde_json::to_value(guard.status()).unwrap_or(serde_json::Value::Null),
                        );
                    }
                    deps.emit(
                        INBOUND_EVENT,
                        serde_json::to_value(inbound).unwrap_or(serde_json::Value::Null),
                    );
                }
                // 一次成功往返即视为已连上（首轮/暂停恢复都经这里翻转）。
                {
                    let mut guard = inner.lock().await;
                    if guard.state != "connected" {
                        guard.state = "connected".into();
                        guard.detail = None;
                        guard.running = true;
                        deps.emit(
                            STATE_EVENT,
                            serde_json::to_value(guard.status()).unwrap_or(serde_json::Value::Null),
                        );
                    }
                }
            }
        }
    }
    log::info("wechat", "通道长轮询已停止");
}

/* ===== 宿主层：Tauri 命令 ===== */

/// 当前通道状态（含是否已登录、长轮询状态、最近收消息时间）。
#[tauri::command]
pub async fn wechat_status(
    app: AppHandle,
    host: State<'_, WechatHost>,
) -> Result<WechatStatusDto, String> {
    let mut inner = host.lock().await;
    ensure_loaded(&app, &mut inner)?;
    Ok(inner.status())
}

/// 申请登录二维码；会作废上一个未完成的扫码会话。
#[tauri::command]
pub async fn wechat_login_qr(
    app: AppHandle,
    host: State<'_, WechatHost>,
) -> Result<WechatQrDto, String> {
    let client = api_client()?;
    let qr = fetch_login_qr(&client, DEFAULT_BASE_URL).await?;
    let mut inner = host.lock().await;
    ensure_loaded(&app, &mut inner)?;
    inner.pending = Some(PendingLogin {
        qrcode: qr.qrcode,
        refreshes: 0,
    });
    Ok(WechatQrDto {
        content: qr.qrcode_img_content,
    })
}

/// 一次扫码轮询的落点（纯决策，不含副作用）：命令层据此写状态、落盘与回包。
#[derive(Debug)]
enum LoginStep {
    /// 未扫码 / 已扫码待确认（透传服务端状态字）。
    Waiting(String),
    /// 二维码过期，宿主已自动换码。
    Refreshed(LoginQr),
    /// 登录完成：凭证已构造（尚未落盘）。
    Confirmed(Box<StoredSession>),
    /// 二维码多次过期，放弃本次登录。
    GiveUp(String),
}

/// 轮询一次并决策（会就地更新 pending：换码时替换句柄、过期计数 +1）。
///
/// 单独成函数是为了让「未扫码 → 已扫码 → 过期换码 → 放弃 / 确认」这条状态机
/// 能在纯 Rust 测试里对着 mock 服务器跑完，而不必拉起 Tauri 命令层。
async fn poll_login_step(
    client: &reqwest::Client,
    base_url: &str,
    pending: &mut PendingLogin,
) -> Result<LoginStep, String> {
    let status = poll_login_status(client, base_url, &pending.qrcode).await?;
    match status.status.as_str() {
        "confirmed" => {
            let token = status
                .bot_token
                .filter(|value| !value.trim().is_empty())
                .ok_or("登录已确认，但服务端未返回凭证")?;
            let bot_id = status
                .ilink_bot_id
                .filter(|value| !value.trim().is_empty())
                .ok_or("登录已确认，但服务端未返回 bot id")?;
            // 后续请求（含 bot_token）都打到这个地址：只认 qq.com 域，其余一律拒绝。
            let base_url = match status.baseurl.as_deref() {
                Some(raw) => validate_base_url(raw)?,
                None => DEFAULT_BASE_URL.to_string(),
            };
            Ok(LoginStep::Confirmed(Box::new(StoredSession {
                token,
                base_url,
                bot_id,
                user_id: status
                    .ilink_user_id
                    .filter(|value| !value.trim().is_empty()),
                saved_at: Some(chrono::Utc::now().to_rfc3339()),
            })))
        }
        "expired" => {
            pending.refreshes += 1;
            if pending.refreshes > MAX_QR_REFRESH {
                return Ok(LoginStep::GiveUp("二维码多次过期，请重新开始扫码".into()));
            }
            let qr = fetch_login_qr(client, base_url).await?;
            pending.qrcode = qr.qrcode.clone();
            Ok(LoginStep::Refreshed(qr))
        }
        other => Ok(LoginStep::Waiting(if other == "scaned" {
            "scaned".to_string()
        } else {
            "wait".to_string()
        })),
    }
}

/// 长轮询一次扫码状态。`expired` 时宿主自动换码（最多 3 次）并把新二维码内容带回。
///
/// 网络往返（最长 ~35s）期间**不放持锁**：扫码流程与状态查询是并发的（界面会同时
/// 刷状态），让 30 秒的长轮询把宿主锁住会把这些查询全卡在门口。
#[tauri::command]
pub async fn wechat_login_poll(
    app: AppHandle,
    host: State<'_, WechatHost>,
) -> Result<WechatLoginPollDto, String> {
    let client = api_client()?;
    let (session_qrcode, mut working) = {
        let inner = host.lock().await;
        let pending = inner.pending.as_ref().ok_or("当前没有进行中的扫码登录")?;
        (
            pending.qrcode.clone(),
            PendingLogin {
                qrcode: pending.qrcode.clone(),
                refreshes: pending.refreshes,
            },
        )
    };

    let step = poll_login_step(&client, DEFAULT_BASE_URL, &mut working).await?;

    // 写回前确认这仍是同一个扫码会话：用户可能已经取消并重开，别把新会话覆盖掉。
    let same_session = |inner: &Inner| {
        inner
            .pending
            .as_ref()
            .map(|pending| pending.qrcode.as_str())
            == Some(session_qrcode.as_str())
    };

    match step {
        LoginStep::Waiting(status) => Ok(WechatLoginPollDto {
            status,
            qr_content: None,
            user_id: None,
            bot_id: None,
            detail: None,
        }),
        LoginStep::Refreshed(qr) => {
            let mut inner = host.lock().await;
            if same_session(&inner) {
                inner.pending = Some(working);
            }
            Ok(WechatLoginPollDto {
                status: "expired".into(),
                qr_content: Some(qr.qrcode_img_content),
                user_id: None,
                bot_id: None,
                detail: None,
            })
        }
        LoginStep::GiveUp(detail) => {
            let mut inner = host.lock().await;
            if same_session(&inner) {
                inner.pending = None;
            }
            Ok(WechatLoginPollDto {
                status: "expired".into(),
                qr_content: None,
                user_id: None,
                bot_id: None,
                detail: Some(detail),
            })
        }
        LoginStep::Confirmed(session) => {
            let session = *session;
            let dir = wechat_dir(&app)?;
            let bytes = serde_json::to_vec_pretty(&session)
                .map_err(|error| format!("凭证序列化失败: {error}"))?;
            write_private(&dir.join(SESSION_FILE), &bytes)?;
            log::info("wechat", format!("扫码登录成功 bot={}", session.bot_id));

            let mut inner = host.lock().await;
            inner.session = Some(session.clone());
            if same_session(&inner) {
                inner.pending = None;
            }
            inner.state = "stopped".into();
            inner.detail = None;
            inner.loaded = true;
            emit_state(&inner, &MonitorDeps::for_app(&app));

            Ok(WechatLoginPollDto {
                status: "confirmed".into(),
                qr_content: None,
                user_id: session.user_id.clone(),
                bot_id: Some(session.bot_id.clone()),
                detail: None,
            })
        }
    }
}

/// 取消进行中的扫码会话（关闭二维码视图时调用）。
#[tauri::command]
pub async fn wechat_login_cancel(host: State<'_, WechatHost>) -> Result<(), String> {
    let mut inner = host.lock().await;
    inner.pending = None;
    Ok(())
}

/// 启动收消息长轮询。`allow_other_senders=false` 时只放行扫码本人的消息。
#[tauri::command]
pub async fn wechat_connect(
    app: AppHandle,
    host: State<'_, WechatHost>,
    allow_other_senders: bool,
) -> Result<(), String> {
    let (session, cursor) = {
        let mut inner = host.lock().await;
        ensure_loaded(&app, &mut inner)?;
        let session = inner.session.clone().ok_or("尚未扫码登录微信")?;
        let cursor = inner.cursor.clone();
        inner.state = "connecting".into();
        inner.detail = None;
        inner.running = true;
        emit_state(&inner, &MonitorDeps::for_app(&app));
        (session, cursor)
    };
    // 代际 +1：上一个长轮询任务在下一轮检查时退出。
    let epoch = host.epoch.fetch_add(1, Ordering::SeqCst) + 1;
    let inner = host.inner.clone();
    let epochs = host.epoch.clone();
    let deps = MonitorDeps::for_app(&app);
    tauri::async_runtime::spawn(async move {
        run_monitor(
            deps,
            inner,
            epochs,
            epoch,
            session,
            cursor,
            allow_other_senders,
        )
        .await;
    });
    Ok(())
}

/// 停止长轮询（保留登录态）。
#[tauri::command]
pub async fn wechat_disconnect(app: AppHandle, host: State<'_, WechatHost>) -> Result<(), String> {
    host.epoch.fetch_add(1, Ordering::SeqCst);
    let mut inner = host.lock().await;
    ensure_loaded(&app, &mut inner)?;
    inner.state = "stopped".into();
    inner.detail = None;
    inner.running = false;
    emit_state(&inner, &MonitorDeps::for_app(&app));
    Ok(())
}

/// 退出登录：停长轮询 + 删除本机凭证（下次使用需重新扫码）。
#[tauri::command]
pub async fn wechat_logout(app: AppHandle, host: State<'_, WechatHost>) -> Result<(), String> {
    host.epoch.fetch_add(1, Ordering::SeqCst);
    let mut inner = host.lock().await;
    ensure_loaded(&app, &mut inner)?;
    inner.session = None;
    inner.cursor = String::new();
    inner.pending = None;
    inner.state = "stopped".into();
    inner.detail = None;
    inner.running = false;
    inner.last_message_at = None;
    let dir = wechat_dir(&app)?;
    for name in [SESSION_FILE, SYNC_FILE] {
        let path = dir.join(name);
        if path.exists() {
            if let Err(error) = std::fs::remove_file(&path) {
                log::warn("wechat", format!("删除 {} 失败: {error}", path.display()));
            }
        }
    }
    emit_state(&inner, &MonitorDeps::for_app(&app));
    log::info("wechat", "已退出登录，凭证已清除");
    Ok(())
}

/// 回一条文本；`context_token` 必须来自对应入站消息。
#[tauri::command]
pub async fn wechat_send(
    app: AppHandle,
    host: State<'_, WechatHost>,
    to_user_id: String,
    context_token: String,
    text: String,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("回复内容为空".into());
    }
    let session = {
        let mut inner = host.lock().await;
        ensure_loaded(&app, &mut inner)?;
        inner.session.clone().ok_or("尚未扫码登录微信")?
    };
    let client = api_client()?;
    send_text_message(
        &client,
        &session.base_url,
        &session.token,
        &to_user_id,
        &context_token,
        &text,
    )
    .await
}

/// 发送 / 取消「正在输入」。失败按体验增强处理（拿不到票据就静默跳过）。
#[tauri::command]
pub async fn wechat_send_typing(
    app: AppHandle,
    host: State<'_, WechatHost>,
    to_user_id: String,
    context_token: String,
    typing: bool,
) -> Result<(), String> {
    let session = {
        let mut inner = host.lock().await;
        ensure_loaded(&app, &mut inner)?;
        inner.session.clone().ok_or("尚未扫码登录微信")?
    };
    let client = api_client()?;
    let Some(ticket) = fetch_typing_ticket(
        &client,
        &session.base_url,
        &session.token,
        &to_user_id,
        &context_token,
    )
    .await?
    else {
        return Ok(());
    };
    send_typing(
        &client,
        &session.base_url,
        &session.token,
        &to_user_id,
        &ticket,
        typing,
    )
    .await
}

/* ===== 单测（纯函数） ===== */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wechat_uin_is_base64_of_decimal_u32() {
        let encoded = random_wechat_uin().expect("uin");
        let decoded = String::from_utf8(BASE64.decode(&encoded).expect("base64")).expect("utf8");
        let value: u64 = decoded.parse().expect("decimal");
        assert!(
            value <= u32::MAX as u64,
            "UIN 必须是 uint32 的十进制字符串：{decoded}"
        );
    }

    #[test]
    fn base_url_must_be_https_under_qq_com() {
        assert!(validate_base_url("https://ilinkai.weixin.qq.com").is_ok());
        assert!(validate_base_url("https://ilinkai.weixin.qq.com/").is_ok());
        assert!(
            validate_base_url("http://ilinkai.weixin.qq.com").is_err(),
            "非 https 拒绝"
        );
        assert!(
            validate_base_url("https://evil.example.com").is_err(),
            "非 qq.com 域拒绝"
        );
        assert!(
            validate_base_url("https://qq.com.evil.example.com").is_err(),
            "后缀伪装拒绝"
        );
    }

    #[test]
    fn extract_text_reads_text_and_voice_transcript() {
        let message = WeixinMessage {
            message_id: Some(1),
            from_user_id: Some("user@im.wechat".into()),
            context_token: Some("ctx".into()),
            create_time_ms: Some(1),
            message_type: Some(1),
            item_list: Some(vec![
                MessageItem {
                    r#type: Some(1),
                    text_item: Some(TextItem {
                        text: Some("你好".into()),
                    }),
                    voice_item: None,
                },
                MessageItem {
                    r#type: Some(3),
                    text_item: None,
                    voice_item: Some(VoiceItem {
                        text: Some("语音转写".into()),
                    }),
                },
            ]),
        };
        assert_eq!(extract_text(&message), "你好\n语音转写");
        assert_eq!(item_types(&message), vec![1, 3]);
        assert!(is_user_message(&message));
        assert!(!is_user_message(&WeixinMessage {
            message_id: None,
            from_user_id: None,
            context_token: None,
            create_time_ms: None,
            message_type: Some(2),
            item_list: None,
        }));
    }

    #[test]
    fn updates_error_code_uses_ret_and_errcode() {
        let ok = Updates {
            ret: Some(0),
            errcode: Some(0),
            ..Default::default()
        };
        assert_eq!(ok.error_code(), None);
        let expired = Updates {
            ret: Some(0),
            errcode: Some(SESSION_EXPIRED_ERRCODE),
            ..Default::default()
        };
        assert_eq!(expired.error_code(), Some(SESSION_EXPIRED_ERRCODE));
        let failed = Updates {
            ret: Some(7),
            errcode: None,
            ..Default::default()
        };
        assert_eq!(failed.error_code(), Some(7));
    }

    /* ===== 长轮询循环：对 mock 服务器跑真实一轮 ===== */

    use parking_lot::Mutex as PlMutex;

    /// 按接口路径分派的极简应答器（循环/登录状态机各自只打少数几个端点）。
    struct MockBodies {
        updates: &'static str,
        status: &'static str,
        qr: &'static str,
    }

    async fn spawn_ilink_mock(bodies: MockBodies) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    // 读到请求头结束 + Content-Length 指定的 body，再回响应：
                    // 提前关连接会让客户端报「请求未发完」。
                    let mut buffer: Vec<u8> = Vec::new();
                    let mut chunk = [0u8; 2048];
                    let request_line = loop {
                        let read = stream.read(&mut chunk).await.unwrap_or(0);
                        if read == 0 {
                            return;
                        }
                        buffer.extend_from_slice(&chunk[..read]);
                        if let Some(position) =
                            buffer.windows(4).position(|window| window == b"\r\n\r\n")
                        {
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
                                break head.lines().next().unwrap_or_default().to_string();
                            }
                        }
                    };
                    let body = if request_line.contains("getupdates") {
                        bodies.updates
                    } else if request_line.contains("get_qrcode_status") {
                        bodies.status
                    } else {
                        bodies.qr
                    };
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                    let _ = stream.shutdown().await;
                });
            }
        });
        format!("http://{addr}")
    }

    /// 一条二维码的应答（换码流程用）。
    const QR_BODY: &str =
        r#"{"qrcode":"qr-1","qrcode_img_content":"https://liteapp.weixin.qq.com/q/demo","ret":0}"#;

    /// 入站一轮：只放行扫码本人、事件形状正确、状态翻到 connected、游标落盘。
    #[tokio::test]
    async fn monitor_loop_emits_authorized_inbound_and_connects() {
        static BODY: &str = r#"{"ret":0,"msgs":[
            {"message_id":11,"from_user_id":"me@im.wechat","context_token":"ctx-1","create_time_ms":1730000000000,"message_type":1,"item_list":[{"type":1,"text_item":{"text":"在吗"}}]},
            {"message_id":12,"from_user_id":"bot@im.bot","context_token":"ctx-1","message_type":2,"item_list":[{"type":1,"text_item":{"text":"回声"}}]},
            {"message_id":13,"from_user_id":"stranger@im.wechat","context_token":"ctx-9","message_type":1,"item_list":[{"type":1,"text_item":{"text":"陌生人来信"}}]}
        ],"get_updates_buf":"cursor-9","longpolling_timeout_ms":35000}"#;

        let base = spawn_ilink_mock(MockBodies {
            updates: BODY,
            status: "{}",
            qr: QR_BODY,
        })
        .await;
        let session = StoredSession {
            token: "bot-token".into(),
            base_url: base,
            bot_id: "bot@im.bot".into(),
            user_id: Some("me@im.wechat".into()),
            saved_at: None,
        };
        let inner = Arc::new(Mutex::new(Inner::default()));
        let epochs = Arc::new(AtomicU64::new(7));
        let events: Arc<PlMutex<Vec<(String, serde_json::Value)>>> =
            Arc::new(PlMutex::new(Vec::new()));
        let cursors: Arc<PlMutex<Vec<String>>> = Arc::new(PlMutex::new(Vec::new()));

        let deps = MonitorDeps {
            sink: {
                let events = events.clone();
                Arc::new(move |event: &str, payload: serde_json::Value| {
                    events.lock().push((event.to_string(), payload));
                })
            },
            save_cursor: {
                let cursors = cursors.clone();
                Arc::new(move |cursor: &str| cursors.lock().push(cursor.to_string()))
            },
        };

        let task = {
            let inner = inner.clone();
            let epochs = epochs.clone();
            tokio::spawn(async move {
                run_monitor(deps, inner, epochs, 7, session, String::new(), false).await;
            })
        };

        // 收到第一条入站事件即收工：把代际推走，循环下一轮自行退出。
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            let received = events
                .lock()
                .iter()
                .any(|(event, _)| event == INBOUND_EVENT);
            if received || tokio::time::Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        epochs.store(99, Ordering::SeqCst);
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .expect("循环退出")
            .expect("任务未 panic");

        let inbound: Vec<serde_json::Value> = events
            .lock()
            .iter()
            .filter(|(event, _)| event == INBOUND_EVENT)
            .map(|(_, payload)| payload.clone())
            .collect();
        assert!(!inbound.is_empty(), "应收到 inbound 事件");
        let first = &inbound[0];
        assert_eq!(first["fromUserId"], "me@im.wechat");
        assert_eq!(first["text"], "在吗");
        assert_eq!(first["contextToken"], "ctx-1");
        assert_eq!(first["itemTypes"], serde_json::json!([1]));
        assert!(
            !inbound
                .iter()
                .any(|payload| payload["fromUserId"] == "stranger@im.wechat"),
            "默认只放行扫码本人，陌生发送者不得进事件流"
        );
        assert!(
            !inbound
                .iter()
                .any(|payload| payload["fromUserId"] == "bot@im.bot"),
            "bot 自己的回声不得进事件流"
        );

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
        let saved_cursors = cursors.lock().clone();
        assert!(!saved_cursors.is_empty(), "游标应落盘");
        assert!(
            saved_cursors.iter().all(|cursor| cursor == "cursor-9"),
            "游标内容应为响应里的新游标：{saved_cursors:?}"
        );

        let guard = inner.lock().await;
        assert_eq!(guard.state, "connected");
        assert!(guard.last_message_at.is_some());
    }

    /* ===== 扫码登录状态机 ===== */

    /// 二维码过期换码：自动换码、计数、超限放弃。
    #[tokio::test]
    async fn login_step_refreshes_expired_qr_then_gives_up() {
        static EXPIRED: &str = r#"{"ret":0,"status":"expired"}"#;
        let base = spawn_ilink_mock(MockBodies {
            updates: "{}",
            status: EXPIRED,
            qr: QR_BODY,
        })
        .await;
        let client = reqwest::Client::new();
        let mut pending = PendingLogin {
            qrcode: "qr-1".into(),
            refreshes: 0,
        };

        for round in 1..=MAX_QR_REFRESH {
            match poll_login_step(&client, &base, &mut pending)
                .await
                .expect("step")
            {
                LoginStep::Refreshed(qr) => {
                    assert_eq!(pending.refreshes, round);
                    assert_eq!(qr.qrcode, "qr-1", "换码来自 get_bot_qrcode 的响应");
                    assert!(qr.qrcode_img_content.contains("liteapp.weixin.qq.com"));
                }
                other => panic!("第 {round} 轮应是换码，实际 {other:?}"),
            }
        }

        match poll_login_step(&client, &base, &mut pending)
            .await
            .expect("step")
        {
            LoginStep::GiveUp(detail) => assert!(detail.contains("多次过期"), "{detail}"),
            other => panic!("超限应放弃，实际 {other:?}"),
        }
        assert_eq!(pending.refreshes, MAX_QR_REFRESH + 1);
    }

    /// 扫码确认：凭证从服务端字段构造，baseurl 走校验。
    #[tokio::test]
    async fn login_step_builds_session_on_confirmed() {
        static CONFIRMED: &str = r#"{"ret":0,"status":"confirmed","bot_token":"tok-1","ilink_bot_id":"bot@im.bot","baseurl":"https://ilinkai.weixin.qq.com/","ilink_user_id":"me@im.wechat"}"#;
        let base = spawn_ilink_mock(MockBodies {
            updates: "{}",
            status: CONFIRMED,
            qr: QR_BODY,
        })
        .await;
        let client = reqwest::Client::new();
        let mut pending = PendingLogin {
            qrcode: "qr-1".into(),
            refreshes: 0,
        };

        match poll_login_step(&client, &base, &mut pending)
            .await
            .expect("step")
        {
            LoginStep::Confirmed(session) => {
                assert_eq!(session.token, "tok-1");
                assert_eq!(session.bot_id, "bot@im.bot");
                assert_eq!(session.user_id.as_deref(), Some("me@im.wechat"));
                assert_eq!(
                    session.base_url, "https://ilinkai.weixin.qq.com",
                    "尾斜杠由校验归一"
                );
                assert!(session.saved_at.is_some());
            }
            other => panic!("应确认登录，实际 {other:?}"),
        }
    }

    /// 服务端下发非 qq.com 的 baseurl：拒绝（否则后续请求会把 bot_token 递给第三方）。
    #[tokio::test]
    async fn login_step_rejects_untrusted_base_url() {
        static EVIL: &str = r#"{"ret":0,"status":"confirmed","bot_token":"tok-1","ilink_bot_id":"bot@im.bot","baseurl":"https://evil.example.com"}"#;
        let base = spawn_ilink_mock(MockBodies {
            updates: "{}",
            status: EVIL,
            qr: QR_BODY,
        })
        .await;
        let client = reqwest::Client::new();
        let mut pending = PendingLogin {
            qrcode: "qr-1".into(),
            refreshes: 0,
        };
        let error = poll_login_step(&client, &base, &mut pending)
            .await
            .expect_err("不可信 baseurl 必须报错");
        assert!(error.contains("qq.com"), "{error}");
    }

    /// 未扫码 / 已扫码：原样透传状态字。
    #[tokio::test]
    async fn login_step_passes_through_waiting_states() {
        static SCANNED: &str = r#"{"ret":0,"status":"scaned"}"#;
        let base = spawn_ilink_mock(MockBodies {
            updates: "{}",
            status: SCANNED,
            qr: QR_BODY,
        })
        .await;
        let client = reqwest::Client::new();
        let mut pending = PendingLogin {
            qrcode: "qr-1".into(),
            refreshes: 0,
        };
        match poll_login_step(&client, &base, &mut pending)
            .await
            .expect("step")
        {
            LoginStep::Waiting(status) => assert_eq!(status, "scaned"),
            other => panic!("应透传 scaned，实际 {other:?}"),
        }
        assert_eq!(pending.refreshes, 0, "未过期不该累计换码次数");
    }
}
