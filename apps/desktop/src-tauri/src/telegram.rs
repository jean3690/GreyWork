//! Telegram 通道（Bot API 长轮询）。
//!
//! 与微信 / 钉钉 / 飞书同构：协议差异在本模块收敛，宿主侧动作（事件广播、凭证落盘、
//! 代际可中断等待）复用 [`crate::channel_common`]。选 Telegram 的理由是它的接入成本
//! 最低——官方 Bot API 只需要一个 bot token，收消息走 `getUpdates` 长轮询，没有
//! WebSocket 握手与签名校验，也不需要开放平台建应用。
//!
//! 安全与边界：
//! - token 是唯一凭证，只落宿主数据目录（0600），渲染端只传文本与对端 id；
//! - 归属人策略：第一个来消息的 chat 成为默认主人，其他人是否答复由设置决定
//!   （与钉钉同一套语义，联系人档案持久化，重启后归属人不丢）；
//! - 单条消息文本上限 4096 字符（Telegram 硬限制），超出截断而不是让整次发送失败。

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

use crate::channel_common::{
    app_sink, channel_dir, now_ms, read_json, sleep_or_stop, write_private, EventSink,
};
use crate::channel_media::{
    ext_of, inbox_dir, prune_inbox, store_inbound_media, MediaKind, MediaRefDto, OutboundMedia,
    MAX_MEDIA_BYTES,
};
use crate::http::{shared_client, RESPONSE_READ_TIMEOUT};
use crate::log;

const DIR_NAME: &str = "telegram";
const CREDENTIALS_FILE: &str = "credentials.json";
const PEERS_FILE: &str = "peers.json";

pub const STATE_EVENT: &str = "telegram://state";
pub const INBOUND_EVENT: &str = "telegram://inbound";

const API_BASE: &str = "https://api.telegram.org";
/// 长轮询挂起时长：服务端最多压这么久再回包，也是「无消息时的轮询间隔」。
const POLL_TIMEOUT_SECS: u64 = 25;
/// Telegram 单条文本上限。
const MAX_TEXT_CHARS: usize = 4096;
/// 单条消息最多收几条媒体（图片 + 文件混排时防止一条消息拖垮一整轮下载）。
const MAX_INBOUND_MEDIA: usize = 4;
/// token 长度上限（防止把别的东西粘进来）。
const MAX_TOKEN_CHARS: usize = 200;
const TOKEN_PREFIX_MAX_DIGITS: usize = 20;
const TOKEN_SECRET_MIN_CHARS: usize = 10;

/* ===== 协议形状（只取本通道用得到的字段） ===== */

