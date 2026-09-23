//! 微信通道：腾讯官方 ClawBot / iLink Bot API（`ilinkai.weixin.qq.com`）。
//!
//! 为什么是这套接口：个人微信没有 webhook 回调可用（公网不可达），iLink 提供的是
//! **扫码登录 + HTTP 长轮询**——桌面端在内网即可收发消息，不需要公网入口，也没有
//! 逆向 iPad / Hook PC 客户端的封号风险。
//!
//! 协议不自己实现：扫码（含配对码 / IDC 重定向 / 已绑定复用）、长轮询收信、文本与
//! 媒体收发、CDN 上传下载、AES-128-ECB 加解密全部交给官方 Rust SDK `wechatbot`。
//! 本文件只剩 SDK 管不到的那一层（宿主层）：
//! - 状态机：登录态、长轮询任务的启停、会话过期后的重新扫码；
//! - 凭证落盘（0600）、入站媒体落到收件目录等渲染端取走（取走即删）；
//! - Tauri 命令与事件、归属人（发送者）策略。
//!
//! 安全约束（SDK 不承担，全部在宿主侧）：
//! - 登录下发的 `baseurl` 是后续所有请求（含 bot_token）的目标，只接受 https 且主机名在
//!   `qq.com` 域内者；不合规即删除刚落的凭证并丢弃 SDK 实例，绝不把 token 发出去。
//! - bot_token 只落本机应用数据目录（`wechat/credentials.json`，0600），不进设置快照、不进日志。
//! - 默认只答复扫码本人（`allowOtherSenders=false` 时其他发送者的消息在宿主层就被丢弃）。
//! - 入站媒体只从固定的 CDN 基址下载、出站只朝固定的 CDN 基址上传（地址由 SDK 按协议拼），
//!   服务端下发的任意 URL 不参与取字节，SSRF 面因此不存在。
//!
//! 事件与命令见 `wechat_status` 等命令的文档；渲染端封装在 `lib/wechat-backend.ts`。

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex as SyncMutex;
use reqwest::Url;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tokio::sync::{watch, Mutex};
use wechatbot::{
    BotOptions, CDNMedia, Credentials, IncomingMessage, MessageItemType, SendContent, WeChatBot,
    WeChatBotError,
};

use crate::channel_common::{app_sink, channel_dir, now_ms, read_json, write_private, EventSink};
use crate::channel_media::{
    inbox_dir, prune_inbox, store_inbound_media, MediaKind, MediaRefDto, OutboundMedia,
    MAX_MEDIA_BYTES,
};
use crate::log;

/* ===== 常量 ===== */

pub const STATE_EVENT: &str = "wechat://state";
pub const INBOUND_EVENT: &str = "wechat://inbound";

const DIR_NAME: &str = "wechat";
/// SDK 自己读写的凭证文件（退出登录即删除）。
const CRED_FILE: &str = "credentials.json";
/// 旧版本宿主自管凭证的文件名：只在退出登录时一并清掉，免得留下一个已作废的 token。
const LEGACY_SESSION_FILE: &str = "session.json";
/// `wechat_login_poll` 单次挂起时长：前端把它当长轮询用（与旧实现服务端 ~30s 的节奏对齐）。
const LOGIN_POLL_HOLD: Duration = Duration::from_secs(30);
/// 等首张二维码的上限。
const LOGIN_QR_TIMEOUT: Duration = Duration::from_secs(30);
/// 回信凭据缓存条数：SDK 只认它内部「最新」的那个 token，这里按 token 找回被回复的那条消息。
const TOKEN_CACHE_LIMIT: usize = 64;

/* ===== 宿主 DTO（渲染端 lib/wechat-backend.ts 的形状） ===== */

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
    /// wait / confirmed / expired（SDK 不暴露「已扫码待确认」，故不会有 scaned）。
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
    pub from_user_id: String,
    pub context_token: String,
    /// 文本内容；语音取微信云端转写。非文本消息为空串。
    pub text: String,
    /// item_list 的类型集合（1 文本 / 2 图片 / 3 语音 / 4 文件 / 5 视频）。
    pub item_types: Vec<i64>,
    /// 已下载解密的媒体（图片 / 视频 / 语音 / 文件）；失败或未支持的类型不出现在这里。
    pub media: Vec<MediaRefDto>,
    pub create_time_ms: i64,
    /// 宿主收到消息的时刻（epoch ms）。
    pub at: i64,
}

/* ===== 入站媒体：从 SDK 的解析结果里挑出要下载的条目 ===== */

/// 一条待下载的入站媒体（尚未取字节 / 解密）。
struct InboundMedia {
    kind: MediaKind,
    /// 展示名（图片无原名时按序号生成；文件取 `file_name`）。
    name: String,
    /// 协议声明的明文大小（仅文件有；超限可提前拒绝）。
    declared_size: Option<u64>,
    /// CDN 引用：地址与密钥都由 SDK 按协议拼，宿主不碰服务端下发的 URL。
    media: CDNMedia,
    /// 解密密钥覆盖：图片的 key 常挂在 `image_item.aeskey` 而不是 media 里；None = 用 media 自带的。
    aes_key: Option<String>,
}

/// 按条目自己的 `type` 抽可下载媒体：`2` 图片、`3` 语音、`4` 文件、`5` 视频。
///
/// 文本条目不进这里（`text_of` 另取）。缺少 `media`（拿不到 CDN 引用）的条目直接跳过。
fn collect_media(message: &IncomingMessage) -> Vec<InboundMedia> {
    let mut out = Vec::new();
    for (index, item) in message.raw.item_list.iter().enumerate() {
        match item.item_type {
            MessageItemType::Image => {
                let Some(image) = item.image_item.as_ref() else {
                    continue;
                };
                let Some(media) = image.media.clone() else {
                    continue;
                };
                out.push(InboundMedia {
                    kind: MediaKind::Image,
                    name: format!("image-{index}"),
                    // 协议的图片条目没有明文大小字段（下载后再按实际字节数兜底）。
                    declared_size: None,
                    aes_key: nonempty(image.aeskey.as_deref())
                        .or_else(|| nonempty(Some(media.aes_key.as_str()))),
                    media,
                });
            }
            MessageItemType::Voice => {
                let Some(voice) = item.voice_item.as_ref() else {
                    continue;
                };
                let Some(media) = voice.media.clone() else {
                    continue;
                };
                out.push(InboundMedia {
                    kind: MediaKind::Audio,
                    name: format!("voice-{index}"),
                    declared_size: None,
                    // 语音没有独立 aeskey 字段，用 media 自带的。
                    aes_key: None,
                    media,
                });
            }
            MessageItemType::File => {
                let Some(file) = item.file_item.as_ref() else {
                    continue;
                };
                let Some(media) = file.media.clone() else {
                    continue;
                };
                let name = file
                    .file_name
                    .clone()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| format!("file-{index}"));
                out.push(InboundMedia {
                    kind: MediaKind::File,
                    name,
                    declared_size: file
                        .len
                        .as_deref()
                        .and_then(|value| value.trim().parse::<u64>().ok()),
                    media,
                    aes_key: None,
                });
            }
            MessageItemType::Video => {
                let Some(video) = item.video_item.as_ref() else {
                    continue;
                };
                let Some(media) = video.media.clone() else {
                    continue;
                };
                out.push(InboundMedia {
                    kind: MediaKind::Video,
                    name: format!("video-{index}"),
                    declared_size: video.video_size.and_then(|size| u64::try_from(size).ok()),
                    aes_key: None,
                    media,
                });
            }
            _ => {}
        }
    }
    out
}

