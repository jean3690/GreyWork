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
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex as SyncMutex;
use tokio::sync::{watch, Mutex};
use wechatbot::{Credentials, IncomingMessage, WeChatBot};

use crate::channel_common::{app_sink, EventSink};
use crate::host::HostContext;

use self::persist::{wechat_dir, wechat_inbox_dir};

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

/// 通道宿主：登录态 / SDK 实例 / 长轮询与扫码任务的句柄。
pub struct WechatHost {
    inner: Arc<Mutex<Inner>>,
    bot: Arc<Mutex<Option<Arc<WeChatBot>>>>,
    login: Arc<SyncMutex<LoginRun>>,
    progress: watch::Sender<u64>,
    cache: Arc<SyncMutex<VecDeque<CachedMessage>>>,
    /// 长轮询任务（connect 挂上，disconnect / 退出登录 stop + abort）。
    run: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// 扫码任务（SDK 的 login 是阻塞 future，宿主后台跑）。
    login_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
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
    fn handles(&self, host_ctx: &Arc<dyn HostContext>) -> Result<HostHandles, String> {
        Ok(HostHandles {
            cred_path: wechat_dir(host_ctx)?.join(CRED_FILE),
            inbox: wechat_inbox_dir(host_ctx)?,
            inner: self.inner.clone(),
            bot: self.bot.clone(),
            login: self.login.clone(),
            progress: self.progress.clone(),
            cache: self.cache.clone(),
            sink: app_sink(Arc::clone(host_ctx)),
        })
    }
}

/* ===== 命令入参 ===== */

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendArgs {
    pub to_user_id: String,
    pub context_token: String,
    pub text: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendTypingArgs {
    pub to_user_id: String,
    pub typing: bool,
}

mod commands;
mod connect;
mod inbound;
mod persist;
mod protocol;

#[cfg(test)]
mod tests;

pub use commands::*;
pub use protocol::*;