#[derive(Debug, Clone, Deserialize)]
struct UpdatesResponse {
    ok: bool,
    #[serde(default)]
    result: Vec<Update>,
    #[serde(default)]
    description: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct Update {
    update_id: i64,
    #[serde(default)]
    message: Option<Message>,
}

#[derive(Debug, Clone, Deserialize)]
struct Message {
    #[serde(default)]
    message_id: i64,
    #[serde(default)]
    from: Option<User>,
    chat: Chat,
    #[serde(default)]
    text: Option<String>,
    /// 图片 / 文件消息的配文（与 text 互斥）；有它就该当正文喂给模型。
    #[serde(default)]
    caption: Option<String>,
    /// 图片消息：同一张图的多个尺寸（递增），取最后一个（最大）。
    #[serde(default)]
    photo: Option<Vec<PhotoSize>>,
    /// 以「文件」方式发出的附件（含被压成文件的图片）。
    #[serde(default)]
    document: Option<Document>,
    /// 语音 / 音频 / 视频：形状同 Document（file_id + 可选名 / mime），按文件收。
    #[serde(default)]
    voice: Option<Document>,
    #[serde(default)]
    audio: Option<Document>,
    #[serde(default)]
    video: Option<Document>,
    /// 服务端时间（unix 秒）。
    #[serde(default)]
    date: Option<i64>,
}

/// 图片尺寸档（只取下载所需字段）。
#[derive(Debug, Clone, Deserialize)]
struct PhotoSize {
    file_id: String,
    #[serde(default)]
    file_size: Option<u64>,
}

/// 附件 / 媒体文件描述（document / voice / audio / video 共用形状，多余字段忽略）。
#[derive(Debug, Clone, Deserialize)]
struct Document {
    file_id: String,
    #[serde(default)]
    file_name: Option<String>,
    #[serde(default)]
    mime_type: Option<String>,
    #[serde(default)]
    file_size: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
struct User {
    /// 反序列化形状对齐用（Telegram 一定带 id）；对端标识取 chat.id，这里不读。
    #[allow(dead_code)]
    id: i64,
    #[serde(default)]
    first_name: Option<String>,
    #[serde(default)]
    last_name: Option<String>,
    #[serde(default)]
    username: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct Chat {
    id: i64,
    #[serde(default)]
    first_name: Option<String>,
    #[serde(default)]
    last_name: Option<String>,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    title: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct SendResponse {
    ok: bool,
    #[serde(default)]
    description: Option<String>,
}

/// `getMe` 回包：机器人自身的公开身份（username 是扫码链接的唯一组成）。
#[derive(Debug, Clone, Deserialize)]
struct MeResponse {
    ok: bool,
    #[serde(default)]
    result: Option<BotUser>,
    #[serde(default)]
    description: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct BotUser {
    #[serde(default)]
    first_name: String,
    #[serde(default)]
    username: Option<String>,
}

/// `getFile` 回包：拿到可下载的 `file_path`（再拼 `/file/bot<token>/<file_path>` 下载）。
#[derive(Debug, Clone, Deserialize)]
struct FileResponse {
    ok: bool,
    #[serde(default)]
    result: Option<FileInfo>,
    #[serde(default)]
    description: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct FileInfo {
    #[serde(default)]
    file_path: Option<String>,
}

/// 扫码绑定用的机器人链接（渲染端只负责把它编成二维码）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TelegramBotLinkDto {
    /// 机器人 @username（不含 `@`）。
    pub username: String,
    pub name: String,
    /// `https://t.me/<username>`：手机扫码即打开与机器人的对话。
    pub url: String,
}

/* ===== token 校验 ===== */

/// bot token 形状：`<数字 id>:<base64url 风格密钥>`。
///
/// 严格到形状层面：token 会被拼进 URL 路径，放行空白 / 斜杠 / `?` 等于把请求目标
/// 交给远端输入决定。校验失败时给的是「怎么填」而不是协议细节。
pub fn validate_token(raw: &str) -> Result<String, String> {
    let token = raw.trim();
    if token.is_empty() {
        return Err("bot token 不能为空".into());
    }
    if token.chars().count() > MAX_TOKEN_CHARS {
        return Err(format!("bot token 过长（最多 {MAX_TOKEN_CHARS} 字符）"));
    }
    if !token.is_ascii() {
        return Err("bot token 只能是 ASCII 字符".into());
    }
    let Some((prefix, secret)) = token.split_once(':') else {
        return Err("bot token 形状应为 `数字:密钥`（在 @BotFather 里获取）".into());
    };
    if prefix.is_empty()
        || prefix.len() > TOKEN_PREFIX_MAX_DIGITS
        || !prefix.chars().all(|c| c.is_ascii_digit())
    {
        return Err("bot token 的 id 段应为数字".into());
    }
    if secret.len() < TOKEN_SECRET_MIN_CHARS
        || !secret
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("bot token 的密钥段含非法字符".into());
    }
    Ok(token.to_string())
}

/// 发送文本净化：空文本拒绝，超长按 Telegram 上限截断（截断也要发出去）。
pub fn clamp_text(raw: &str) -> Result<String, String> {
    let text = raw.trim();
    if text.is_empty() {
        return Err("回复内容为空".into());
    }
    if text.chars().count() <= MAX_TEXT_CHARS {
        return Ok(text.to_string());
    }
    let head: String = text.chars().take(MAX_TEXT_CHARS).collect();
    Ok(head)
}

/* ===== 协议归一（纯函数，可单测） ===== */

/// 一条入站消息的归一形状（渲染端只认这一份）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramInboundDto {
    pub message_id: String,
    /// 对端 chat id（十进制字符串）。
    pub peer_id: String,
    /// 发送者展示名（first + last；缺失回落 username / chat id）。
    pub nick: String,
    /// 文本正文（图片 / 文件的配文也算正文）；非文本消息为空串。
    pub text: String,
    /// 随消息到达的图片 / 视频 / 语音 / 文件；字节在宿主 inbox，凭 `path` 取走。
    pub media: Vec<MediaRefDto>,
    pub at: i64,
}

/// 归一后的入站草稿：媒体还是「待下载」的 file_id，等异步取字节落盘后再产 DTO。
#[derive(Debug, Clone)]
struct InboundDraft {
    message_id: String,
    peer_id: String,
    nick: String,
    text: String,
    at: i64,
    media: Vec<PendingMedia>,
}

/// 待下载的一条入站媒体：Telegram 只给 file_id，字节要再经 getFile + 文件下载取回。
#[derive(Debug, Clone)]
struct PendingMedia {
    file_id: String,
    kind: MediaKind,
    /// 展示名（图片给 "photo"，由 `finalize_media` 按魔数补后缀）。
    name: String,
    declared_size: Option<u64>,
}

fn user_nick(user: &Option<User>, chat: &Chat, peer_id: &str) -> String {
    if let Some(user) = user {
        let name = [user.first_name.as_deref(), user.last_name.as_deref()]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" ");
        if !name.trim().is_empty() {
            return name.trim().to_string();
        }
        if let Some(username) = user
            .username
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            return username.to_string();
        }
    }
    let chat_name = [chat.first_name.as_deref(), chat.last_name.as_deref()]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");
    if !chat_name.trim().is_empty() {
        return chat_name.trim().to_string();
    }
    if let Some(title) = chat
        .title
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        return title.to_string();
    }
    if let Some(username) = chat
        .username
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        return username.to_string();
    }
    peer_id.to_string()
}

/// 一条消息里可收的媒体：图片取最大档；文件 / 语音 / 音频 / 视频按各自类别收，最多 4 条。
fn pending_media(message: &Message) -> Vec<PendingMedia> {
    let mut out = Vec::new();
    if let Some(largest) = message.photo.as_ref().and_then(|sizes| sizes.last()) {
        out.push(PendingMedia {
            file_id: largest.file_id.clone(),
            kind: MediaKind::Image,
            name: "photo".into(),
            declared_size: largest.file_size,
        });
    }
    if let Some(document) = message.document.as_ref() {
        out.push(document_media(document, "document", None));
    }
    for (slot, fallback, kind) in [
        (message.voice.as_ref(), "voice", MediaKind::Audio),
        (message.audio.as_ref(), "audio", MediaKind::Audio),
        (message.video.as_ref(), "video", MediaKind::Video),
    ] {
        if let Some(item) = slot {
            out.push(document_media(item, fallback, Some(kind)));
        }
    }
    out.truncate(MAX_INBOUND_MEDIA);
    out
}

/// document / voice / audio / video 归一：`kind` 为 None 时按 mime 猜
/// （以文件方式发的图也走图片端点），否则用调用方给的类别。
fn document_media(document: &Document, fallback: &str, kind: Option<MediaKind>) -> PendingMedia {
    let name = document
        .file_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback)
        .to_string();
    let kind = kind.unwrap_or_else(|| match document.mime_type.as_deref() {
        Some(mime) if mime.starts_with("image/") => MediaKind::Image,
        _ => MediaKind::File,
    });
    PendingMedia {
        file_id: document.file_id.clone(),
        kind,
        name,
        declared_size: document.file_size,
    }
}