/// 取消息文本：文本条目直取；语音条目取微信云端转写（协议自带，无需本地识别）。
///
/// 刻意不用 SDK 的 `IncomingMessage::text`：那会把图片 / 视频替换成 `[image]`、`[video]`
/// 之类的占位串，非文本消息就不再是空文本，「只认文字」那条兜底分支会失效。
fn text_of(message: &IncomingMessage) -> String {
    let mut parts: Vec<String> = Vec::new();
    for item in &message.raw.item_list {
        let candidates = [
            item.text_item.as_ref().map(|text| text.text.as_str()),
            item.voice_item
                .as_ref()
                .and_then(|voice| voice.text.as_deref()),
        ];
        for text in candidates.into_iter().flatten() {
            if !text.trim().is_empty() {
                parts.push(text.trim().to_string());
            }
        }
    }
    parts.join("\n")
}

/// 条目类型集合（1 文本 / 2 图片 / 3 语音 / 4 文件 / 5 视频），供界面如实说明收到了什么。
fn item_types_of(message: &IncomingMessage) -> Vec<i64> {
    message
        .raw
        .item_list
        .iter()
        .map(|item| item.item_type as i32 as i64)
        .collect()
}

/// 是否含「可识别条目」：文本 / 语音 / 图片 / 文件 / 视频（1..=5）。
///
/// 顶层 `message_type` 不可靠 —— 媒体消息也可能是 1，所以内容判定只看 `item_list`。
fn has_recognizable_items(message: &IncomingMessage) -> bool {
    message
        .raw
        .item_list
        .iter()
        .any(|item| matches!(item.item_type as i32, 1..=5))
}

/// 非空字符串（空串与纯空白都视为「没有」）。
fn nonempty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/* ===== 宿主层：状态 ===== */

/// 扫码会话的终局。
enum LoginOutcome {
    Confirmed {
        user_id: String,
        bot_id: String,
    },
    /// 失败说明（多次过期、配对码被拒、登录地址不可信等）。
    Failed(String),
}

/// 当前扫码会话：SDK 的 `login` 与宿主之间只靠这个结构同步进展。
///
/// SDK 的 `login` 是个会阻塞到确认 / 放弃的 future，而且只在拿到二维码时回调一次
/// `on_qr_url`（没有「已扫码」「已确认」的回调）。所以宿主自己记住「码是什么、换过没有、
/// 最后成没成」，让 `wechat_login_poll` 的契约（wait / expired / confirmed）保持不变。
#[derive(Default)]
struct LoginRun {
    /// 世代号：取消 / 重新发起都会 +1，旧任务的结果据此丢弃。
    generation: u64,
    /// 用户显式发起（设置页点了扫码）还是 SDK 在会话过期后自行重登。
    explicit: bool,
    /// 当前二维码内容；None = 还没有码（或已取消）。
    qr: Option<String>,
    /// 上次轮询之后是否换过码（前端据此刷新码图；一次性消费）。
    refreshed: bool,
    /// 终局；None = 还在等扫。
    outcome: Option<LoginOutcome>,
}

/// 缓存里的一条入站消息：回信要用「被回复的那条」的 token。
struct CachedMessage {
    token: String,
    message: IncomingMessage,
}

#[derive(Default)]
struct Inner {
    loaded: bool,
    creds: Option<Credentials>,
    state: String,
    detail: Option<String>,
    last_message_at: Option<i64>,
    /// 是否答复扫码者以外的人（连接时按设置下发，入站门禁按它判）。
    allow_other_senders: bool,
}

impl Inner {
    fn status(&self, pending_login: bool) -> WechatStatusDto {
        WechatStatusDto {
            logged_in: self.creds.is_some(),
            user_id: self.creds.as_ref().map(|creds| creds.user_id.clone()),
            bot_id: self.creds.as_ref().map(|creds| creds.account_id.clone()),
            state: if self.state.is_empty() {
                "stopped".into()
            } else {
                self.state.clone()
            },
            detail: self.detail.clone(),
            last_message_at: self.last_message_at,
            pending_login,
        }
    }
}

/// 派生任务与命令共用的宿主句柄（同一批 Arc，克隆即可跨任务持有）。
#[derive(Clone)]
struct HostHandles {
    /// SDK 读写的凭证文件路径。
    cred_path: PathBuf,
    /// 入站媒体收件目录。
    inbox: PathBuf,
    inner: Arc<Mutex<Inner>>,
    /// 当前 SDK 实例：退出登录要整个丢掉重建，才能真正清空它内部的凭证（SDK 没有 logout）。
    bot: Arc<Mutex<Option<Arc<WeChatBot>>>>,
    login: Arc<SyncMutex<LoginRun>>,
    /// 扫码进展的世代号：`wechat_login_poll` 靠它等到「有新动静」。
    progress: watch::Sender<u64>,
    /// `context_token` → 那条入站消息（有界，最旧的先丢）。
    cache: Arc<SyncMutex<VecDeque<CachedMessage>>>,
    sink: EventSink,
}

impl HostHandles {
    /// 有没有进行中的扫码（拿到终局即算结束）。
    fn pending_login(&self) -> bool {
        let run = self.login.lock();
        run.qr.is_some() && run.outcome.is_none()
    }

    /// 唤醒在等的 `wechat_login_poll` / `wechat_login_qr`。
    fn tick(&self) {
        let next = self.progress.borrow().wrapping_add(1);
        let _ = self.progress.send(next);
    }

    /// 按 `context_token` 找回被回复的那条入站消息。
    ///
    /// 微信的 `context_token` 按条颁发，而 SDK 只认它内部「最新」的那个：上一条还没回完、
    /// 下一条又到时，直接 `send` 会用错凭据且被服务端静默丢弃。所以按 token 精确取回。
    fn message_for_token(&self, token: &str) -> Option<IncomingMessage> {
        if token.trim().is_empty() {
            return None;
        }
        let cache = self.cache.lock();
        cache
            .iter()
            .find(|entry| entry.token == token)
            .map(|entry| entry.message.clone())
    }

    /// 记一条入站消息供回信查表（有界，超出丢最旧的）。
    fn remember_token(&self, token: &str, message: &IncomingMessage) {
        if token.is_empty() {
            return;
        }
        let mut cache = self.cache.lock();
        cache.push_back(CachedMessage {
            token: token.to_string(),
            message: message.clone(),
        });
        while cache.len() > TOKEN_CACHE_LIMIT {
            cache.pop_front();
        }
    }

