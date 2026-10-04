use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message;

use crate::channel_common::{now_ms, sleep_or_stop};
use crate::channel_media::{store_inbound_media, OutboundMedia, MAX_MEDIA_BYTES};
use crate::http::{read_text, shared_client, RESPONSE_READ_TIMEOUT};
use crate::log;

use super::protocol::*;
use super::*;

/* ===== 扫码创建机器人（q.qq.com 绑定流程） =====
 *
 * 与「去 q.qq.com 手工建机器人再抄 AppID / AppSecret」并列的另一条入口：手机 QQ 扫码 →
 * 确认 → 服务端把 AppID 与**加密的** AppSecret 交给宿主，宿主本地解密后落盘（0600）。
 *
 * 协议（与 AstrBot `qqofficial/login_registration.py` 同形，全程 JSON）：
 * 1. `POST https://q.qq.com/lite/create_bind_task` `{"key": <base64 AES-256 密钥>}`
 *    → `{data:{task_id}}`；密钥本地生成、只留宿主内存，用来解 AppSecret
 * 2. `https://q.qq.com/qqbot/openclaw/connect.html?task_id=<id>&_wv=2` 编成二维码 → 手机扫码确认
 * 3. 每 `interval` 秒 `POST /lite/poll_bind_result` `{"task_id": <id>}`
 *    → `{data:{status, bot_appid?, bot_encrypt_secret?}}`：
 *    `status` 1=等待 / 2=完成（带 appid + 密文 secret）/ 3=过期
 *
 * AppSecret 密文是 base64(12B nonce ‖ 密文 ‖ 16B GCM tag)，用第 1 步的密钥做 AES-256-GCM 解密。
 *
 * 这几个接口没有公开文档，是腾讯给自家客户端（WorkBuddy / OpenClaw 等）留的内部通道；
 * 协议若变更，这里会以 `retcode != 0`、状态缺失或解密失败的形式**显式报错**（不静默失败），
 * 界面退回「去 q.qq.com 手填 AppID / AppSecret」即可。
 */

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;

/// 绑定接口域名（q.qq.com）。
pub(super) const BIND_HOST: &str = "https://q.qq.com";
const CREATE_BIND_PATH: &str = "/lite/create_bind_task";
const POLL_BIND_PATH: &str = "/lite/poll_bind_result";
/// 服务端不下发轮询间隔，固定按 2s 轮询（AstrBot 同值）。
const BIND_POLL_INTERVAL: u64 = 2;
/// 本地兜底有效期：服务端用 status=3 表达过期，这里只在它久不回话时收口，防止无限轮询。
const BIND_EXPIRE_IN: u64 = 300;
/// 绑定接口请求超时（qq.rs 无全局 API_TIMEOUT，就近定义）。
const BIND_TIMEOUT: Duration = Duration::from_secs(15);

/// 绑定状态码（AstrBot：0=无 / 1=等待 / 2=完成 / 3=过期）。
const BIND_STATUS_COMPLETED: i64 = 2;
const BIND_STATUS_EXPIRED: i64 = 3;

/// 绑定接口统一信封：`retcode` 缺省或为 0 即成功（AstrBot 同判）。
#[derive(Debug, Clone, Default, Deserialize)]
pub(super) struct BindEnvelope {
    #[serde(default)]
    retcode: Option<i64>,
    #[serde(default)]
    msg: Option<String>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    data: Option<serde_json::Value>,
}

impl BindEnvelope {
    /// 拆信封：`retcode` 非 0 转成带服务端说明的错误，成功返回 `data`（可能为空对象）。
    pub(super) fn into_data(self, action: &str) -> Result<serde_json::Value, String> {
        if let Some(code) = self.retcode {
            if code != 0 {
                let detail = self
                    .msg
                    .or(self.message)
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                return Err(if detail.is_empty() {
                    format!("{action}失败（retcode={code}）")
                } else {
                    format!("{action}失败：{detail}（retcode={code}）")
                });
            }
        }
        Ok(self.data.unwrap_or(serde_json::Value::Null))
    }
}

/// 轮询响应里 `data` 内层字段。
#[derive(Debug, Clone, Default, Deserialize)]
struct PollData {
    #[serde(default)]
    status: Option<i64>,
    #[serde(default)]
    bot_appid: Option<serde_json::Value>,
    #[serde(default)]
    bot_encrypt_secret: Option<String>,
}