/// `Update` → 归一草稿；无消息体（编辑 / 回调查询等）返回 None。
fn normalize_update(update: &Update, received_at: i64) -> Option<InboundDraft> {
    let message = update.message.as_ref()?;
    let peer_id = message.chat.id.to_string();
    let at = message
        .date
        .filter(|seconds| *seconds > 0)
        .map(|seconds| seconds.saturating_mul(1000))
        .unwrap_or(received_at);
    // 图片 / 文件的配文也算正文：只发图配一句话时，那句话是模型最需要的上下文。
    let text = message
        .text
        .clone()
        .or_else(|| message.caption.clone())
        .unwrap_or_default();
    Some(InboundDraft {
        message_id: message.message_id.to_string(),
        nick: user_nick(&message.from, &message.chat, &peer_id),
        text,
        peer_id,
        at,
        media: pending_media(message),
    })
}

/// 解析一次 `getUpdates` 响应体：`ok=false` 一律当错误（把 description 带出去）。
fn parse_updates(raw: &str) -> Result<Vec<Update>, String> {
    let parsed: UpdatesResponse =
        serde_json::from_str(raw).map_err(|error| format!("getUpdates 响应解析失败: {error}"))?;
    if !parsed.ok {
        return Err(format!(
            "Telegram 拒绝了 getUpdates：{}",
            parsed.description.unwrap_or_else(|| "unknown error".into())
        ));
    }
    Ok(parsed.result)
}

/* ===== 宿主层：持久化 ===== */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredCredentials {
    pub token: String,
    #[serde(default)]
    pub saved_at: Option<String>,
}

/// 「谁在用这台机器」+ 联系人档案。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerBook {
    /// 第一个来消息的 chat = 默认只答复的主人（可在设置里放开）。
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub peers: BTreeMap<String, PeerRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerRecord {
    #[serde(default)]
    pub nick: String,
    #[serde(default)]
    pub last_at: i64,
}

impl PeerBook {
    /// 记录（或刷新）联系人档案。
    pub fn remember(&mut self, peer: &str, nick: &str, at: i64) {
        let entry = self.peers.entry(peer.to_string()).or_insert(PeerRecord {
            nick: nick.to_string(),
            last_at: at,
        });
        if !nick.is_empty() {
            entry.nick = nick.to_string();
        }
        entry.last_at = at;
    }

    pub fn claim_owner(&mut self, peer: &str) -> bool {
        if self.owner.is_some() {
            return false;
        }
        self.owner = Some(peer.to_string());
        true
    }

    /// 是否允许答复该对端（归属人策略的唯一判定点，连接参数与档案共同决定）。
    pub fn allows(&self, peer: &str, allow_other_senders: bool) -> bool {
        allow_other_senders || self.owner.as_deref() == Some(peer)
    }
}

/* ===== 宿主层：状态与命令 ===== */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramStatusDto {
    /// 是否已保存 bot token。
    pub configured: bool,
    /// stopped / connecting / connected / error
    pub state: String,
    pub detail: Option<String>,
    pub last_message_at: Option<i64>,
    /// 已建档联系人数量。
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
    /// 长轮询游标：已确认的最大 update_id + 1（持久化在内存里即可，重启后从 0 拉会
    /// 重放历史消息——Telegram 只在 offset 确认后丢弃队列，因此重启重放是协议行为，
    /// 用「已见过的 message_id 去重」不划算：归属人策略与消息落库都幂等）。
    offset: i64,
}

impl Inner {
    fn status(&self) -> TelegramStatusDto {
        TelegramStatusDto {
            configured: self.credentials.is_some(),
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

/// Telegram 通道宿主：凭证、联系人档案与长轮询任务代际。
pub struct TelegramHost {
    inner: Arc<Mutex<Inner>>,
    epoch: Arc<AtomicU64>,
}

impl Default for TelegramHost {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner::default())),
            epoch: Arc::new(AtomicU64::new(0)),
        }
    }
}

impl TelegramHost {
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
        .filter(|credentials| validate_token(&credentials.token).is_ok());
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
                log::warn("telegram", format!("联系人档案落盘失败: {error}"));
            }
        }
        Err(error) => log::warn("telegram", format!("联系人档案序列化失败: {error}")),
    }
}

/// 通道的对外出口：事件广播 + 联系人档案落盘。
pub(crate) struct PollDeps {
    sink: EventSink,
    persist: Arc<dyn Fn(&PeerBook) + Send + Sync>,
}