    /// 当前实例（不存在返回 None；不创建）。
    async fn current_bot(&self) -> Option<Arc<WeChatBot>> {
        self.bot.lock().await.clone()
    }

    /// 改状态并广播（所有状态变化的唯一出口）。
    async fn set_state(&self, state: &str, detail: Option<String>) {
        let pending = self.pending_login();
        let status = {
            let mut inner = self.inner.lock().await;
            inner.state = state.to_string();
            inner.detail = detail;
            inner.status(pending)
        };
        self.emit_status(status);
    }

    /// 广播当前状态（不改任何字段）。
    async fn broadcast(&self) {
        let pending = self.pending_login();
        let status = self.inner.lock().await.status(pending);
        self.emit_status(status);
    }

    fn emit_status(&self, status: WechatStatusDto) {
        (self.sink)(
            STATE_EVENT,
            serde_json::to_value(status).unwrap_or(serde_json::Value::Null),
        );
    }
}

/* ===== 宿主层：入站处理 ===== */

/// 入站上下文：SDK 的回调是同步的，真正的下载 / 落盘 / 广播在派生任务里按到达顺序跑。
#[derive(Clone)]
struct InboundCtx {
    handles: HostHandles,
    /// 串行闸：媒体下载是异步的，不串行相邻两条消息就可能乱序落到会话里。
    serial: Arc<Mutex<()>>,
}

impl InboundCtx {
    /// SDK 的回调是同步的：这里只做转发，不做任何 await。
    fn spawn(&self, message: &IncomingMessage) {
        let ctx = self.clone();
        let message = message.clone();
        tauri::async_runtime::spawn(async move { ctx.handle(message).await });
    }

    /// SDK 拿到（或换到）二维码时回调。同步上下文：只落状态 + 唤醒在等的命令。
    fn on_qr_url(&self, url: &str) {
        let (internal, repeat) = {
            let mut run = self.handles.login.lock();
            let repeat = run.qr.is_some();
            run.qr = Some(url.to_string());
            if repeat {
                run.refreshed = true;
            }
            (!run.explicit, repeat)
        };
        log::info(
            "wechat",
            if repeat {
                "二维码已过期，SDK 自动换了新码"
            } else {
                "二维码已就绪，等待扫码"
            },
        );
        self.handles.tick();
        if internal {
            // 不是用户点出来的扫码 = SDK 在会话过期后自行重登：如实报成「已过期，请重新扫码」。
            // （SDK 会把重登做完，但那条路的二维码没有任何界面承载，用户看不到。）
            let handles = self.handles.clone();
            tauri::async_runtime::spawn(async move {
                handles
                    .set_state("paused", Some("登录态已过期，请重新扫码".into()))
                    .await;
            });
        }
    }

    /// SDK 报告一次请求失败（含长轮询的每一次重试）。
    fn on_error(&self, error: &WeChatBotError) {
        let detail = error.to_string();
        log::warn("wechat", format!("通道请求失败: {detail}"));
        let handles = self.handles.clone();
        tauri::async_runtime::spawn(async move { handles.set_state("error", Some(detail)).await });
    }

    /// 单条入站：门禁 → 缓存回信凭据 → 下载媒体 → 广播。
    async fn handle(&self, message: IncomingMessage) {
        let _serial = self.serial.lock().await;

        if !has_recognizable_items(&message) {
            log::info("wechat", "入站消息没有可识别条目（如纯视频），忽略");
            return;
        }

        let (owner, allow_other_senders) = {
            let inner = self.handles.inner.lock().await;
            (
                inner
                    .creds
                    .as_ref()
                    .map(|creds| creds.user_id.clone())
                    .unwrap_or_default(),
                inner.allow_other_senders,
            )
        };
        // 扫码者之外的人默认不答复。拿不到归属人（登录响应没带 user_id）时不做限制：
        // 宁可答复也不要把整条通道变成静默丢弃 —— 真发生会在这里留下一行日志。
        if !allow_other_senders && !owner.is_empty() && owner != message.user_id {
            log::info(
                "wechat",
                format!(
                    "忽略非授权发送者 {}（可在设置中允许其他联系人）",
                    message.user_id
                ),
            );
            return;
        }

        // 回信凭据：微信的 context_token 按条颁发，必须原样带回被回复那条的 token。
        let token = message.context_token().to_string();
        self.handles.remember_token(&token, &message);

        let received_at = now_ms();
        let media = self.materialize(&message, received_at).await;

        let dto = WechatInboundDto {
            from_user_id: message.user_id.clone(),
            context_token: token,
            text: text_of(&message),
            item_types: item_types_of(&message),
            media,
            create_time_ms: message.raw.create_time_ms,
            at: received_at,
        };
        log::info(
            "wechat",
            format!(
                "入站 from={} types={:?} token_len={}",
                dto.from_user_id,
                dto.item_types,
                dto.context_token.len()
            ),
        );
        (self.handles.sink)(
            INBOUND_EVENT,
            serde_json::to_value(dto).unwrap_or(serde_json::Value::Null),
        );

        // 收到消息即证明通道是通的：把状态钉到 connected 并刷新「最近来信」。
        let pending = self.handles.pending_login();
        let status = {
            let mut inner = self.handles.inner.lock().await;
            inner.state = "connected".into();
            inner.detail = None;
            inner.last_message_at = Some(received_at);
            inner.status(pending)
        };
        self.handles.emit_status(status);
    }

    /// 逐条下载解密并落 inbox；单条失败只记日志，不影响同一条消息里的文本与其他媒体。
    async fn materialize(&self, message: &IncomingMessage, received_at: i64) -> Vec<MediaRefDto> {
        let items = collect_media(message);
        if items.is_empty() {
            return Vec::new();
        }
        let Some(bot) = self.handles.current_bot().await else {
            log::warn("wechat", "SDK 实例不在，入站媒体无法下载");
            return Vec::new();
        };
        let mut out = Vec::new();
        for (index, item) in items.iter().enumerate() {
            if let Some(size) = item.declared_size {
                if size > MAX_MEDIA_BYTES {
                    log::warn(
                        "wechat",
                        format!("入站媒体声明大小超过 {MAX_MEDIA_BYTES} 字节上限，跳过"),
                    );
                    continue;
                }
            }
            match bot.download_raw(&item.media, item.aes_key.as_deref()).await {
                Ok(bytes) => {
                    // SDK 的下载不带大小闸（它把整段收进内存），这里至少别把超限文件落盘。
                    if bytes.len() as u64 > MAX_MEDIA_BYTES {
                        log::warn(
                            "wechat",
                            format!("入站媒体超过 {MAX_MEDIA_BYTES} 字节上限，跳过"),
                        );
                        continue;
                    }
                    if let Some(dto) = store_inbound_media(
                        &self.handles.inbox,
                        DIR_NAME,
                        received_at,
                        index,
                        item.kind,
                        &item.name,
                        bytes,
                    ) {
                        out.push(dto);
                    }
                }
                Err(error) => {
                    log::warn(
                        "wechat",
                        format!("入站媒体下载失败（{}）: {error}", item.name),
                    );
                }
            }
        }
        out
    }
}

