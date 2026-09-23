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
use std::path::PathBuf;
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
use crate::channel_media::{inbox_dir, prune_inbox, store_inbound_media, MediaKind, MediaRefDto};
use crate::log;

/// Stream 建连入口（钉钉开放平台）。
pub const STREAM_OPEN_URL: &str = "https://api.dingtalk.com/v1.0/gateway/connections/open";
/// 机器人单聊/群聊消息的订阅 topic。
pub const CHATBOT_TOPIC: &str = "/v1.0/im/bot/messages/get";
/// 取企业内部应用 accessToken（换下载链接要带它）。
const ACCESS_TOKEN_URL: &str = "https://api.dingtalk.com/v1.0/oauth2/accessToken";
/// 用 `downloadCode` 换临时下载链接。
const FILE_DOWNLOAD_URL: &str = "https://api.dingtalk.com/v1.0/robot/messageFiles/download";
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
/// 单条消息最多收几张图（防止一条消息拖垮一整轮下载）。
const MAX_INBOUND_MEDIA: usize = 4;
/// accessToken 提前刷新窗口（官方 7200s 有效，到期前重取）。
const TOKEN_REFRESH_MARGIN_SECS: i64 = 60;

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
struct AccessTokenResponse {
    #[serde(default, rename = "accessToken")]
    access_token: Option<String>,
    #[serde(default, rename = "expireIn")]
    expire_in: Option<i64>,
    #[serde(default)]
    message: Option<String>,
}

/// 换下载链接的响应。
#[derive(Debug, Clone, Default, Deserialize)]
struct DownloadUrlResponse {
    #[serde(default, rename = "downloadUrl")]
    download_url: Option<String>,
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