impl PollDeps {
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

fn emit_state(inner: &Inner, deps: &PollDeps) {
    deps.emit(
        STATE_EVENT,
        serde_json::to_value(inner.status()).unwrap_or(serde_json::Value::Null),
    );
}

async fn set_state(inner: &Mutex<Inner>, deps: &PollDeps, state: &str, detail: Option<String>) {
    let mut guard = inner.lock().await;
    guard.state = state.to_string();
    guard.detail = detail;
    emit_state(&guard, deps);
}

/* ===== 宿主层：HTTP ===== */

fn api_url(token: &str, method: &str) -> String {
    format!("{API_BASE}/bot{token}/{method}")
}

/// 一次 `getUpdates`：长轮询 `timeout` 秒；返回归一后的入站草稿与本轮最大 update_id。
async fn poll_once(
    client: &reqwest::Client,
    token: &str,
    offset: i64,
) -> Result<(Vec<InboundDraft>, Option<i64>), String> {
    let response = client
        .get(api_url(token, "getUpdates"))
        .query(&[
            ("offset", offset.to_string()),
            ("timeout", POLL_TIMEOUT_SECS.to_string()),
            ("allowed_updates", "[\"message\"]".to_string()),
        ])
        .send()
        .await
        .map_err(|error| format!("getUpdates 请求失败: {error}"))?;
    let status = response.status();
    let body = crate::http::read_text(response, RESPONSE_READ_TIMEOUT)
        .await
        .map_err(|error| format!("getUpdates 响应读取失败: {error}"))?;
    if !status.is_success() {
        return Err(format!("getUpdates 返回 {status}: {}", brief(&body)));
    }
    let updates = parse_updates(&body)?;
    let received_at = now_ms();
    let next_offset = updates.iter().map(|update| update.update_id + 1).max();
    let inbound = updates
        .iter()
        .filter_map(|update| normalize_update(update, received_at))
        .collect();
    Ok((inbound, next_offset))
}

/// 回一条文本：`chat_id` 用对方 chat 的十进制 id。
pub(crate) async fn send_text(
    client: &reqwest::Client,
    token: &str,
    chat_id: i64,
    text: &str,
) -> Result<(), String> {
    let response = client
        .post(api_url(token, "sendMessage"))
        .json(&serde_json::json!({ "chat_id": chat_id, "text": text }))
        .send()
        .await
        .map_err(|error| format!("sendMessage 请求失败: {error}"))?;
    let status = response.status();
    let body = crate::http::read_text(response, RESPONSE_READ_TIMEOUT)
        .await
        .map_err(|error| format!("sendMessage 响应读取失败: {error}"))?;
    if !status.is_success() {
        return Err(format!("sendMessage 返回 {status}: {}", brief(&body)));
    }
    let parsed: SendResponse = serde_json::from_str(&body)
        .map_err(|error| format!("sendMessage 响应解析失败: {error}"))?;
    if !parsed.ok {
        return Err(format!(
            "Telegram 拒绝了这条消息：{}",
            parsed.description.unwrap_or_else(|| "unknown error".into())
        ));
    }
    Ok(())
}

/// `getFile`：把 file_id 换成可下载的 `file_path`（再拼 `/file/bot<token>/<file_path>`）。
pub(crate) async fn get_file_path(
    client: &reqwest::Client,
    token: &str,
    file_id: &str,
) -> Result<String, String> {
    let response = client
        .get(api_url(token, "getFile"))
        .query(&[("file_id", file_id)])
        .send()
        .await
        .map_err(|error| format!("getFile 请求失败: {error}"))?;
    let status = response.status();
    let body = crate::http::read_text(response, RESPONSE_READ_TIMEOUT)
        .await
        .map_err(|error| format!("getFile 响应读取失败: {error}"))?;
    if !status.is_success() {
        return Err(format!("getFile 返回 {status}: {}", brief(&body)));
    }
    let parsed: FileResponse =
        serde_json::from_str(&body).map_err(|error| format!("getFile 响应解析失败: {error}"))?;
    if !parsed.ok {
        return Err(format!(
            "Telegram 拒绝了 getFile：{}",
            parsed.description.unwrap_or_else(|| "unknown error".into())
        ));
    }
    parsed
        .result
        .and_then(|info| info.file_path)
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty())
        .ok_or_else(|| "getFile 回包里没有 file_path".to_string())
}

/// 下载一条媒体字节（`/file/bot<token>/<file_path>`），读入后卡 20MB 上限。
pub(crate) async fn download_file(
    client: &reqwest::Client,
    token: &str,
    file_path: &str,
) -> Result<Vec<u8>, String> {
    let url = format!("{API_BASE}/file/bot{token}/{file_path}");
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|error| format!("下载媒体请求失败: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = crate::http::read_text(response, RESPONSE_READ_TIMEOUT)
            .await
            .unwrap_or_default();
        return Err(format!("下载媒体返回 {status}: {}", brief(&body)));
    }
    let bytes = tokio::time::timeout(RESPONSE_READ_TIMEOUT, response.bytes())
        .await
        .map_err(|_| "下载媒体读取超时".to_string())?
        .map_err(|error| format!("读取媒体字节失败: {error}"))?;
    if bytes.len() as u64 > MAX_MEDIA_BYTES {
        return Err(format!(
            "媒体超过 {} MB 上限",
            MAX_MEDIA_BYTES / (1024 * 1024)
        ));
    }
    Ok(bytes.to_vec())
}

/// 取一条待下载媒体的字节：先按声明的 size 预筛，再 getFile + 下载。
async fn fetch_media(
    client: &reqwest::Client,
    token: &str,
    pending: &PendingMedia,
) -> Result<Vec<u8>, String> {
    if pending
        .declared_size
        .is_some_and(|size| size > MAX_MEDIA_BYTES)
    {
        return Err(format!(
            "媒体超过 {} MB 上限",
            MAX_MEDIA_BYTES / (1024 * 1024)
        ));
    }
    let file_path = get_file_path(client, token, &pending.file_id).await?;
    download_file(client, token, &file_path).await
}