/* ===== 宿主层：目录与凭证 ===== */

fn wechat_dir(app: &AppHandle) -> Result<PathBuf, String> {
    channel_dir(app, DIR_NAME)
}

/// 微信的入站媒体收件目录（实现在 channel_media，目录名即通道名）。
fn wechat_inbox_dir(app: &AppHandle) -> Result<PathBuf, String> {
    inbox_dir(app, DIR_NAME)
}

/// 校验并归一化 SDK 登录下发的 `baseurl`：必须是 https 且主机名归属 `qq.com`。
///
/// SDK 自己不校验这个地址，而后续所有请求（含 bot_token）都打到它上面 —— 这道闸必须在宿主侧。
fn trusted_api_base(raw: &str) -> Result<String, String> {
    let parsed = Url::parse(raw.trim()).map_err(|error| format!("登录下发的地址非法: {error}"))?;
    if parsed.scheme() != "https" {
        return Err(format!("登录下发的地址必须是 https：{raw}"));
    }
    let host = parsed.host_str().unwrap_or_default();
    if host != "qq.com" && !host.ends_with(".qq.com") {
        return Err(format!("登录下发的主机不在 qq.com 域内：{host}"));
    }
    Ok(parsed.to_string())
}

/// 读 SDK 落的凭证。缺失 / 损坏 / 主机不可信一律当作「未登录」，并把不可用的文件删掉
/// （留着只会让下一次登录在 SDK 内部解析失败，报出一个与现场不符的错）。
fn read_creds(path: &Path) -> Option<Credentials> {
    if !path.exists() {
        return None;
    }
    let parsed: Option<Credentials> = read_json(path);
    let Some(creds) = parsed else {
        log::warn("wechat", "凭证文件无法解析，按未登录处理并删除");
        let _ = std::fs::remove_file(path);
        return None;
    };
    if creds.token.trim().is_empty() {
        log::warn("wechat", "凭证文件缺少 token，按未登录处理并删除");
        let _ = std::fs::remove_file(path);
        return None;
    }
    if let Err(error) = trusted_api_base(&creds.base_url) {
        log::warn("wechat", format!("凭证里的登录地址不可信，丢弃: {error}"));
        let _ = std::fs::remove_file(path);
        return None;
    }
    Some(creds)
}

/// 首次触碰时把磁盘上的凭证读进内存。
fn ensure_loaded(handles: &HostHandles, inner: &mut Inner) {
    if inner.loaded {
        return;
    }
    inner.creds = read_creds(&handles.cred_path);
    inner.state = "stopped".into();
    inner.loaded = true;
}

/// 把 SDK 写的凭证收紧到 0600（SDK 用默认权限写，项目约定是 0600）。
fn harden_credentials(path: &Path) {
    let Ok(bytes) = std::fs::read(path) else {
        return;
    };
    if let Err(error) = write_private(path, &bytes) {
        log::warn("wechat", format!("收紧凭证权限失败: {error}"));
    }
}

/* ===== 宿主层：SDK 实例 ===== */

/// 取当前 SDK 实例；没有就带着回调建一个。
///
/// 回调与宿主之间只共享 `HostHandles`：SDK 的回调是同步的，落状态用同步锁、
/// 真正的 IO 一律派生任务，避免把长轮询的读循环卡在宿主的异步锁上。
async fn ensure_bot(handles: HostHandles) -> Result<Arc<WeChatBot>, String> {
    let mut slot = handles.bot.lock().await;
    if let Some(bot) = slot.as_ref() {
        return Ok(bot.clone());
    }
    let ctx = InboundCtx {
        handles: handles.clone(),
        serial: Arc::new(Mutex::new(())),
    };
    let bot = Arc::new(WeChatBot::new(BotOptions {
        // 初始入口由 SDK 内置；登录成功后它会切到服务端下发的 baseurl（宿主在下发处校验）。
        base_url: None,
        cred_path: Some(handles.cred_path.to_string_lossy().into_owned()),
        on_qr_url: Some({
            let ctx = ctx.clone();
            Box::new(move |url: &str| ctx.on_qr_url(url))
        }),
        on_error: Some({
            let ctx = ctx.clone();
            Box::new(move |error: &WeChatBotError| ctx.on_error(error))
        }),
        bot_agent: Some(format!("GreyWork/{}", env!("CARGO_PKG_VERSION"))),
        // 配对码要用户在手机上读出来再填进本机，设置页没有这个输入面：如实记一行日志后交空串，
        // 让服务端把这次扫码判掉（SDK 会当作配对被拒 → 换码 → 多次后放弃）。
        on_verify_code: Some(Box::new(|retry: bool| {
            log::warn(
                "wechat",
                if retry {
                    "服务端要求配对码，但当前界面没有输入入口，本次登录将失败"
                } else {
                    "服务端要求配对码，但当前界面没有输入入口"
                },
            );
            String::new()
        })),
    }));
    bot.on_message(Box::new({
        let ctx = ctx.clone();
        move |message: &IncomingMessage| ctx.spawn(message)
    }))
    .await;
    *slot = Some(bot.clone());
    Ok(bot)
}

/// 丢掉当前实例（退出登录 / 登录地址不可信时）：SDK 没有 logout，只有重建才能清掉它内部的凭证。
async fn drop_bot(handles: &HostHandles) {
    handles.bot.lock().await.take();
}

/* ===== 宿主层：扫码登录 ===== */

/// 后台跑 SDK 的 `login`：它阻塞到确认 / 放弃，宿主只把结果镜像进 `LoginRun`。
async fn run_login(handles: HostHandles, generation: u64) {
    let bot = match ensure_bot(handles.clone()).await {
        Ok(bot) => bot,
        Err(error) => {
            finish_login(handles, generation, Err(error)).await;
            return;
        }
    };
    // force = false：本地已有可用凭证时直接复用（不发扫码），让「已登录再点扫码」也不炸。
    let result = bot.login(false).await.map_err(|error| error.to_string());
    finish_login(handles, generation, result).await;
}