/// 一次轮询的判定（纯函数产出，便于单测）。
#[derive(Debug, Clone, PartialEq)]
pub enum PollOutcome {
    /// status=0/1：还没扫码 / 还没在手机上确认。
    Pending,
    Done {
        app_id: String,
        app_secret: String,
    },
    /// status=3：本次绑定任务已过期。
    Expired,
    /// 完成却缺字段、解密失败，或没见过的状态 —— 如实报错，免得一直轮询到超时。
    Failed(String),
}

impl PollOutcome {
    pub(super) fn state(&self) -> &'static str {
        match self {
            PollOutcome::Done { .. } => "done",
            PollOutcome::Expired => "expired",
            PollOutcome::Failed(_) => "error",
            PollOutcome::Pending => "pending",
        }
    }

    pub(super) fn detail(&self) -> Option<String> {
        match self {
            PollOutcome::Failed(detail) => {
                let trimmed = detail.trim();
                (!trimmed.is_empty()).then(|| trimmed.to_string())
            }
            _ => None,
        }
    }
}

/// 生成一把 base64 编码的 AES-256 绑定密钥（32 字节随机）。
fn generate_bind_key() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| format!("随机数生成失败: {error}"))?;
    Ok(BASE64.encode(bytes))
}

/// 解密服务端下发的 AppSecret 密文：base64(12B nonce ‖ 密文 ‖ 16B GCM tag)。
pub fn decrypt_secret(encrypted: &str, bind_key: &str) -> Result<String, String> {
    let key_bytes = BASE64
        .decode(bind_key.trim())
        .map_err(|_| "绑定密钥 base64 解码失败".to_string())?;
    let raw = BASE64
        .decode(encrypted.trim())
        .map_err(|_| "AppSecret 密文 base64 解码失败".to_string())?;
    // 12B nonce + 至少 1B 密文 + 16B tag，少于这个长度就是密文格式不对。
    if key_bytes.len() != 32 || raw.len() <= 28 {
        return Err("AppSecret 密文格式异常".into());
    }
    let nonce = &raw[..12];
    let ciphertext_and_tag = &raw[12..];
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
    let plaintext = cipher
        .decrypt(Nonce::from_slice(nonce), ciphertext_and_tag)
        .map_err(|_| "AppSecret 解密失败".to_string())?;
    String::from_utf8(plaintext).map_err(|_| "AppSecret 不是有效的 UTF-8".to_string())
}

/// 值归一成字符串（服务端 appid 可能给数字或字符串）。
fn stringify(value: Option<&serde_json::Value>) -> String {
    match value {
        Some(serde_json::Value::String(text)) => text.trim().to_string(),
        Some(serde_json::Value::Number(number)) => number.to_string(),
        _ => String::new(),
    }
}

/// 判定一次轮询响应（纯函数）。顺序：先看完成（带凭证），再看过期，其余按等待。
pub(super) fn classify_poll(data: &serde_json::Value, bind_key: &str) -> PollOutcome {
    let parsed: PollData = serde_json::from_value(data.clone()).unwrap_or_default();
    let status = parsed.status.unwrap_or(0);
    if status == BIND_STATUS_COMPLETED {
        let app_id = stringify(parsed.bot_appid.as_ref());
        let encrypted = parsed
            .bot_encrypt_secret
            .as_deref()
            .unwrap_or_default()
            .trim();
        if app_id.is_empty() || encrypted.is_empty() {
            return PollOutcome::Failed("扫码成功但未返回完整 QQ 机器人凭证".into());
        }
        return match decrypt_secret(encrypted, bind_key) {
            Ok(app_secret) => PollOutcome::Done { app_id, app_secret },
            Err(error) => PollOutcome::Failed(error),
        };
    }
    if status == BIND_STATUS_EXPIRED {
        return PollOutcome::Expired;
    }
    PollOutcome::Pending
}

/// 二维码内容：绑定确认页（手机 QQ 扫它）。
pub(super) fn connect_url(task_id: &str) -> String {
    format!(
        "{BIND_HOST}/qqbot/openclaw/connect.html?task_id={}&_wv=2",
        form_urlencoded::byte_serialize(task_id.as_bytes()).collect::<String>()
    )
}

