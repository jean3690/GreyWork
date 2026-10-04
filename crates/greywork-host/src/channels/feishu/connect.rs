use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::SinkExt;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message;

use crate::channel_common::{now_ms, sleep_or_stop};
use crate::channel_media::{store_inbound_media, MediaRefDto, MAX_MEDIA_BYTES};
use crate::log;

use super::protocol::*;
use super::*;

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
pub(super) async fn send_message(
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
pub(super) fn check_code(body: &str, action: &str) -> Result<serde_json::Value, String> {
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
pub(super) async fn upload_image(
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
pub(super) async fn upload_file(
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
pub(super) struct PollResponse {
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
    pub(super) device_code: String,
    pub(super) domain: String,
    pub(super) interval: Duration,
    /// 过期时刻（毫秒时间戳），由 `expires_in` 推出。
    pub(super) expires_at: i64,
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
    pub(super) fn state(&self) -> &'static str {
        match self {
            PollOutcome::Done { .. } => "done",
            PollOutcome::Denied(_) => "denied",
            PollOutcome::Expired(_) => "expired",
            PollOutcome::Failed(_) => "error",
            PollOutcome::Pending | PollOutcome::SlowDown | PollOutcome::SwitchDomain => "pending",
        }
    }

    pub(super) fn detail(&self) -> Option<String> {
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
pub(super) fn classify_poll(response: &PollResponse) -> PollOutcome {
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
pub(super) fn qr_url(verification_uri_complete: &str) -> Result<String, String> {
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
pub(super) fn form_body(pairs: &[(&str, &str)]) -> String {
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

/* ===== 宿主层：长连接 ===== */

/// 分片重组：`sum > 1` 的消息按 `message_id` 拼回（官方 SDK 用 5s TTL 的缓存）。
/// 分片缓存条目：(写入时刻, 按 seq 排好的分片)。
type FragmentEntry = (i64, Vec<Option<Vec<u8>>>);

#[derive(Default)]
pub(super) struct Fragments {
    entries: BTreeMap<String, FragmentEntry>,
}

impl Fragments {
    pub(super) fn push(
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

/* ===== 宿主层：长连接主循环（带重连退避） ===== */

pub(super) struct StreamCredentials {
    pub(super) app_id: String,
    pub(super) app_secret: String,
}

pub(super) async fn run_stream(
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

pub(super) fn reconnect_delay(attempt: u32) -> Duration {
    let seconds = 1u64 << attempt.min(6);
    Duration::from_secs(seconds.min(RECONNECT_MAX_DELAY.as_secs()))
}