/// 登录任务的收尾：校验登录地址 → 收紧凭证权限 → 写回 `LoginRun` → 广播状态。
async fn finish_login(handles: HostHandles, generation: u64, result: Result<Credentials, String>) {
    let outcome = match result {
        Ok(creds) => match trusted_api_base(&creds.base_url) {
            Ok(_) => {
                harden_credentials(&handles.cred_path);
                log::info("wechat", format!("扫码登录成功 bot={}", creds.account_id));
                LoginOutcome::Confirmed {
                    user_id: creds.user_id.clone(),
                    bot_id: creds.account_id.clone(),
                }
            }
            Err(error) => {
                // 地址不可信：凭证已经落盘（SDK 写的），删掉并丢掉这个实例，绝不拿它发请求。
                let _ = std::fs::remove_file(&handles.cred_path);
                drop_bot(&handles).await;
                log::warn(
                    "wechat",
                    format!("登录下发的地址不可信，已丢弃凭证: {error}"),
                );
                LoginOutcome::Failed(error)
            }
        },
        Err(error) => {
            log::warn("wechat", format!("扫码登录失败: {error}"));
            LoginOutcome::Failed(error)
        }
    };

    let confirmed = matches!(outcome, LoginOutcome::Confirmed { .. });
    {
        let mut run = handles.login.lock();
        if run.generation != generation {
            log::info("wechat", "已作废的扫码会话结束，忽略其结果");
            return;
        }
        run.outcome = Some(outcome);
    }
    // 凭证可能刚落地：刷新内存里的登录态（loggedIn 要立刻反映出来）。
    {
        let mut inner = handles.inner.lock().await;
        inner.creds = read_creds(&handles.cred_path);
    }
    if confirmed {
        // 登录完成即回到「已登录、未连接」：渲染端确认后自己会去 connect。
        handles.set_state("stopped", None).await;
    } else {
        handles.broadcast().await;
    }
    handles.tick();
}

/// 等 `progress` 世代号变化；超时或发送端消失都按「没动静」返回。
async fn wait_progress(rx: &mut watch::Receiver<u64>, seen: u64, hold: Duration) -> u64 {
    match tokio::time::timeout(hold, rx.wait_for(|value| *value != seen)).await {
        Ok(Ok(guard)) => *guard,
        _ => seen,
    }
}

/* ===== 宿主层：Tauri 命令 ===== */

/// 通道宿主：登录态 / SDK 实例 / 长轮询与扫码任务的句柄。
pub struct WechatHost {
    inner: Arc<Mutex<Inner>>,
    bot: Arc<Mutex<Option<Arc<WeChatBot>>>>,
    login: Arc<SyncMutex<LoginRun>>,
    progress: watch::Sender<u64>,
    cache: Arc<SyncMutex<VecDeque<CachedMessage>>>,
    /// 长轮询任务（connect 挂上，disconnect / 退出登录 stop + abort）。
    run: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    /// 扫码任务（SDK 的 login 是阻塞 future，宿主后台跑）。
    login_task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl Default for WechatHost {
    fn default() -> Self {
        let (progress, _) = watch::channel(0);
        Self {
            inner: Arc::new(Mutex::new(Inner::default())),
            bot: Arc::new(Mutex::new(None)),
            login: Arc::new(SyncMutex::new(LoginRun::default())),
            progress,
            cache: Arc::new(SyncMutex::new(VecDeque::new())),
            run: Mutex::new(None),
            login_task: Mutex::new(None),
        }
    }
}

impl WechatHost {
    fn handles(&self, app: &AppHandle) -> Result<HostHandles, String> {
        Ok(HostHandles {
            cred_path: wechat_dir(app)?.join(CRED_FILE),
            inbox: wechat_inbox_dir(app)?,
            inner: self.inner.clone(),
            bot: self.bot.clone(),
            login: self.login.clone(),
            progress: self.progress.clone(),
            cache: self.cache.clone(),
            sink: app_sink(app),
        })
    }
}

/// 当前通道状态（含是否已登录、长轮询状态、最近收消息时间）。
#[tauri::command]
pub async fn wechat_status(
    app: AppHandle,
    host: State<'_, WechatHost>,
) -> Result<WechatStatusDto, String> {
    let handles = host.handles(&app)?;
    let pending = handles.pending_login();
    let mut inner = handles.inner.lock().await;
    ensure_loaded(&handles, &mut inner);
    // SDK 可能在后台完成过一次登录（例如会话过期后自行重登）：内存里没有就回读一次盘。
    if inner.creds.is_none() {
        inner.creds = read_creds(&handles.cred_path);
    }
    Ok(inner.status(pending))
}

/// 申请登录二维码；返回要编码成二维码的链接文本。
///
/// SDK 的登录是「后台跑 + 回调给码」，这里等首张码就绪再返回，保持「调一次拿到码」的契约。
#[tauri::command]
pub async fn wechat_login_qr(
    app: AppHandle,
    host: State<'_, WechatHost>,
) -> Result<WechatQrDto, String> {
    let handles = host.handles(&app)?;

    // 已有进行中的显式扫码：把那张码还回去，别起第二个登录任务。
    let (existing_qr, generation) = {
        let mut run = handles.login.lock();
        let in_flight = run.explicit && run.qr.is_some() && run.outcome.is_none();
        if in_flight {
            (run.qr.clone(), None)
        } else {
            run.generation = run.generation.wrapping_add(1);
            run.explicit = true;
            run.qr = None;
            run.refreshed = false;
            run.outcome = None;
            (None, Some(run.generation))
        }
    };
    let Some(generation) = generation else {
        return Ok(WechatQrDto {
            content: existing_qr.unwrap_or_default(),
        });
    };

    if let Some(previous) = host.login_task.lock().await.take() {
        previous.abort();
    }
    let task = {
        let handles = handles.clone();
        tauri::async_runtime::spawn(async move { run_login(handles, generation).await })
    };
    *host.login_task.lock().await = Some(task);

    let mut rx = handles.progress.subscribe();
    let mut seen = *rx.borrow();
    let deadline = tokio::time::Instant::now() + LOGIN_QR_TIMEOUT;
    loop {
        {
            let run = handles.login.lock();
            if run.generation == generation {
                if let Some(qr) = run.qr.clone() {
                    return Ok(WechatQrDto { content: qr });
                }
                if let Some(outcome) = run.outcome.as_ref() {
                    return Err(match outcome {
                        LoginOutcome::Failed(detail) => detail.clone(),
                        LoginOutcome::Confirmed { bot_id, .. } => {
                            format!("该账号已登录（bot={bot_id}），无需重新扫码")
                        }
                    });
                }
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("等待二维码超时".into());
        }
        seen = wait_progress(&mut rx, seen, LOGIN_QR_TIMEOUT).await;
    }
}

/// 轮询扫码结果；一次调用最多挂 `LOGIN_POLL_HOLD`（前端按长轮询使用）。
///
/// 返回：`wait`（还在等扫）/ `expired`（换码，带新二维码内容；或带 `detail` 表示失败）/
/// `confirmed`。SDK 不暴露「已扫码待确认」，故不会有 `scaned`。
#[tauri::command]
pub async fn wechat_login_poll(
    app: AppHandle,
    host: State<'_, WechatHost>,
) -> Result<WechatLoginPollDto, String> {
    let handles = host.handles(&app)?;
    let generation = handles.login.lock().generation;
    let mut rx = handles.progress.subscribe();
    let mut seen = *rx.borrow();
    let deadline = tokio::time::Instant::now() + LOGIN_POLL_HOLD;

    loop {
        let result = {
            let mut run = handles.login.lock();
            if run.generation != generation || run.qr.is_none() {
                // 会话已被取消 / 被新的扫码取代：让前端的轮询循环干净收尾。
                Some(WechatLoginPollDto {
                    status: "expired".into(),
                    qr_content: None,
                    user_id: None,
                    bot_id: None,
                    detail: Some("本次扫码已结束".into()),
                })
            } else if let Some(outcome) = run.outcome.take() {
                run.qr = None;
                run.explicit = false;
                Some(match outcome {
                    LoginOutcome::Confirmed { user_id, bot_id } => WechatLoginPollDto {
                        status: "confirmed".into(),
                        qr_content: None,
                        user_id: Some(user_id),
                        bot_id: Some(bot_id),
                        detail: None,
                    },
                    LoginOutcome::Failed(detail) => WechatLoginPollDto {
                        status: "expired".into(),
                        qr_content: None,
                        user_id: None,
                        bot_id: None,
                        detail: Some(detail),
                    },
                })
            } else if run.refreshed {
                run.refreshed = false;
                Some(WechatLoginPollDto {
                    status: "expired".into(),
                    qr_content: run.qr.clone(),
                    user_id: None,
                    bot_id: None,
                    detail: None,
                })
            } else {
                None
            }
        };

        if let Some(result) = result {
            handles.broadcast().await;
            return Ok(result);
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(WechatLoginPollDto {
                status: "wait".into(),
                qr_content: None,
                user_id: None,
                bot_id: None,
                detail: None,
            });
        }
        seen = wait_progress(&mut rx, seen, LOGIN_POLL_HOLD).await;
    }
}

/// 取消进行中的扫码会话（关闭二维码视图时调用）。
///
/// SDK 的登录一旦开始就无法从外部中止，所以这里只作废宿主侧的会话与界面状态；
/// 若用户其实已经扫过码，服务端仍会确认，凭证会落地并在下一次状态刷新时体现出来。
#[tauri::command]
pub async fn wechat_login_cancel(host: State<'_, WechatHost>) -> Result<(), String> {
    {
        let mut run = host.login.lock();
        run.generation = run.generation.wrapping_add(1);
        run.explicit = false;
        run.qr = None;
        run.refreshed = false;
        run.outcome = None;
    }
    if let Some(task) = host.login_task.lock().await.take() {
        task.abort();
    }
    let next = host.progress.borrow().wrapping_add(1);
    let _ = host.progress.send(next);
    Ok(())
}

/// 启动收消息长轮询。`allow_other_senders=false` 时只放行扫码本人的消息。
#[tauri::command]
pub async fn wechat_connect(
    app: AppHandle,
    host: State<'_, WechatHost>,
    allow_other_senders: bool,
) -> Result<(), String> {
    let handles = host.handles(&app)?;
    {
        let mut inner = handles.inner.lock().await;
        ensure_loaded(&handles, &mut inner);
        if inner.creds.is_none() {
            return Err("尚未扫码登录微信".into());
        }
        inner.allow_other_senders = allow_other_senders;
    }
    // 上一次运行可能留下没被取走的收件文件，先清掉陈旧的。
    prune_inbox(&app, DIR_NAME, false);
    handles.set_state("connecting", None).await;

    // 换人：先停掉旧任务。abort 让断开是立即的（否则要等一轮最长 45s 的长轮询返回）。
    if let Some(previous) = host.run.lock().await.take() {
        previous.abort();
    }
    let bot = ensure_bot(handles.clone()).await?;
    // 把磁盘上的凭证装进 SDK 实例（force = false：有凭证就直接复用，不发请求）。
    let creds = bot
        .login(false)
        .await
        .map_err(|error| format!("登录凭证不可用: {error}"))?;
    // 复核一次：SDK 自己重新读了盘上的文件，它不校验地址，而 run() 会把 token 打到这个 base 上。
    trusted_api_base(&creds.base_url)?;

    let task = {
        let handles = handles.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = bot.run().await {
                log::warn("wechat", format!("长轮询异常结束: {error}"));
            }
            // 自然结束 = 没人让它停：那就是出事了，如实报出来。
            // （disconnect / 退出登录走 stop + abort，状态已被置成 stopped，这里不会再报。）
            let state = handles.inner.lock().await.state.clone();
            if state != "stopped" && state != "error" {
                handles
                    .set_state("error", Some("收消息任务已停止".into()))
                    .await;
            }
        })
    };
    *host.run.lock().await = Some(task);
    // SDK 的长轮询没有「首轮成功」回调：凭证可用 + 任务已挂起即视为已连接；
    // 真出错会经 on_error 落到 error 状态，收到任何消息也会把状态钉回 connected。
    handles.set_state("connected", None).await;
    Ok(())
}