/// 进行中的扫码会话（`bind_key` 只在宿主内存，绝不下发到界面）。
#[derive(Debug, Clone)]
pub struct RegisterSession {
    pub(super) task_id: String,
    pub(super) bind_key: String,
    /// 过期时刻（毫秒时间戳），本地兜底用。
    pub(super) expires_at: i64,
}

/// 扫码引导信息（渲染端只需要把 `qr_url` 编成二维码，按 `interval` 轮询）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterStartDto {
    pub qr_url: String,
    pub expires_in: u64,
    pub interval: u64,
}

/// 一次轮询的结果。`state`：pending / done / expired / error。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterPollDto {
    pub state: String,
    pub detail: Option<String>,
    /// 成功时的 AppID（AppSecret 已由宿主落盘，不下发到界面）。
    pub app_id: Option<String>,
}

/// 发一个绑定请求并拆信封。`base` 是参数而非常量：测试里指向本地 mock 服务端。
async fn post_bind(
    client: &reqwest::Client,
    base: &str,
    path: &str,
    body: serde_json::Value,
    action: &str,
) -> Result<serde_json::Value, String> {
    let url = format!("{}{path}", base.trim_end_matches('/'));
    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .json(&body)
        .timeout(BIND_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("{action}请求失败: {error}"))?;
    let status = response.status();
    let text = read_text(response, BIND_TIMEOUT).await?;
    let envelope: BindEnvelope = serde_json::from_str(&text).map_err(|error| {
        format!(
            "{action}响应解析失败: {error}（HTTP {status}: {}）",
            brief(&text)
        )
    })?;
    envelope.into_data(action)
}

/// 发起扫码：本地生成密钥 → 换回 `task_id`（留宿主）与二维码链接。
pub async fn begin_registration(
    client: &reqwest::Client,
    base: &str,
) -> Result<(RegisterSession, RegisterStartDto), String> {
    let bind_key = generate_bind_key()?;
    let data = post_bind(
        client,
        base,
        CREATE_BIND_PATH,
        serde_json::json!({ "key": bind_key }),
        "发起扫码",
    )
    .await?;
    let task_id = stringify(data.get("task_id"));
    if task_id.is_empty() {
        return Err("扫码绑定响应缺少 task_id".into());
    }
    let session = RegisterSession {
        task_id: task_id.clone(),
        bind_key,
        expires_at: now_ms() + (BIND_EXPIRE_IN as i64) * 1000,
    };
    let dto = RegisterStartDto {
        qr_url: connect_url(&task_id),
        expires_in: BIND_EXPIRE_IN,
        interval: BIND_POLL_INTERVAL,
    };
    Ok((session, dto))
}