    /// 本条消息里可下载的图片下载码（picture 的顶层下载码 + 富文本里的图片项），最多 4 张。
    ///
    /// 钉钉的富文本下发形状有两种（`content.richText` 或顶层 `richText`），都兼容。
    pub fn pending_images(&self) -> Vec<String> {
        let mut codes = Vec::new();
        if self.msgtype.as_deref() == Some("picture") {
            if let Some(code) = self
                .download_code
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                codes.push(code.to_string());
            }
        }
        if self.msgtype.as_deref() == Some("richText") {
            for item in self.rich_text_items() {
                if let Some(code) = rich_text_image_code(&item) {
                    codes.push(code);
                }
            }
        }
        codes.truncate(MAX_INBOUND_MEDIA);
        codes
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

/* ===== 扫码创建应用（设备授权流程） =====
 *
 * 与「用户已在开放平台建好应用」的手填路径并列的另一条入口：手机钉钉扫码 → 确认 →
 * 服务端直接把 Client ID / Client Secret 交给宿主，用户不必去控制台抄两串密钥。
 *
 * 协议（与钉钉官方 OpenClaw 连接器 `device-auth.ts` 同形，全程 JSON）：
 * 1. `POST https://oapi.dingtalk.com/app/registration/init` `{"source":…}` → `{errcode:0, nonce}`
 * 2. `POST /app/registration/begin` `{"nonce":…}`
 *    → `{errcode:0, device_code, user_code?, verification_uri_complete, expires_in, interval}`
 * 3. `verification_uri_complete` 编成二维码 → 手机扫码确认
 * 4. 每 `interval` 秒 `POST /app/registration/poll` `{"device_code":…}`
 *    → `{errcode:0, status}`：`WAITING`（继续等）/ `SUCCESS`（带 client_id + client_secret）/
 *    `FAIL`（`fail_reason` 说明原因）/ `EXPIRED`
 *
 * 与飞书那条流程的两处关键差异：
 * - 「等待中」是 `errcode:0` + `status:WAITING`，**不是** HTTP 400 + 错误码那套；
 * - `source` 是调用方标识（官方连接器同值），服务端据此路由到「一键创建机器人」页。
 *
 * 与手填路径一致：密钥只落宿主磁盘（0600），`device_code` 也只留在宿主内存里。
 *
 * 这几个接口没有公开文档，是钉钉给自家客户端留的内部通道；协议若变更，这里会以
 * `errcode != 0` 或解析失败的形式**显式报错**（不静默失败），界面退回手填凭证即可。
 */

/// 注册接口在钉钉 OAPI 域（新版 `api.dingtalk.com` 上没有这个接口）。
pub const REGISTRATION_BASE_URL: &str = "https://oapi.dingtalk.com";
const REGISTRATION_INIT_PATH: &str = "/app/registration/init";
const REGISTRATION_BEGIN_PATH: &str = "/app/registration/begin";
const REGISTRATION_POLL_PATH: &str = "/app/registration/poll";
/// 调用方标识：官方 OpenClaw 连接器同值，服务端据此路由到「一键创建机器人」页。
const REGISTRATION_SOURCE: &str = "DING_DWS_CLAW";
/// 服务端没给 `expires_in` / `interval` 时的兜底（官方连接器同值）。
const DEFAULT_EXPIRE_IN: u64 = 7200;
const DEFAULT_POLL_INTERVAL: u64 = 3;

/// OAPI 统一信封：`errcode != 0` 即失败。
#[derive(Debug, Clone, Deserialize)]
struct ApiEnvelope<T> {
    errcode: i64,
    #[serde(default)]
    errmsg: Option<String>,
    #[serde(flatten)]
    data: T,
}

impl<T> ApiEnvelope<T> {
    fn into_data(self, action: &str) -> Result<T, String> {
        if self.errcode != 0 {
            let detail = self.errmsg.unwrap_or_default();
            let detail = detail.trim();
            return Err(if detail.is_empty() {
                format!("{action}失败（errcode={}）", self.errcode)
            } else {
                format!("{action}失败：{detail}（errcode={}）", self.errcode)
            });
        }
        Ok(self.data)
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
struct InitBody {
    #[serde(default)]
    nonce: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct BeginBody {
    #[serde(default)]
    device_code: Option<String>,
    #[serde(default)]
    user_code: Option<String>,
    #[serde(default)]
    verification_uri_complete: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
    #[serde(default)]
    interval: Option<u64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct PollBody {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    client_id: Option<String>,
    #[serde(default)]
    client_secret: Option<String>,
    #[serde(default)]
    fail_reason: Option<String>,
}

/// 一次轮询的判定（纯函数产出，便于单测）。
#[derive(Debug, Clone, PartialEq)]
pub enum PollOutcome {
    /// `WAITING`：还没扫码 / 还没在手机上确认。
    Pending,
    Done {
        client_id: String,
        client_secret: String,
    },
    /// `EXPIRED`：本次 device_code 已过期。
    Expired(String),
    /// `FAIL`，或没见过的状态 —— 后者如实报错，免得一直轮询到超时。
    Failed(String),
}

/// 进行中的扫码会话（`device_code` 只在宿主内存，不落盘）。
///
/// 不存轮询间隔：钉钉没有「服务端要求放慢」那套，间隔一次定死在 `RegisterStartDto` 里，
/// 由渲染端自己按它轮询。
#[derive(Debug, Clone)]
pub struct RegisterSession {
    device_code: String,
    /// 过期时刻（毫秒时间戳），由 `expires_in` 推出。
    expires_at: i64,
}

/// 扫码引导信息（渲染端只需要这些：把 `qr_url` 编成二维码，显示配对码）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterStartDto {
    pub qr_url: String,
    /// 手机上的配对码（钉钉不保证下发，可能为 None）。
    pub user_code: Option<String>,
    pub expires_in: u64,
    pub interval: u64,
}

/// 一次轮询的结果。`state`：pending / done / expired / error。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterPollDto {
    pub state: String,
    pub detail: Option<String>,
    /// 成功时的 Client ID（Client Secret 已由宿主落盘，不下发到界面）。
    pub client_id: Option<String>,
}

impl PollOutcome {
    fn state(&self) -> &'static str {
        match self {
            PollOutcome::Done { .. } => "done",
            PollOutcome::Expired(_) => "expired",
            PollOutcome::Failed(_) => "error",
            PollOutcome::Pending => "pending",
        }
    }

    fn detail(&self) -> Option<String> {
        match self {
            PollOutcome::Expired(detail) | PollOutcome::Failed(detail) => {
                let trimmed = detail.trim();
                // 空串交给界面出本地化文案，别把空提示丢上去。
                (!trimmed.is_empty()).then(|| trimmed.to_string())
            }
            _ => None,
        }
    }
}

/// 判定一次轮询响应。`status` 大小写不敏感（官方连接器先 `toUpperCase()`）。
fn classify_poll(response: &PollBody) -> PollOutcome {
    let status = response.status.as_deref().unwrap_or_default().trim();
    let client_id = response.client_id.as_deref().unwrap_or_default().trim();
    let client_secret = response.client_secret.as_deref().unwrap_or_default().trim();
    // 先看凭证：`SUCCESS` 与凭证同时到达，按凭证判定比按 status 更稳。
    if !client_id.is_empty() && !client_secret.is_empty() {
        return PollOutcome::Done {
            client_id: client_id.to_string(),
            client_secret: client_secret.to_string(),
        };
    }
    let reason = || {
        response
            .fail_reason
            .as_deref()
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    if status.eq_ignore_ascii_case("WAITING") {
        return PollOutcome::Pending;
    }
    if status.eq_ignore_ascii_case("EXPIRED") {
        return PollOutcome::Expired(reason());
    }
    if status.eq_ignore_ascii_case("FAIL") {
        return PollOutcome::Failed(reason());
    }
    // `SUCCESS` 却缺凭证、或没见过的状态：如实报错（界面有重试与手填两条退路）。
    PollOutcome::Failed(if status.is_empty() {
        "服务端未返回状态".into()
    } else {
        format!("未知状态: {status}")
    })
}

/// 发一个注册请求并把信封拆开（`errcode != 0` 转成带服务端说明的错误）。
/// `base` 是参数而非直接读常量：测试里指向本地 mock 服务端。
async fn post_registration<T>(
    client: &reqwest::Client,
    base: &str,
    path: &str,
    body: serde_json::Value,
    action: &str,
) -> Result<T, String>
where
    T: for<'de> Deserialize<'de>,
{
    let url = format!("{}{path}", base.trim_end_matches('/'));
    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .json(&body)
        .timeout(API_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("{action}请求失败: {error}"))?;
    let status = response.status();
    let text = crate::http::read_text(response, API_TIMEOUT).await?;
    let envelope: ApiEnvelope<T> = serde_json::from_str(&text).map_err(|error| {
        format!(
            "{action}响应解析失败: {error}（HTTP {status}: {}）",
            brief(&text)
        )
    })?;
    envelope.into_data(action)
}

/// 发起扫码：先取 nonce，再换回 `device_code`（留宿主）与二维码链接。
pub async fn begin_registration(
    client: &reqwest::Client,
    base: &str,
) -> Result<(RegisterSession, RegisterStartDto), String> {
    let init: InitBody = post_registration(
        client,
        base,
        REGISTRATION_INIT_PATH,
        serde_json::json!({ "source": REGISTRATION_SOURCE }),
        "发起扫码",
    )
    .await?;
    let nonce = init.nonce.as_deref().unwrap_or_default().trim().to_string();
    if nonce.is_empty() {
        return Err("扫码注册响应缺少 nonce".into());
    }

    let begin: BeginBody = post_registration(
        client,
        base,
        REGISTRATION_BEGIN_PATH,
        serde_json::json!({ "nonce": nonce }),
        "发起扫码",
    )
    .await?;
    let device_code = begin
        .device_code
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_string();
    let verification_uri_complete = begin
        .verification_uri_complete
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_string();
    if device_code.is_empty() || verification_uri_complete.is_empty() {
        return Err("扫码注册响应缺少 device_code / 扫码链接".into());
    }
    let expires_in = begin
        .expires_in
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_EXPIRE_IN);
    let interval = begin
        .interval
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_POLL_INTERVAL);
    let session = RegisterSession {
        device_code,
        expires_at: now_ms() + (expires_in as i64) * 1000,
    };
    let dto = RegisterStartDto {
        // 官方连接器把 `verification_uri_complete` 原样编成二维码（不追加参数）。
        qr_url: verification_uri_complete,
        user_code: begin
            .user_code
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        expires_in,
        interval,
    };
    Ok((session, dto))
}

/// 轮询一次（钉钉不支持服务端要求的放慢，间隔固定）。
pub async fn poll_registration(
    client: &reqwest::Client,
    base: &str,
    session: &RegisterSession,
) -> Result<PollOutcome, String> {
    let body: PollBody = post_registration(
        client,
        base,
        REGISTRATION_POLL_PATH,
        serde_json::json!({ "device_code": session.device_code }),
        "轮询扫码",
    )
    .await?;
    Ok(classify_poll(&body))
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
    /// 消息类型：text / picture / audio …（其余非文本由渲染端如实说明）。
    pub msg_type: Option<String>,
    pub conversation_type: Option<String>,
    /// 随消息到达的图片；字节在宿主 inbox，凭 `path` 取走。
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
    /// accessToken 缓存（含过期时间戳，秒）—— 换图片下载链接要用。
    access_token: Option<String>,
    token_expires_at: i64,
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

/// 凭证落盘（0600）：扫码路径与手填路径共用。
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
                log::warn("dingtalk", format!("联系人凭据落盘失败: {error}"));
            }
        }
        Err(error) => log::warn("dingtalk", format!("联系人凭据序列化失败: {error}")),
    }
}