/// 停止长轮询（保留登录态）。
#[tauri::command]
pub async fn wechat_disconnect(app: AppHandle, host: State<'_, WechatHost>) -> Result<(), String> {
    let handles = host.handles(&app)?;
    handles.set_state("stopped", None).await;
    if let Some(task) = host.run.lock().await.take() {
        task.abort();
    }
    if let Some(bot) = handles.current_bot().await {
        bot.stop().await;
    }
    Ok(())
}

/// 退出登录：停长轮询 + 删除本机凭证（下次使用需重新扫码）。
#[tauri::command]
pub async fn wechat_logout(app: AppHandle, host: State<'_, WechatHost>) -> Result<(), String> {
    let handles = host.handles(&app)?;
    if let Some(task) = host.run.lock().await.take() {
        task.abort();
    }
    if let Some(task) = host.login_task.lock().await.take() {
        task.abort();
    }
    if let Some(bot) = handles.current_bot().await {
        bot.stop().await;
    }
    // SDK 没有 logout：只有丢掉整个实例，它内部那份凭证缓存才会消失。
    drop_bot(&handles).await;
    {
        let mut run = handles.login.lock();
        run.generation = run.generation.wrapping_add(1);
        run.explicit = false;
        run.qr = None;
        run.refreshed = false;
        run.outcome = None;
    }
    handles.cache.lock().clear();
    for name in [CRED_FILE, LEGACY_SESSION_FILE] {
        let path = handles.cred_path.with_file_name(name);
        if path.exists() {
            if let Err(error) = std::fs::remove_file(&path) {
                log::warn("wechat", format!("删除 {} 失败: {error}", path.display()));
            }
        }
    }
    // 退出登录即清空收件目录：里面的媒体属于这次登录的会话，没有保留价值。
    prune_inbox(&app, DIR_NAME, true);
    {
        let mut inner = handles.inner.lock().await;
        inner.creds = None;
        inner.state = "stopped".into();
        inner.detail = None;
        inner.last_message_at = None;
    }
    handles.broadcast().await;
    log::info("wechat", "已退出登录，凭证已清除");
    Ok(())
}

/// 回一条文本；`context_token` 必须来自对应入站消息（微信按条颁发，用错会被静默丢弃）。
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
    let handles = host.handles(&app)?;
    let bot = ensure_bot(handles.clone()).await?;
    let result = match handles.message_for_token(&context_token) {
        // 用「被回复的那条消息」回：token 与消息一一对应，不受后到消息覆盖影响。
        Some(message) => bot.reply(&message, &text).await,
        // 缓存里没有（宿主重启 / 太旧）时退回 SDK 的默认路径（它记着该用户最新的 token）。
        None => bot.send(&to_user_id, &text).await,
    };
    match result {
        // 出站也留一行日志：手机收不到时，「发没发出去」是第一个要回答的问题。
        Ok(()) => {
            log::info("wechat", format!("已回复 {to_user_id}"));
            Ok(())
        }
        Err(error) => {
            let detail = error.to_string();
            log::warn("wechat", format!("回复 {to_user_id} 失败: {detail}"));
            Err(detail)
        }
    }
}