/// 轮询一次（间隔固定，QQ 无「服务端要求放慢」那套）。
pub async fn poll_registration(
    client: &reqwest::Client,
    base: &str,
    session: &RegisterSession,
) -> Result<PollOutcome, String> {
    let data = post_bind(
        client,
        base,
        POLL_BIND_PATH,
        serde_json::json!({ "task_id": session.task_id }),
        "轮询扫码",
    )
    .await?;
    Ok(classify_poll(&data, &session.bind_key))
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

/// POST 一个 JSON 请求并做「HTTP 状态 + 业务 code」双重检查，返回解析后的响应体。
///
/// QQ 的业务错误也走 200 + `code`：只判 HTTP 状态会把「消息被拒」当成成功。
pub(super) async fn post_api(
    client: &reqwest::Client,
    token: &str,
    url: &str,
    body: &serde_json::Value,
    action: &str,
) -> Result<serde_json::Value, String> {
    let response = client
        .post(url)
        .header("Authorization", auth_header(token))
        .json(body)
        .send()
        .await
        .map_err(|error| format!("{action}请求失败: {error}"))?;
    let status = response.status();
    let text = read_text(response, RESPONSE_READ_TIMEOUT)
        .await
        .map_err(|error| format!("{action}响应读取失败: {error}"))?;
    if !status.is_success() {
        return Err(format!("{action}返回 {status}: {}", brief(&text)));
    }
    let parsed: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    if let Some(code) = parsed.get("code").and_then(serde_json::Value::as_i64) {
        if code != 0 {
            let message = parsed
                .get("message")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("unknown error");
            return Err(format!("QQ 拒绝了{action}（{code}）：{message}"));
        }
    }
    Ok(parsed)
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
    let (scope, openid) =
        decode_peer(peer_id).ok_or_else(|| format!("对端 id 无法解析: {peer_id:?}"))?;
    post_api(
        client,
        token,
        &messages_url(&scope, &openid),
        &reply_payload(text, msg_id, msg_seq),
        "发送消息",
    )
    .await
    .map(|_| ())
}

/// 把一条本地媒体传到 QQ 并换回 `file_info`（富媒体消息必填）。
///
/// 本地字节没有可给的 `url`，所以走官方的**分片上传**四步：
/// 1. `upload_prepare`（带整文件 md5/sha1/前 10MB md5）→ `upload_id` + 预签名分片
/// 2. 每片 `PUT` 到 `presigned_url`
/// 3. 每片 `upload_part_finish`（回 upload_id + 片序号 + 片大小 + 片 md5）
/// 4. `files` 带 `upload_id` 合并 → `file_info`
pub(super) async fn upload_rich_media(
    client: &reqwest::Client,
    token: &str,
    scope: &ChatScope,
    openid: &str,
    media: &OutboundMedia,
) -> Result<String, String> {
    if media.bytes.is_empty() {
        return Err("不能发送空文件".into());
    }
    let base = base_url(scope, openid);
    let file_type = qq_file_type(media);
    let file_size = media.bytes.len();
    let head_len = file_size.min(MD5_10M_LEN);
    let prepare_body = serde_json::json!({
        "file_type": file_type,
        "file_name": media.name,
        "file_size": file_size.to_string(),
        "md5": md5_hex(&media.bytes),
        "sha1": sha1_hex(&media.bytes),
        "md5_10m": md5_hex(&media.bytes[..head_len]),
    });
    let prepared: UploadPrepareResponse = serde_json::from_value(
        post_api(
            client,
            token,
            &format!("{base}/upload_prepare"),
            &prepare_body,
            "申请上传",
        )
        .await?,
    )
    .map_err(|error| format!("申请上传响应解析失败: {error}"))?;
    let upload_id = prepared.upload_id.trim().to_string();
    if upload_id.is_empty() {
        return Err("申请上传响应缺少 upload_id".into());
    }
    let mut parts = prepared.parts;
    if parts.is_empty() {
        return Err("申请上传响应没有分片信息".into());
    }
    parts.sort_by_key(|part| part.index);

    let mut offset = 0usize;
    for part in &parts {
        // 按服务端下发的片大小切；最后一片可能更小，用 min 收口。
        let end = (offset + size_of(&part.block_size).unwrap_or(0) as usize).min(file_size);
        if end <= offset {
            return Err(format!("分片 {} 大小异常", part.index));
        }
        let chunk = media.bytes[offset..end].to_vec();
        let chunk_md5 = md5_hex(&chunk);
        put_part(client, &part.presigned_url, chunk).await?;
        let finish_body = serde_json::json!({
            "upload_id": upload_id,
            "part_index": part.index,
            "block_size": (end - offset).to_string(),
            "md5": chunk_md5,
        });
        post_api(
            client,
            token,
            &format!("{base}/upload_part_finish"),
            &finish_body,
            "完成分片",
        )
        .await?;
        offset = end;
    }
    if offset != file_size {
        return Err("分片上传未覆盖整个文件".into());
    }

    let merged = post_api(
        client,
        token,
        &format!("{base}/files"),
        &serde_json::json!({
            "file_type": file_type,
            "file_name": media.name,
            "upload_id": upload_id,
            "srv_send_msg": false,
        }),
        "合并文件",
    )
    .await?;
    merged
        .get("file_info")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "合并文件响应缺少 file_info".to_string())
}