/// 长连接的对外出口：事件广播 + 联系人凭据落盘 + 入站图片收件目录。
pub(crate) struct StreamDeps {
    sink: EventSink,
    persist: Arc<dyn Fn(&PeerBook) + Send + Sync>,
    /// 入站图片收件目录（连上时解析一次；不可用时入站图片整体丢弃并记日志）。
    inbox: Option<PathBuf>,
}

impl StreamDeps {
    fn for_app(app: &AppHandle) -> Self {
        let handle = app.clone();
        let inbox = inbox_dir(app, DIR_NAME)
            .inspect_err(|error| log::warn("dingtalk", format!("收件目录不可用: {error}")))
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

/// 取/复用企业内应用 accessToken：到期前 `TOKEN_REFRESH_MARGIN_SECS` 内重新取。
async fn ensure_access_token(
    client: &reqwest::Client,
    inner: &Mutex<Inner>,
) -> Result<String, String> {
    let (app_key, app_secret, cached, expires_at) = {
        let guard = inner.lock().await;
        let credentials = guard.credentials.clone().ok_or("尚未配置钉钉应用凭证")?;
        (
            credentials.client_id,
            credentials.client_secret,
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
        .post(ACCESS_TOKEN_URL)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "appKey": app_key, "appSecret": app_secret }))
        .timeout(API_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("取钉钉 accessToken 失败: {error}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("accessToken 响应读取失败: {error}"))?;
    if !status.is_success() {
        return Err(format!("取 accessToken 返回 {status}: {}", brief(&text)));
    }
    let parsed: AccessTokenResponse = serde_json::from_str(&text)
        .map_err(|error| format!("accessToken 响应解析失败: {error}"))?;
    let token = parsed
        .access_token
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            format!(
                "取 accessToken 被拒：{}",
                parsed
                    .message
                    .unwrap_or_else(|| "响应里没有 accessToken".into())
            )
        })?;
    let ttl = parsed.expire_in.filter(|value| *value > 0).unwrap_or(7200);
    let mut guard = inner.lock().await;
    guard.access_token = Some(token.clone());
    guard.token_expires_at = chrono::Utc::now().timestamp() + ttl;
    Ok(token)
}

/// 用 `downloadCode` 换临时链接，再把图片字节取回来。
async fn download_robot_image(
    client: &reqwest::Client,
    token: &str,
    download_code: &str,
    robot_code: &str,
) -> Result<Vec<u8>, String> {
    let response = client
        .post(FILE_DOWNLOAD_URL)
        .header("x-acs-dingtalk-access-token", token)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({
            "downloadCode": download_code,
            "robotCode": robot_code,
        }))
        .timeout(API_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("换下载链接请求失败: {error}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("换下载链接响应读取失败: {error}"))?;
    if !status.is_success() {
        return Err(format!("换下载链接返回 {status}: {}", brief(&text)));
    }
    let parsed: DownloadUrlResponse =
        serde_json::from_str(&text).map_err(|error| format!("换下载链接响应解析失败: {error}"))?;
    let url = parsed
        .download_url
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "换下载链接响应缺少 downloadUrl".to_string())?;

    let response = client
        .get(&url)
        .timeout(API_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("下载图片请求失败: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("下载图片返回 {status}"));
    }
    let bytes = tokio::time::timeout(crate::http::RESPONSE_READ_TIMEOUT, response.bytes())
        .await
        .map_err(|_| "下载图片读取超时".to_string())?
        .map_err(|error| format!("读取图片字节失败: {error}"))?;
    Ok(bytes.to_vec())
}

/// 把入站图片下载进 inbox（单张失败只记日志，不中断整轮）。
async fn materialize_inbound(
    deps: &StreamDeps,
    inner: &Mutex<Inner>,
    message: &ChatbotMessage,
    codes: Vec<String>,
) -> Vec<MediaRefDto> {
    if codes.is_empty() {
        return Vec::new();
    }
    let Some(inbox) = deps.inbox.as_deref() else {
        log::warn("dingtalk", "收件目录不可用，丢弃入站图片");
        return Vec::new();
    };
    let client = match crate::http::shared_client(10) {
        Ok(client) => client,
        Err(error) => {
            log::warn("dingtalk", format!("下载图片前建客户端失败: {error}"));
            return Vec::new();
        }
    };
    // robotCode 优先取消息自带的；自定义机器人没有它时回落应用 clientId（企业内应用同值）。
    let fallback_code = {
        let guard = inner.lock().await;
        guard
            .credentials
            .as_ref()
            .map(|credentials| credentials.client_id.clone())
    };
    let robot_code = message
        .robot_code
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or(fallback_code)
        .unwrap_or_default();
    let token = match ensure_access_token(&client, inner).await {
        Ok(token) => token,
        Err(error) => {
            log::warn(
                "dingtalk",
                format!("取 accessToken 失败，丢弃入站图片: {error}"),
            );
            return Vec::new();
        }
    };
    let received_at = now_ms();
    let mut refs = Vec::new();
    for (index, code) in codes.iter().enumerate() {
        match download_robot_image(&client, &token, code, &robot_code).await {
            Ok(bytes) => {
                if let Some(dto) = store_inbound_media(
                    inbox,
                    DIR_NAME,
                    received_at,
                    index,
                    MediaKind::Image,
                    "image",
                    bytes,
                ) {
                    refs.push(dto);
                }
            }
            Err(error) => log::warn("dingtalk", format!("入站图片下载失败: {error}")),
        }
    }
    refs
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
    // 图片下载进 inbox 后再广播（渲染端凭 path 取走）；文本消息这里为空。
    let media = materialize_inbound(deps, inner, &message, message.pending_images()).await;
    let payload = DingTalkInboundDto {
        msg_id: message.msg_id.clone(),
        peer_id,
        nick: message.display_nick(),
        text,
        msg_type: message.msgtype.clone(),
        conversation_type: message.conversation_type.clone(),
        media,
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
    store_credentials(&app, &credentials)?;
    inner.credentials = Some(credentials);
    // 换了凭证就作废 accessToken：旧票据属于上一个应用。
    inner.access_token = None;
    inner.token_expires_at = 0;
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
    inner.registration = None;
    inner.access_token = None;
    inner.token_expires_at = 0;
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
    prune_inbox(&app, DIR_NAME, true);
    Ok(inner.status())
}

/// 发起扫码创建应用：返回二维码链接与配对码（`device_code` 留在宿主内存）。
#[tauri::command]
pub async fn dingtalk_register_begin(
    host: State<'_, DingTalkHost>,
) -> Result<RegisterStartDto, String> {
    let client = crate::http::shared_client(10)?;
    let (session, dto) = begin_registration(&client, REGISTRATION_BASE_URL).await?;
    log::info("dingtalk", "已发起扫码创建应用");
    host.lock().await.registration = Some(session);
    Ok(dto)
}

/// 轮询扫码结果：成功时凭证直接落盘并写进宿主状态，渲染端只需刷新状态。
#[tauri::command]
pub async fn dingtalk_register_poll(
    app: AppHandle,
    host: State<'_, DingTalkHost>,
) -> Result<RegisterPollDto, String> {
    let session = {
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
            client_id: None,
        });
    }

    let client = crate::http::shared_client(10)?;
    // 传输层错误 / `errcode != 0` 直接抛给渲染端计次重试；协议层的 pending / 失败走返回的 DTO。
    let outcome = poll_registration(&client, REGISTRATION_BASE_URL, &session).await?;
    let mut inner = host.lock().await;
    let same_session = current_device_code(&inner).as_deref() == Some(session.device_code.as_str());
    if let PollOutcome::Done {
        client_id,
        client_secret,
    } = &outcome
    {
        let credentials = StoredCredentials {
            client_id: client_id.clone(),
            client_secret: client_secret.clone(),
            saved_at: Some(chrono::Utc::now().to_rfc3339()),
        };
        // 落盘失败就留着会话（服务端在有效期内还会给凭证），让用户能重试。
        store_credentials(&app, &credentials)?;
        inner.credentials = Some(credentials);
        inner.detail = None;
        if same_session {
            inner.registration = None;
        }
        log::info("dingtalk", "扫码创建应用成功，凭证已落盘");
        return Ok(RegisterPollDto {
            state: outcome.state().into(),
            detail: None,
            client_id: Some(client_id.clone()),
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
        client_id: None,
    })
}

/// 取消扫码创建（作废本次 device_code，不再轮询）。
#[tauri::command]
pub async fn dingtalk_register_cancel(host: State<'_, DingTalkHost>) -> Result<(), String> {
    host.lock().await.registration = None;
    Ok(())
}

fn current_device_code(inner: &Inner) -> Option<String> {
    inner
        .registration
        .as_ref()
        .map(|session| session.device_code.clone())
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
    // 上次会话遗留的未取走收件图片先清掉（渲染端崩溃 / 未取走）。
    prune_inbox(&app, DIR_NAME, false);
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
    use serde_json::json;

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
            inbox: None,
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

    /* ===== 扫码创建应用：纯函数判定 ===== */

    #[test]
    fn classify_poll_covers_every_server_status() {
        let classify =
            |raw: &str| classify_poll(&serde_json::from_str::<PollBody>(raw).expect("轮询响应体"));
        // 等待中：信封里的 errcode 已在 post_registration 剥掉，status 才说明进展。
        assert_eq!(classify(r#"{"status":"WAITING"}"#), PollOutcome::Pending);
        // 官方连接器先 toUpperCase()，这里大小写不敏感。
        assert_eq!(classify(r#"{"status":"waiting"}"#), PollOutcome::Pending);
        assert_eq!(
            classify(r#"{"status":"SUCCESS","client_id":"a","client_secret":"b"}"#),
            PollOutcome::Done {
                client_id: "a".into(),
                client_secret: "b".into(),
            }
        );
        assert_eq!(
            classify(r#"{"status":"FAIL","fail_reason":"用户拒绝"}"#),
            PollOutcome::Failed("用户拒绝".into())
        );
        assert_eq!(
            classify(r#"{"status":"EXPIRED"}"#),
            PollOutcome::Expired(String::new())
        );
        // 凭证比 status 可信：SUCCESS 与凭证同时到达时按凭证判定。
        assert_eq!(
            classify(r#"{"status":"SUCCESS","client_id":"a","client_secret":"b"}"#),
            PollOutcome::Done {
                client_id: "a".into(),
                client_secret: "b".into(),
            }
        );
        // 缺凭证的 SUCCESS / 没见过的状态：如实报错，别当等待（否则会一直轮询到过期）。
        assert!(matches!(
            classify(r#"{"status":"SUCCESS"}"#),
            PollOutcome::Failed(_)
        ));
        assert!(matches!(
            classify(r#"{"status":"CREATING"}"#),
            PollOutcome::Failed(_)
        ));
        assert!(matches!(classify(r#"{}"#), PollOutcome::Failed(_)));
    }

    #[test]
    fn poll_outcome_state_and_detail_are_screen_ready() {
        assert_eq!(PollOutcome::Pending.state(), "pending");
        assert_eq!(
            PollOutcome::Done {
                client_id: "a".into(),
                client_secret: "b".into()
            }
            .state(),
            "done"
        );
        assert_eq!(PollOutcome::Expired("x".into()).state(), "expired");
        assert_eq!(PollOutcome::Failed("x".into()).state(), "error");
        // 空描述交给界面出本地化文案，别把空提示丢上去。
        assert_eq!(PollOutcome::Failed(String::new()).detail(), None);
        assert_eq!(PollOutcome::Expired("  ".into()).detail(), None);
        assert_eq!(PollOutcome::Pending.detail(), None);
        assert_eq!(
            PollOutcome::Failed("服务端忙".into()).detail().as_deref(),
            Some("服务端忙")
        );
    }

    /* ===== 扫码创建应用：对本地 mock HTTP 服务器跑完整一轮 ===== */

    /// 服务端真实形状：`init` 回 nonce，`begin` 回 device_code + 二维码链接。
    const INIT_BODY: &str = r#"{"errcode":0,"errmsg":"ok","nonce":"n-123"}"#;
    const BEGIN_BODY: &str = r#"{"errcode":0,"errmsg":"ok","device_code":"dc-abc","user_code":"AB12-CD34","verification_uri_complete":"https://oapi.dingtalk.com/app/registration/verify?code=AB12-CD34","expires_in":7200,"interval":3}"#;

    /// 按脚本逐条应答的极简 HTTP 服务端（每连接一条请求，`Connection: close`），
    /// 请求原文记录下来供断言 JSON 字段。
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

    fn session_for(device_code: &str) -> RegisterSession {
        RegisterSession {
            device_code: device_code.to_string(),
            expires_at: now_ms() + 60_000,
        }
    }

    #[tokio::test]
    async fn begin_registration_sends_source_then_nonce_and_keeps_qr_link_verbatim() {
        let (base, recorded) =
            spawn_registration_mock(vec![(200, INIT_BODY), (200, BEGIN_BODY)]).await;
        let client = crate::http::shared_client(5).expect("client");
        let (session, dto) = begin_registration(&client, &base).await.expect("begin");

        assert_eq!(dto.user_code.as_deref(), Some("AB12-CD34"));
        assert_eq!(dto.expires_in, 7200, "服务端给了 expires_in，不该落兜底值");
        assert_eq!(dto.interval, 3);
        // 与飞书不同：官方连接器把 verification_uri_complete 原样编成二维码，不追加参数。
        assert_eq!(
            dto.qr_url,
            "https://oapi.dingtalk.com/app/registration/verify?code=AB12-CD34"
        );
        assert_eq!(session.device_code, "dc-abc");
        assert!(
            session.expires_at > now_ms() + 7_000_000,
            "有效期应按 expires_in 推算"
        );

        let sent = recorded.lock().join("\n");
        assert!(
            sent.contains("/app/registration/init"),
            "缺 init 请求: {sent}"
        );
        assert!(
            sent.contains("/app/registration/begin"),
            "缺 begin 请求: {sent}"
        );
        assert!(sent.contains("DING_DWS_CLAW"), "init 缺 source: {sent}");
        assert!(
            sent.contains("n-123"),
            "begin 未回填 init 拿到的 nonce: {sent}"
        );
    }

    #[tokio::test]
    async fn begin_registration_falls_back_when_server_omits_expiry() {
        // 服务端没给 expires_in / interval 时用兜底值（官方连接器同值）。
        let (base, _recorded) = spawn_registration_mock(vec![
            (200, INIT_BODY),
            (
                200,
                r#"{"errcode":0,"device_code":"dc-abc","verification_uri_complete":"https://x.test/qr"}"#,
            ),
        ])
        .await;
        let client = crate::http::shared_client(5).expect("client");
        let (session, dto) = begin_registration(&client, &base).await.expect("begin");

        assert_eq!(dto.expires_in, DEFAULT_EXPIRE_IN);
        assert_eq!(dto.interval, DEFAULT_POLL_INTERVAL);
        assert_eq!(dto.user_code, None, "钉钉不保证下发配对码");
        assert!(
            session.expires_at > now_ms() + 7_000_000,
            "兜底的 7200s 有效期也要推算进会话"
        );
    }

    #[tokio::test]
    async fn begin_registration_rejects_response_without_nonce() {
        let (base, _recorded) =
            spawn_registration_mock(vec![(200, r#"{"errcode":0,"errmsg":"ok"}"#)]).await;
        let client = crate::http::shared_client(5).expect("client");
        let error = begin_registration(&client, &base)
            .await
            .expect_err("缺 nonce 应当报错");
        assert!(error.contains("nonce"), "{error}");
    }

    #[tokio::test]
    async fn poll_registration_returns_credentials_when_confirmed() {
        let (base, recorded) = spawn_registration_mock(vec![(
            200,
            r#"{"errcode":0,"errmsg":"ok","status":"SUCCESS","client_id":"ding-abc","client_secret":"secret-xyz"}"#,
        )])
        .await;
        let client = crate::http::shared_client(5).expect("client");
        let outcome = poll_registration(&client, &base, &session_for("dc-abc"))
            .await
            .expect("poll");

        assert_eq!(
            outcome,
            PollOutcome::Done {
                client_id: "ding-abc".into(),
                client_secret: "secret-xyz".into(),
            }
        );
        assert_eq!(outcome.state(), "done");
        let sent = recorded.lock().join("\n");
        assert!(
            sent.contains("dc-abc"),
            "轮询要把 device_code 带回去: {sent}"
        );
    }

    #[tokio::test]
    async fn poll_registration_surfaces_nonzero_errcode_as_error() {
        // 与飞书相反：等待中是 errcode:0 + status:WAITING，非零 errcode 才是真失败。
        let (base, _recorded) = spawn_registration_mock(vec![(
            200,
            r#"{"errcode":40078,"errmsg":"device_code 已过期"}"#,
        )])
        .await;
        let client = crate::http::shared_client(5).expect("client");
        let error = poll_registration(&client, &base, &session_for("dc-abc"))
            .await
            .expect_err("errcode 非零应当报错");

        assert!(error.contains("40078"), "{error}");
        assert!(error.contains("device_code 已过期"), "{error}");
    }

    #[tokio::test]
    async fn registration_rejects_non_json_body() {
        // 网关 5xx 页面之类：报错要带上响应片段，便于定位。
        let (base, _recorded) =
            spawn_registration_mock(vec![(502, "<html>bad gateway</html>")]).await;
        let client = crate::http::shared_client(5).expect("client");
        let error = begin_registration(&client, &base)
            .await
            .expect_err("非 JSON 响应应当报错");
        assert!(error.contains("bad gateway"), "{error}");
    }

    /* ===== 入站图片：下载码提取 ===== */

    #[test]
    fn pending_images_reads_picture_and_richtext() {
        let picture: ChatbotMessage = serde_json::from_value(json!({
            "msgtype": "picture",
            "downloadCode": "DC-1",
        }))
        .expect("图片消息");
        assert_eq!(picture.pending_images(), vec!["DC-1".to_string()]);

        // 富文本：content.richText 形状，混着文本项与图片项。
        let rich: ChatbotMessage = serde_json::from_value(json!({
            "msgtype": "richText",
            "content": { "richText": [
                { "text": "看这两张" },
                { "downloadCode": "DC-2" },
                { "picture": { "downloadCode": "DC-3" } },
            ] },
        }))
        .expect("富文本消息");
        assert_eq!(
            rich.pending_images(),
            vec!["DC-2".to_string(), "DC-3".to_string()]
        );

        // 顶层 richText 形状也认。
        let top: ChatbotMessage = serde_json::from_value(json!({
            "msgtype": "richText",
            "richText": [ { "downloadCode": "DC-4" } ],
        }))
        .expect("富文本消息");
        assert_eq!(top.pending_images(), vec!["DC-4".to_string()]);

        // 文本消息 / 语音 / 空下载码都不产出图片。
        let text: ChatbotMessage = serde_json::from_value(json!({
            "msgtype": "text",
            "text": { "content": "你好" },
        }))
        .expect("文本消息");
        assert!(text.pending_images().is_empty());
        let audio: ChatbotMessage = serde_json::from_value(json!({
            "msgtype": "audio",
            "downloadCode": "DC-AUDIO",
        }))
        .expect("语音消息");
        assert!(audio.pending_images().is_empty(), "本版只收图片");
        let blank: ChatbotMessage = serde_json::from_value(json!({
            "msgtype": "picture",
            "downloadCode": "   ",
        }))
        .expect("空下载码");
        assert!(blank.pending_images().is_empty());
    }

    #[test]
    fn pending_images_caps_at_max() {
        let items: Vec<serde_json::Value> = (0..(MAX_INBOUND_MEDIA + 3))
            .map(|index| json!({ "downloadCode": format!("DC-{index}") }))
            .collect();
        let message: ChatbotMessage =
            serde_json::from_value(json!({ "msgtype": "richText", "richText": items }))
                .expect("富文本消息");
        assert_eq!(message.pending_images().len(), MAX_INBOUND_MEDIA);
    }
}