/// 发送「正在输入」。
///
/// SDK 只提供「发一条正在输入」（内部固定 status=1），没有取消接口，故 `typing=false`
/// 是 no-op —— 指示器由微信自己超时消失，比旧实现少一次显式取消。
#[tauri::command]
pub async fn wechat_send_typing(
    app: AppHandle,
    host: State<'_, WechatHost>,
    to_user_id: String,
    typing: bool,
) -> Result<(), String> {
    if !typing {
        return Ok(());
    }
    let handles = host.handles(&app)?;
    let bot = ensure_bot(handles).await?;
    bot.send_typing(&to_user_id)
        .await
        .map_err(|error| error.to_string())
}

/// 发一条媒体：交给 SDK 加密上传并发送。
///
/// 由通用命令 `channel_send_media` 分发进来（授权面、大小闸与能力校验已在那边做过），
/// 这里只管微信这一套协议：按 `context_token` 找回被回复的那条消息（微信的 token 按条
/// 颁发，用错会被服务端静默丢弃），用 SDK 的 `reply_media` / `send_media` 发出去。
pub(crate) async fn send_media_impl(
    app: &AppHandle,
    to_user_id: &str,
    context_token: Option<&str>,
    media: OutboundMedia,
) -> Result<(), String> {
    let host = app.state::<WechatHost>();
    let handles = host.handles(app)?;
    let bot = ensure_bot(handles.clone()).await?;
    let content = match media.kind {
        MediaKind::Image => SendContent::Image {
            data: media.bytes,
            caption: None,
        },
        MediaKind::Video => SendContent::Video {
            data: media.bytes,
            caption: None,
        },
        // 语音无发送端点：共享层已在分发前把音频降级为文件。
        MediaKind::Audio | MediaKind::File => SendContent::File {
            data: media.bytes,
            file_name: media.name.clone(),
            caption: None,
        },
    };
    let result = match context_token.and_then(|token| handles.message_for_token(token)) {
        Some(message) => bot.reply_media(&message, content).await,
        None => bot.send_media(to_user_id, content).await,
    };
    match result {
        Ok(()) => {
            log::info(
                "wechat",
                format!("已发送媒体 {} → {to_user_id}", media.name),
            );
            Ok(())
        }
        Err(error) => {
            let detail = error.to_string();
            log::warn(
                "wechat",
                format!("发送媒体 {} → {to_user_id} 失败: {detail}", media.name),
            );
            Err(detail)
        }
    }
}

/* ===== 单测（纯函数 + 宿主工具） ===== */

#[cfg(test)]
mod tests {
    use super::*;
    use wechatbot::{
        FileItem, ImageItem, MessageState, MessageType, TextItem, VoiceItem, WireMessage,
        WireMessageItem,
    };

    fn text_item(text: &str) -> WireMessageItem {
        WireMessageItem {
            item_type: MessageItemType::Text,
            text_item: Some(TextItem {
                text: text.to_string(),
            }),
            image_item: None,
            voice_item: None,
            file_item: None,
            video_item: None,
            ref_msg: None,
        }
    }

    fn voice_item(transcript: Option<&str>) -> WireMessageItem {
        WireMessageItem {
            item_type: MessageItemType::Voice,
            text_item: None,
            image_item: None,
            voice_item: Some(VoiceItem {
                media: None,
                encode_type: None,
                text: transcript.map(str::to_string),
                playtime: Some(1200),
            }),
            file_item: None,
            video_item: None,
            ref_msg: None,
        }
    }

    fn media_ref(param: &str, aes_key: &str) -> CDNMedia {
        CDNMedia {
            encrypt_query_param: param.to_string(),
            aes_key: aes_key.to_string(),
            encrypt_type: Some(1),
            full_url: None,
        }
    }

    fn image_item(aeskey: Option<&str>, media: Option<CDNMedia>) -> WireMessageItem {
        WireMessageItem {
            item_type: MessageItemType::Image,
            text_item: None,
            image_item: Some(ImageItem {
                media,
                thumb_media: None,
                aeskey: aeskey.map(str::to_string),
                url: None,
                mid_size: None,
                thumb_width: Some(100),
                thumb_height: Some(200),
            }),
            voice_item: None,
            file_item: None,
            video_item: None,
            ref_msg: None,
        }
    }

    fn file_item(
        name: Option<&str>,
        len: Option<&str>,
        media: Option<CDNMedia>,
    ) -> WireMessageItem {
        WireMessageItem {
            item_type: MessageItemType::File,
            text_item: None,
            image_item: None,
            voice_item: None,
            file_item: Some(FileItem {
                media,
                file_name: name.map(str::to_string),
                md5: None,
                len: len.map(str::to_string),
            }),
            video_item: None,
            ref_msg: None,
        }
    }

    /// 带 CDN 引用的语音条目（无转写文本；用于入站媒体抽取用例）。
    fn voice_item_media(media: Option<CDNMedia>) -> WireMessageItem {
        WireMessageItem {
            item_type: MessageItemType::Voice,
            text_item: None,
            image_item: None,
            voice_item: Some(VoiceItem {
                media,
                encode_type: None,
                text: None,
                playtime: Some(1500),
            }),
            file_item: None,
            video_item: None,
            ref_msg: None,
        }
    }

    fn video_item(media: Option<CDNMedia>, size: Option<i64>) -> WireMessageItem {
        WireMessageItem {
            item_type: MessageItemType::Video,
            text_item: None,
            image_item: None,
            voice_item: None,
            file_item: None,
            video_item: Some(wechatbot::VideoItem {
                media,
                video_size: size,
                play_length: Some(3),
                thumb_media: None,
            }),
            ref_msg: None,
        }
    }

    /// 组一条「用户发来的」线格式消息（SDK 的解析入口只认 message_type = User）。
    fn wire(items: Vec<WireMessageItem>) -> WireMessage {
        WireMessage {
            from_user_id: "user@im.wechat".to_string(),
            to_user_id: "bot@im.bot".to_string(),
            client_id: "c-1".to_string(),
            create_time_ms: 1_700_000_000_000,
            message_type: MessageType::User,
            message_state: MessageState::Finish,
            context_token: "ctx-1".to_string(),
            item_list: items,
        }
    }

    fn parse(items: Vec<WireMessageItem>) -> IncomingMessage {
        IncomingMessage::from_wire(&wire(items)).expect("用户消息应能解析")
    }

    /// 带指定 `context_token` 的用户消息（缓存按消息自己的 token 建表）。
    fn parse_with_token(items: Vec<WireMessageItem>, token: &str) -> IncomingMessage {
        let mut message = wire(items);
        message.context_token = token.to_string();
        IncomingMessage::from_wire(&message).expect("用户消息应能解析")
    }

