use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::SinkExt;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message;

use crate::channel_common::{now_ms, sleep_or_stop};
use crate::channel_media::{store_inbound_media, MediaKind, MediaRefDto};
use crate::host::HostContext;
use crate::log;

use super::protocol::*;
use super::*;

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
pub(super) const DEFAULT_EXPIRE_IN: u64 = 7200;
pub(super) const DEFAULT_POLL_INTERVAL: u64 = 3;

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
pub(super) struct PollBody {
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
    pub(super) device_code: String,
    /// 过期时刻（毫秒时间戳），由 `expires_in` 推出。
    pub(super) expires_at: i64,
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
    pub(super) fn state(&self) -> &'static str {
        match self {
            PollOutcome::Done { .. } => "done",
            PollOutcome::Expired(_) => "expired",
            PollOutcome::Failed(_) => "error",
            PollOutcome::Pending => "pending",
        }
    }

    pub(super) fn detail(&self) -> Option<String> {
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
pub(super) fn classify_poll(response: &PollBody) -> PollOutcome {
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
pub(super) async fn post_registration<T>(
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

/// 把入站媒体下载进 inbox（单条失败只记日志，不中断整轮）。
async fn materialize_inbound(
    deps: &StreamDeps,
    inner: &Mutex<Inner>,
    message: &ChatbotMessage,
    media: Vec<(MediaKind, String)>,
) -> Vec<MediaRefDto> {
    if media.is_empty() {
        return Vec::new();
    }
    let Some(inbox) = deps.inbox.as_deref() else {
        log::warn("dingtalk", "收件目录不可用，丢弃入站媒体");
        return Vec::new();
    };
    let client = match crate::http::shared_client(10) {
        Ok(client) => client,
        Err(error) => {
            log::warn("dingtalk", format!("下载媒体前建客户端失败: {error}"));
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
                format!("取 accessToken 失败，丢弃入站媒体: {error}"),
            );
            return Vec::new();
        }
    };
    let received_at = now_ms();
    let mut refs = Vec::new();
    for (index, (kind, code)) in media.iter().enumerate() {
        match download_robot_image(&client, &token, code, &robot_code).await {
            Ok(bytes) => {
                if let Some(dto) = store_inbound_media(
                    inbox,
                    DIR_NAME,
                    received_at,
                    index,
                    *kind,
                    kind.as_str(),
                    bytes,
                ) {
                    refs.push(dto);
                }
            }
            Err(error) => log::warn("dingtalk", format!("入站媒体下载失败: {error}")),
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
    let media = materialize_inbound(deps, inner, &message, message.pending_media()).await;
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

/* ===== 宿主层：长连接主循环（带重连退避） ===== */

pub(super) struct StreamCredentials {
    pub(super) client_id: String,
    pub(super) client_secret: String,
}

pub(super) async fn run_stream(
    host_ctx: &Arc<dyn HostContext>,
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
    let _ = &host_ctx;
}

/// 指数退避（1s → 60s 上限）。
pub(super) fn reconnect_delay(attempt: u32) -> Duration {
    let seconds = 1u64 << attempt.min(6);
    Duration::from_secs(seconds.min(RECONNECT_MAX_DELAY.as_secs()))
}