/// 把入站草稿的媒体下载进 inbox，产出渲染端可取的引用（单条失败只记日志，不中断整轮）。
async fn materialize_inbound(
    app: &AppHandle,
    client: &reqwest::Client,
    token: &str,
    draft: InboundDraft,
) -> TelegramInboundDto {
    let InboundDraft {
        message_id,
        peer_id,
        nick,
        text,
        at,
        media,
    } = draft;
    let inbox = match inbox_dir(app, DIR_NAME) {
        Ok(inbox) => inbox,
        Err(error) => {
            log::warn("telegram", format!("收件目录不可用，丢弃入站媒体: {error}"));
            return TelegramInboundDto {
                message_id,
                peer_id,
                nick,
                text,
                at,
                media: Vec::new(),
            };
        }
    };
    let received_at = now_ms();
    let mut refs = Vec::new();
    for (index, pending) in media.iter().enumerate() {
        match fetch_media(client, token, pending).await {
            Ok(bytes) => {
                if let Some(dto) = store_inbound_media(
                    &inbox,
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
            Err(error) => log::warn("telegram", format!("入站媒体下载失败: {error}")),
        }
    }
    TelegramInboundDto {
        message_id,
        peer_id,
        nick,
        text,
        at,
        media: refs,
    }
}

/// 取机器人自身的公开身份并拼出扫码链接。
///
/// 用 `getMe` 而不是让用户手抄 bot 名：token 已经在宿主手里，机器人名是公开信息，
/// 查一次即可。username 缺失（机器人未设置用户名）时明确报错——没有 username 就没有
/// 可扫的 `t.me/...` 链接。
pub(crate) async fn bot_link(
    client: &reqwest::Client,
    token: &str,
) -> Result<TelegramBotLinkDto, String> {
    let response = client
        .get(api_url(token, "getMe"))
        .send()
        .await
        .map_err(|error| format!("getMe 请求失败: {error}"))?;
    let status = response.status();
    let body = crate::http::read_text(response, RESPONSE_READ_TIMEOUT)
        .await
        .map_err(|error| format!("getMe 响应读取失败: {error}"))?;
    if !status.is_success() {
        return Err(format!("getMe 返回 {status}: {}", brief(&body)));
    }
    let parsed: MeResponse =
        serde_json::from_str(&body).map_err(|error| format!("getMe 响应解析失败: {error}"))?;
    if !parsed.ok {
        return Err(format!(
            "Telegram 拒绝了 getMe：{}",
            parsed.description.unwrap_or_else(|| "unknown error".into())
        ));
    }
    let bot = parsed.result.ok_or("getMe 回包里没有机器人信息")?;
    let username = bot
        .username
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or("该机器人没有 username：到 @BotFather 里用 /setname 设置用户名后才能生成扫码链接")?;
    Ok(TelegramBotLinkDto {
        url: format!("https://t.me/{username}"),
        name: bot.first_name,
        username,
    })
}

/// 错误体只留一段摘要（远端错误可能夹带整段 HTML）。
fn brief(text: &str) -> String {
    let trimmed = text.trim();
    let head: String = trimmed.chars().take(200).collect();
    if trimmed.chars().count() > 200 {
        format!("{head}…")
    } else {
        head
    }
}

/* ===== 宿主层：Tauri 命令 ===== */

/// 当前通道状态（是否已配置 token、长轮询状态、已建档联系人数）。
#[tauri::command]
pub async fn telegram_status(
    app: AppHandle,
    host: State<'_, TelegramHost>,
) -> Result<TelegramStatusDto, String> {
    let mut inner = host.lock().await;
    ensure_loaded(&app, &mut inner)?;
    Ok(inner.status())
}

/// 保存 bot token（形状校验通过才落盘）。
#[tauri::command]
pub async fn telegram_save_credentials(
    app: AppHandle,
    host: State<'_, TelegramHost>,
    token: String,
) -> Result<TelegramStatusDto, String> {
    let token = validate_token(&token)?;
    let mut inner = host.lock().await;
    ensure_loaded(&app, &mut inner)?;
    let credentials = StoredCredentials {
        token,
        saved_at: Some(chrono::Utc::now().to_rfc3339()),
    };
    let dir = channel_dir(&app, DIR_NAME)?;
    let bytes = serde_json::to_vec_pretty(&credentials)
        .map_err(|error| format!("凭证序列化失败: {error}"))?;
    write_private(&dir.join(CREDENTIALS_FILE), &bytes)?;
    inner.credentials = Some(credentials);
    inner.detail = None;
    log::info("telegram", "bot token 已保存");
    Ok(inner.status())
}

/// 清除凭证与联系人档案（相当于退出登录），长轮询随之停止。
#[tauri::command]
pub async fn telegram_clear_credentials(
    app: AppHandle,
    host: State<'_, TelegramHost>,
) -> Result<TelegramStatusDto, String> {
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
    prune_inbox(&app, DIR_NAME, true);
    log::info("telegram", "凭证已清除");
    Ok(inner.status())
}

/// 启动长轮询（未配置 token 时报错，由界面引导去填）。
#[tauri::command]
pub async fn telegram_connect(
    app: AppHandle,
    host: State<'_, TelegramHost>,
    allow_other_senders: bool,
) -> Result<(), String> {
    let token = {
        let mut inner = host.lock().await;
        ensure_loaded(&app, &mut inner)?;
        let credentials = inner
            .credentials
            .clone()
            .ok_or("尚未配置 Telegram bot token")?;
        inner.state = "connecting".into();
        inner.detail = None;
        credentials.token
    };
    let epoch = host.epoch.fetch_add(1, Ordering::SeqCst) + 1;
    // 上次会话遗留的未取走收件文件先清掉（渲染端崩溃 / 未取走）。
    prune_inbox(&app, DIR_NAME, false);
    let inner = host.inner.clone();
    let epochs = host.epoch.clone();
    let deps = PollDeps::for_app(&app);
    let handle = app.clone();
    set_state(&inner, &deps, "connecting", None).await;
    tauri::async_runtime::spawn(async move {
        run_poll(
            handle,
            deps,
            inner,
            epochs,
            epoch,
            token,
            allow_other_senders,
        )
        .await;
    });
    Ok(())
}

/// 停止长轮询（保留凭证与联系人档案）。
#[tauri::command]
pub async fn telegram_disconnect(
    app: AppHandle,
    host: State<'_, TelegramHost>,
) -> Result<(), String> {
    host.epoch.fetch_add(1, Ordering::SeqCst);
    let mut inner = host.lock().await;
    ensure_loaded(&app, &mut inner)?;
    let deps = PollDeps::for_app(&app);
    inner.state = "stopped".into();
    inner.detail = None;
    emit_state(&inner, &deps);
    Ok(())
}

/// 扫码绑定：返回机器人的 `t.me/<username>` 链接（渲染端把它编成二维码）。
///
/// 与「连接」无关：链接只依赖 token，正因为不需要连接态，未连接的机器人也能先把码摆出来。
#[tauri::command]
pub async fn telegram_bot_link(
    app: AppHandle,
    host: State<'_, TelegramHost>,
) -> Result<TelegramBotLinkDto, String> {
    let token = {
        let mut inner = host.lock().await;
        ensure_loaded(&app, &mut inner)?;
        inner
            .credentials
            .as_ref()
            .map(|credentials| credentials.token.clone())
            .ok_or("尚未配置 Telegram bot token")?
    };
    let client = shared_client(10)?;
    bot_link(&client, &token).await
}

/// 回一条文本（token 不出宿主，渲染端只传对端 id 与文本）。
#[tauri::command]
pub async fn telegram_send(
    app: AppHandle,
    host: State<'_, TelegramHost>,
    peer_id: String,
    text: String,
) -> Result<(), String> {
    let text = clamp_text(&text)?;
    let chat_id: i64 = peer_id
        .trim()
        .parse()
        .map_err(|_| format!("对端 id 不是合法的 chat id: {peer_id:?}"))?;
    let token = {
        let mut inner = host.lock().await;
        ensure_loaded(&app, &mut inner)?;
        inner
            .credentials
            .as_ref()
            .map(|credentials| credentials.token.clone())
            .ok_or("尚未配置 Telegram bot token")?
    };
    let client = shared_client(10)?;
    send_text(&client, &token, chat_id, &text).await
}

/// 出站端点：图片 / 视频 / 语音 / 文件各走各的 Telegram 方法。
///
/// 语音 OGG/OPUS 走 `sendVoice`（对端显示为语音条），其余音频走 `sendAudio`。
fn send_endpoint(kind: MediaKind, name: &str) -> (&'static str, &'static str) {
    match kind {
        MediaKind::Image => ("sendPhoto", "photo"),
        MediaKind::Video => ("sendVideo", "video"),
        MediaKind::Audio => {
            if matches!(ext_of(name).as_str(), "ogg" | "opus") {
                ("sendVoice", "voice")
            } else {
                ("sendAudio", "audio")
            }
        }
        MediaKind::File => ("sendDocument", "document"),
    }
}

/// 回一条媒体：按类别走对应端点（multipart 直传字节，不落临时文件）。
///
/// token 不出宿主：与文本同一条路径，渲染端只传对端 id 与授权面内的本地路径。
pub(crate) async fn send_media_impl(
    app: &AppHandle,
    peer_id: &str,
    media: OutboundMedia,
) -> Result<(), String> {
    let chat_id: i64 = peer_id
        .trim()
        .parse()
        .map_err(|_| format!("对端 id 不是合法的 chat id: {peer_id:?}"))?;
    let token = {
        let host = app.state::<TelegramHost>();
        let mut inner = host.lock().await;
        ensure_loaded(app, &mut inner)?;
        inner
            .credentials
            .as_ref()
            .map(|credentials| credentials.token.clone())
            .ok_or("尚未配置 Telegram bot token")?
    };
    let (method, field) = send_endpoint(media.kind, &media.name);
    let part = reqwest::multipart::Part::bytes(media.bytes).file_name(media.name);
    let form = reqwest::multipart::Form::new()
        .text("chat_id", chat_id.to_string())
        .part(field, part);
    let client = shared_client(10)?;
    let response = client
        .post(api_url(&token, method))
        .multipart(form)
        .send()
        .await
        .map_err(|error| format!("{method} 请求失败: {error}"))?;
    let status = response.status();
    let body = crate::http::read_text(response, RESPONSE_READ_TIMEOUT)
        .await
        .map_err(|error| format!("{method} 响应读取失败: {error}"))?;
    if !status.is_success() {
        return Err(format!("{method} 返回 {status}: {}", brief(&body)));
    }
    let parsed: SendResponse =
        serde_json::from_str(&body).map_err(|error| format!("{method} 响应解析失败: {error}"))?;
    if !parsed.ok {
        return Err(format!(
            "Telegram 拒绝了这条媒体：{}",
            parsed.description.unwrap_or_else(|| "unknown error".into())
        ));
    }
    Ok(())
}

/* ===== 宿主层：长轮询主循环（带重连退避） ===== */

async fn run_poll(
    app: AppHandle,
    deps: PollDeps,
    inner: Arc<Mutex<Inner>>,
    epochs: Arc<AtomicU64>,
    epoch: u64,
    token: String,
    allow_other_senders: bool,
) {
    let mut attempt: u32 = 0;
    log::info("telegram", "长轮询启动");
    while epochs.load(Ordering::SeqCst) == epoch {
        let client = match shared_client(10) {
            Ok(client) => client,
            Err(error) => {
                set_state(&inner, &deps, "error", Some(error)).await;
                return;
            }
        };
        let offset = {
            let guard = inner.lock().await;
            guard.offset
        };
        match poll_once(&client, &token, offset).await {
            Ok((inbound, next_offset)) => {
                attempt = 0;
                if let Some(next) = next_offset {
                    let mut guard = inner.lock().await;
                    guard.offset = next;
                }
                if inbound.is_empty() {
                    // 长轮询超时无消息属正常：只在首次连上时广播一次 connected。
                    let mut guard = inner.lock().await;
                    if guard.state != "connected" {
                        guard.state = "connected".into();
                        guard.detail = None;
                    }
                    emit_state(&guard, &deps);
                } else {
                    for draft in inbound {
                        // 先把媒体字节下载进 inbox（渲染端凭 path 取走），再广播归一消息。
                        let message = materialize_inbound(&app, &client, &token, draft).await;
                        handle_inbound(&deps, &inner, message, allow_other_senders).await;
                    }
                }
            }
            Err(error) => {
                attempt = attempt.saturating_add(1);
                log::warn("telegram", format!("长轮询失败({attempt}): {error}"));
                set_state(&inner, &deps, "error", Some(error)).await;
                if !sleep_or_stop(&epochs, epoch, reconnect_delay(attempt)).await {
                    break;
                }
                set_state(&inner, &deps, "connecting", None).await;
            }
        }
    }
    log::info("telegram", "长轮询已停止");
}

/// 单条入站：归属人判定 → 更新档案与状态 → 允许则广播。
async fn handle_inbound(
    deps: &PollDeps,
    inner: &Mutex<Inner>,
    message: TelegramInboundDto,
    allow_other_senders: bool,
) {
    let (peers, allowed) = {
        let mut guard = inner.lock().await;
        guard.peers.claim_owner(&message.peer_id);
        guard
            .peers
            .remember(&message.peer_id, &message.nick, message.at);
        if guard
            .last_message_at
            .map(|last| message.at > last)
            .unwrap_or(true)
        {
            guard.last_message_at = Some(message.at);
        }
        let allowed = guard.peers.allows(&message.peer_id, allow_other_senders);
        guard.state = "connected".into();
        guard.detail = None;
        emit_state(&guard, deps);
        (guard.peers.clone(), allowed)
    };
    (deps.persist)(&peers);
    if !allowed {
        log::info(
            "telegram",
            format!(
                "忽略非授权发送者 {}（可在设置中允许其他联系人）",
                message.peer_id
            ),
        );
        return;
    }
    deps.emit(
        INBOUND_EVENT,
        serde_json::to_value(message).unwrap_or(serde_json::Value::Null),
    );
}

/// 指数退避（1s → 60s 上限），与钉钉同一条曲线。
fn reconnect_delay(attempt: u32) -> Duration {
    let seconds = 1u64 << attempt.min(6);
    Duration::from_secs(seconds.min(60))
}

/* ===== 单测（纯函数） ===== */

#[cfg(test)]
mod tests {
    use super::*;

    fn message(id: i64, text: Option<&str>) -> Message {
        Message {
            message_id: id,
            from: Some(User {
                id: 42,
                first_name: Some("Ada".into()),
                last_name: Some("Lovelace".into()),
                username: Some("ada".into()),
            }),
            chat: Chat {
                id: 7,
                first_name: Some("Ada".into()),
                last_name: None,
                username: None,
                title: None,
            },
            text: text.map(str::to_string),
            caption: None,
            photo: None,
            document: None,
            voice: None,
            audio: None,
            video: None,
            date: Some(1_700_000_000),
        }
    }

    fn document(file_id: &str, name: Option<&str>, mime: Option<&str>) -> Document {
        Document {
            file_id: file_id.into(),
            file_name: name.map(str::to_string),
            mime_type: mime.map(str::to_string),
            file_size: None,
        }
    }

    #[test]
    fn token_validation_accepts_botfather_shape() {
        assert_eq!(
            validate_token(" 123456789:AAF-abcdef_ghijklmnop ").unwrap(),
            "123456789:AAF-abcdef_ghijklmnop"
        );
    }

    #[test]
    fn token_validation_rejects_malformed_input() {
        assert!(validate_token("").is_err(), "空 token");
        assert!(validate_token("   ").is_err(), "只有空白");
        assert!(validate_token("123456789").is_err(), "没有冒号");
        assert!(validate_token("abc:AAFabcdefghij").is_err(), "id 段非数字");
        assert!(validate_token("123456789:short").is_err(), "密钥段太短");
        assert!(
            validate_token("123456789:AA F-abcdefghij").is_err(),
            "密钥段带空格（会污染 URL）"
        );
        assert!(
            validate_token("123456789:AAF/abcdefghij").is_err(),
            "密钥段带斜杠（会污染 URL）"
        );
        assert!(
            validate_token(&format!("123456789:{}", "a".repeat(MAX_TOKEN_CHARS))).is_err(),
            "超长 token"
        );
        assert!(
            validate_token("１２３:abcdefghij").is_err(),
            "非 ASCII 数字"
        );
    }

    #[test]
    fn normalize_update_maps_text_message_and_uses_server_time() {
        let update = Update {
            update_id: 11,
            message: Some(message(5, Some("你好"))),
        };
        let inbound = normalize_update(&update, 999).expect("有消息体");
        assert_eq!(inbound.message_id, "5");
        assert_eq!(inbound.peer_id, "7");
        assert_eq!(inbound.nick, "Ada Lovelace");
        assert_eq!(inbound.text, "你好");
        assert_eq!(inbound.at, 1_700_000_000_000, "用服务端时间");
    }

    #[test]
    fn normalize_update_keeps_non_text_messages_with_empty_body() {
        let update = Update {
            update_id: 12,
            message: Some(message(6, None)),
        };
        let inbound = normalize_update(&update, 1_700_000_000_500).expect("图片消息也是消息");
        assert_eq!(inbound.text, "");
        assert_eq!(inbound.at, 1_700_000_000_000);
    }

    #[test]
    fn normalize_update_without_message_is_ignored() {
        let update = Update {
            update_id: 13,
            message: None,
        };
        assert!(
            normalize_update(&update, 1).is_none(),
            "编辑/回调类更新不入流"
        );
    }

    #[test]
    fn normalize_update_uses_caption_as_text() {
        let mut msg = message(7, None);
        msg.caption = Some("看这张图".into());
        msg.photo = Some(vec![PhotoSize {
            file_id: "p".into(),
            file_size: Some(5),
        }]);
        let update = Update {
            update_id: 14,
            message: Some(msg),
        };
        let draft = normalize_update(&update, 1).expect("有消息体");
        assert_eq!(draft.text, "看这张图", "配文当正文");
        assert_eq!(draft.media.len(), 1);
        assert_eq!(draft.media[0].file_id, "p");
    }

    #[test]
    fn pending_media_picks_largest_photo_and_labels_files() {
        let mut msg = message(9, None);
        msg.photo = Some(vec![
            PhotoSize {
                file_id: "small".into(),
                file_size: Some(10),
            },
            PhotoSize {
                file_id: "big".into(),
                file_size: Some(999),
            },
        ]);
        msg.document = Some(document(
            "doc-1",
            Some("报表.xlsx"),
            Some("application/vnd.ms-excel"),
        ));

        let media = pending_media(&msg);
        assert_eq!(media.len(), 2);
        assert_eq!(media[0].file_id, "big", "图片取最大档");
        assert_eq!(media[0].kind, MediaKind::Image);
        assert_eq!(media[0].name, "photo");
        assert_eq!(media[1].kind, MediaKind::File);
        assert_eq!(media[1].name, "报表.xlsx");
    }

    #[test]
    fn pending_media_treats_image_mime_as_image_and_caps_count() {
        let mut msg = message(10, None);
        msg.photo = Some(vec![PhotoSize {
            file_id: "p".into(),
            file_size: None,
        }]);
        // image/* 的 document 按图片收（以文件方式发的图）。
        msg.document = Some(document("d", None, Some("image/jpeg")));
        msg.voice = Some(document("v", None, None));
        msg.audio = Some(document("a", None, None));
        msg.video = Some(document("m", None, None));

        let media = pending_media(&msg);
        assert_eq!(media.len(), MAX_INBOUND_MEDIA, "超出上限截断");
        assert_eq!(media[1].kind, MediaKind::Image, "image/* 按图片收");
        assert_eq!(media[1].name, "document", "无名回落固定标签");
        assert_eq!(media[2].kind, MediaKind::Audio, "语音按音频收");
        assert_eq!(media[2].name, "voice");
        assert_eq!(media[3].kind, MediaKind::Audio, "音频按音频收");
        assert_eq!(media[3].name, "audio");
    }

    #[test]
    fn pending_media_classifies_voice_audio_video() {
        let mut msg = message(11, None);
        msg.voice = Some(document("v", Some("note.ogg"), None));
        msg.audio = Some(document("a", Some("song.mp3"), None));
        msg.video = Some(document("m", Some("clip.mp4"), None));

        let media = pending_media(&msg);
        assert_eq!(media.len(), 3);
        assert_eq!(
            (media[0].kind, media[0].name.as_str()),
            (MediaKind::Audio, "note.ogg")
        );
        assert_eq!(
            (media[1].kind, media[1].name.as_str()),
            (MediaKind::Audio, "song.mp3")
        );
        assert_eq!(
            (media[2].kind, media[2].name.as_str()),
            (MediaKind::Video, "clip.mp4")
        );
    }

    #[test]
    fn send_endpoint_maps_kinds_and_voice_format() {
        assert_eq!(
            send_endpoint(MediaKind::Image, "a.png"),
            ("sendPhoto", "photo")
        );
        assert_eq!(
            send_endpoint(MediaKind::Video, "a.mp4"),
            ("sendVideo", "video")
        );
        assert_eq!(
            send_endpoint(MediaKind::File, "a.pdf"),
            ("sendDocument", "document")
        );
        // 语音：OGG/OPUS 走 sendVoice，其余音频走 sendAudio。
        assert_eq!(
            send_endpoint(MediaKind::Audio, "note.ogg"),
            ("sendVoice", "voice")
        );
        assert_eq!(
            send_endpoint(MediaKind::Audio, "note.OPUS"),
            ("sendVoice", "voice")
        );
        assert_eq!(
            send_endpoint(MediaKind::Audio, "song.mp3"),
            ("sendAudio", "audio")
        );
    }

    #[test]
    fn parse_updates_surfaces_api_error() {
        let error = parse_updates(r#"{"ok":false,"description":"Unauthorized"}"#).unwrap_err();
        assert!(error.contains("Unauthorized"), "错误摘要要带 description");
        let empty = parse_updates(r#"{"ok":true,"result":[]}"#).unwrap();
        assert!(empty.is_empty());
    }

    #[test]
    fn peer_book_claims_first_sender_as_owner_and_filters_others() {
        let mut book = PeerBook::default();
        assert!(book.claim_owner("7"), "第一个人是主人");
        assert!(!book.claim_owner("8"), "归属人只认第一个");
        assert!(book.allows("7", false));
        assert!(!book.allows("8", false), "其他人默认不答复");
        assert!(book.allows("8", true), "放开后其他人也可用");
        book.remember("8", "Bob", 100);
        book.remember("8", "Bobby", 200);
        assert_eq!(book.peers.len(), 1, "同一 chat 只留一条档案");
        assert_eq!(book.peers["8"].nick, "Bobby");
        assert_eq!(book.peers["8"].last_at, 200);
        // 归属人本身也要有档案（handle_inbound 里 claim 与 remember 成对调用）
        book.remember("7", "Ada", 300);
        assert_eq!(book.peers.len(), 2);
        assert_eq!(book.owner.as_deref(), Some("7"));
    }

    #[test]
    fn clamp_text_rejects_empty_and_truncates_long_text() {
        assert!(clamp_text("   ").is_err());
        let long: String = "字".repeat(MAX_TEXT_CHARS + 10);
        let clipped = clamp_text(&long).unwrap();
        assert_eq!(clipped.chars().count(), MAX_TEXT_CHARS);
    }

    #[test]
    fn bot_link_builds_t_me_url_from_get_me_payload() {
        let parsed: MeResponse =
            serde_json::from_str(r#"{"ok":true,"result":{"id":1,"is_bot":true,"first_name":"GreyWork","username":"greywork_bot"}}"#)
                .expect("getMe 形状");
        let bot = parsed.result.expect("有 result");
        assert_eq!(bot.username.as_deref(), Some("greywork_bot"));
        assert_eq!(bot.first_name, "GreyWork");
    }

    #[test]
    fn bot_link_payloads_without_username_are_rejected() {
        // ok=true 但没有 username：没有可扫的链接（走同一条错误分支）
        let parsed: MeResponse =
            serde_json::from_str(r#"{"ok":true,"result":{"first_name":"GreyWork"}}"#)
                .expect("形状");
        assert!(parsed.result.expect("有 result").username.is_none());
        // ok=false：把 description 带出去
        let failed: MeResponse =
            serde_json::from_str(r#"{"ok":false,"description":"Unauthorized"}"#).expect("形状");
        assert!(!failed.ok);
        assert_eq!(failed.description.as_deref(), Some("Unauthorized"));
    }

    #[test]
    fn api_url_keeps_token_in_path() {
        assert_eq!(
            api_url("1:abc", "getUpdates"),
            "https://api.telegram.org/bot1:abc/getUpdates"
        );
    }
}