    #[test]
    fn trusted_api_base_must_be_https_under_qq_com() {
        assert!(trusted_api_base("https://ilinkai.weixin.qq.com").is_ok());
        assert!(trusted_api_base("https://ilinkai.weixin.qq.com/").is_ok());
        assert!(
            trusted_api_base("http://ilinkai.weixin.qq.com").is_err(),
            "非 https 拒绝"
        );
        assert!(
            trusted_api_base("https://evil.example.com").is_err(),
            "非 qq.com 域拒绝"
        );
        assert!(
            trusted_api_base("https://qq.com.evil.example.com").is_err(),
            "后缀伪装拒绝"
        );
    }

    #[test]
    fn text_of_reads_text_and_voice_transcript() {
        let message = parse(vec![text_item("你好"), voice_item(Some("语音转写"))]);
        assert_eq!(text_of(&message), "你好\n语音转写");
        assert_eq!(item_types_of(&message), vec![1, 3]);
        assert!(has_recognizable_items(&message));
    }

    #[test]
    fn text_of_ignores_media_placeholders_and_video_is_recognizable() {
        // 纯图片：文本必须是空串（SDK 的 `IncomingMessage::text` 会给 "[image]" 占位串）。
        let image_only = parse(vec![image_item(Some("k"), Some(media_ref("p", "k")))]);
        assert_eq!(text_of(&image_only), "");
        assert!(has_recognizable_items(&image_only));

        // 纯视频：无文本，但已可下载 → 认得出（本轮起视频纳入入站媒体）。
        let video_only = parse(vec![video_item(Some(media_ref("p", "k")), Some(3_000_000))]);
        assert!(has_recognizable_items(&video_only));
        assert_eq!(text_of(&video_only), "");
    }

    #[test]
    fn collect_media_picks_all_kinds() {
        let message = parse(vec![
            image_item(Some("img-key"), Some(media_ref("p1", "fallback"))),
            text_item("附带一句"),
            voice_item_media(Some(media_ref("p3", "vk"))),
            file_item(Some("报表.xlsx"), Some("2048"), Some(media_ref("p2", "fk"))),
            video_item(Some(media_ref("p4", "mk")), Some(3_000_000)),
        ]);
        let items = collect_media(&message);
        assert_eq!(items.len(), 4);

        assert_eq!(items[0].kind, MediaKind::Image);
        assert_eq!(items[0].name, "image-0");
        assert_eq!(
            items[0].aes_key.as_deref(),
            Some("img-key"),
            "图片优先用条目自带的 key"
        );

        assert_eq!(items[1].kind, MediaKind::Audio);
        assert_eq!(items[1].name, "voice-2");
        assert!(items[1].aes_key.is_none(), "语音用 media 自带的 key");

        assert_eq!(items[2].kind, MediaKind::File);
        assert_eq!(items[2].name, "报表.xlsx");
        assert_eq!(items[2].declared_size, Some(2048));
        assert!(items[2].aes_key.is_none(), "文件用 media 自带的 key");

        assert_eq!(items[3].kind, MediaKind::Video);
        assert_eq!(items[3].name, "video-4");
        assert_eq!(items[3].declared_size, Some(3_000_000));
    }

    #[test]
    fn collect_media_skips_items_without_cdn_ref() {
        let message = parse(vec![
            image_item(Some("k"), None),
            file_item(Some("x.bin"), None, None),
            voice_item_media(None),
            video_item(None, None),
        ]);
        assert!(collect_media(&message).is_empty());
    }

    #[test]
    fn collect_media_falls_back_to_media_key_and_index_name() {
        let message = parse(vec![image_item(None, Some(media_ref("p", "media-key")))]);
        let items = collect_media(&message);
        assert_eq!(items[0].aes_key.as_deref(), Some("media-key"));

        let unnamed = parse(vec![file_item(None, None, Some(media_ref("p", "k")))]);
        assert_eq!(collect_media(&unnamed)[0].name, "file-0");
    }

    #[test]
    fn token_cache_finds_by_token_and_is_bounded() {
        let handles = test_handles();
        let total = TOKEN_CACHE_LIMIT + 5;
        for index in 0..total {
            let token = format!("ctx-{index}");
            let message = parse_with_token(vec![text_item(&format!("第 {index} 条"))], &token);
            handles.remember_token(&token, &message);
        }
        // 超限后最旧的被挤掉，最新的按 token 取得到。
        assert!(handles.message_for_token("ctx-0").is_none());
        assert!(handles
            .message_for_token(&format!("ctx-{}", total - 1))
            .is_some());
        assert_eq!(
            handles
                .message_for_token(&format!("ctx-{}", total - 1))
                .expect("最新一条")
                .context_token(),
            format!("ctx-{}", total - 1)
        );
        assert!(handles.message_for_token("  ").is_none(), "空 token 不查表");
    }

    #[test]
    fn read_creds_rejects_missing_broken_and_untrusted() {
        let dir = std::env::temp_dir().join(format!("gw-wechat-creds-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let path = dir.join("credentials.json");

        // 文件不存在 = 未登录。
        assert!(read_creds(&path).is_none());

        // 坏 JSON：按未登录处理并把文件删掉（留着只会让下一次登录在 SDK 内部解析失败）。
        std::fs::write(&path, b"{ not json").expect("写坏文件");
        assert!(read_creds(&path).is_none());
        assert!(!path.exists(), "坏凭证应被删除");

        // 登录地址不可信：同样丢弃（否则 token 会被打到任意主机上）。
        std::fs::write(
            &path,
            br#"{"token":"tok","baseUrl":"https://evil.example.com","accountId":"bot","userId":"u"}"#,
        )
        .expect("写不可信凭证");
        assert!(read_creds(&path).is_none());
        assert!(!path.exists(), "不可信凭证应被删除");

        // 正常凭证：读得出来。
        std::fs::write(
            &path,
            br#"{"token":"tok","baseUrl":"https://ilinkai.weixin.qq.com","accountId":"bot@im.bot","userId":"u@im.wechat"}"#,
        )
        .expect("写正常凭证");
        let creds = read_creds(&path).expect("正常凭证可读");
        assert_eq!(creds.account_id, "bot@im.bot");
        assert_eq!(creds.user_id, "u@im.wechat");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 只用于测缓存的最小宿主句柄（不发事件、不落盘）。
    fn test_handles() -> HostHandles {
        let (progress, _) = watch::channel(0);
        HostHandles {
            cred_path: PathBuf::from("/tmp/gw-wechat-test/credentials.json"),
            inbox: PathBuf::from("/tmp/gw-wechat-test/inbox"),
            inner: Arc::new(Mutex::new(Inner::default())),
            bot: Arc::new(Mutex::new(None)),
            login: Arc::new(SyncMutex::new(LoginRun::default())),
            progress,
            cache: Arc::new(SyncMutex::new(VecDeque::new())),
            sink: Arc::new(|_, _| {}),
        }
    }
}