/// 把一个分片的字节 PUT 到预签名地址（对象存储直传，不带鉴权头）。
async fn put_part(client: &reqwest::Client, url: &str, chunk: Vec<u8>) -> Result<(), String> {
    if url.trim().is_empty() {
        return Err("分片预签名地址为空".into());
    }
    let response = client
        .put(url)
        .body(chunk)
        .send()
        .await
        .map_err(|error| format!("上传分片请求失败: {error}"))?;
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    let body = read_text(response, RESPONSE_READ_TIMEOUT)
        .await
        .unwrap_or_default();
    Err(format!("上传分片返回 {status}: {}", brief(&body)))
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
    let Some(draft) = normalize_dispatch(event, data, now_ms()) else {
        return;
    };
    let (peers, allowed) = {
        let mut guard = inner.lock().await;
        guard.peers.claim_owner(&draft.sender_id);
        guard
            .peers
            .remember(&draft.peer_id, &draft.message_id, draft.at);
        if guard
            .last_message_at
            .map(|last| draft.at > last)
            .unwrap_or(true)
        {
            guard.last_message_at = Some(draft.at);
        }
        let allowed = guard
            .peers
            .allows(&draft.sender_id, deps.allow_other_senders);
        emit_state(&guard, deps);
        (guard.peers.clone(), allowed)
    };
    (deps.persist)(&peers);
    if !allowed {
        log::info(
            "qq",
            format!(
                "忽略非授权发送者 {}（可在设置中允许其他联系人）",
                draft.sender_id
            ),
        );
        return;
    }
    // 附件字节下载进 inbox 后再广播（渲染端凭 path 取走）。
    let message = materialize_inbound(deps, draft).await;
    deps.emit(
        INBOUND_EVENT,
        serde_json::to_value(message).unwrap_or(serde_json::Value::Null),
    );
}

/// 下载一条入站附件（QQ 给的是 CDN 直链），读入后卡 20MB 上限。
async fn download_attachment(
    client: &reqwest::Client,
    pending: &PendingAttachment,
) -> Result<Vec<u8>, String> {
    if pending
        .declared_size
        .is_some_and(|size| size > MAX_MEDIA_BYTES)
    {
        return Err(format!(
            "附件超过 {} MB 上限",
            MAX_MEDIA_BYTES / (1024 * 1024)
        ));
    }
    let response = client
        .get(&pending.url)
        .send()
        .await
        .map_err(|error| format!("下载附件请求失败: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("下载附件返回 {status}"));
    }
    let bytes = tokio::time::timeout(RESPONSE_READ_TIMEOUT, response.bytes())
        .await
        .map_err(|_| "下载附件读取超时".to_string())?
        .map_err(|error| format!("读取附件字节失败: {error}"))?;
    if bytes.len() as u64 > MAX_MEDIA_BYTES {
        return Err(format!(
            "附件超过 {} MB 上限",
            MAX_MEDIA_BYTES / (1024 * 1024)
        ));
    }
    Ok(bytes.to_vec())
}

/// 把入站草稿的附件下载进 inbox（单条失败只记日志，不中断整轮）。
async fn materialize_inbound(deps: &GatewayDeps, draft: QqInboundDraft) -> QqInboundDto {
    let QqInboundDraft {
        message_id,
        peer_id,
        nick,
        sender_id,
        text,
        at,
        media,
    } = draft;
    let mut refs = Vec::new();
    if !media.is_empty() {
        match deps.inbox.as_deref() {
            None => log::warn("qq", "收件目录不可用，丢弃入站附件"),
            Some(inbox) => match shared_client(10) {
                Err(error) => log::warn("qq", format!("下载附件前建客户端失败: {error}")),
                Ok(client) => {
                    let received_at = now_ms();
                    for (index, pending) in media.iter().enumerate() {
                        match download_attachment(&client, pending).await {
                            Ok(bytes) => {
                                if let Some(dto) = store_inbound_media(
                                    inbox,
                                    DIR_NAME,
                                    received_at,
                                    index,
                                    pending.kind,
                                    &pending.name,
                                    bytes,
                                ) {
                                    refs.push(dto);
                                }
                            }
                            Err(error) => log::warn("qq", format!("入站附件下载失败: {error}")),
                        }
                    }
                }
            },
        }
    }
    QqInboundDto {
        message_id,
        peer_id,
        nick,
        sender_id,
        text,
        at,
        media: refs,
    }
}

/// 指数退避（1s → 60s）。
fn reconnect_delay(attempt: u32) -> Duration {
    let seconds = 1u64 << attempt.min(6);
    Duration::from_secs(seconds.min(60))
}

pub(super) async fn run_gateway(
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
