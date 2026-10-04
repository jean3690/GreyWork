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

use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::Mutex;

use crate::channel_common::{app_sink, channel_dir, read_json, write_private, EventSink};
use crate::channel_media::inbox_dir;
use crate::host::HostContext;
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
/// 单条消息最多收几条附件（防止一条消息拖垮一整轮下载）。
const MAX_INBOUND_MEDIA: usize = 4;
/// token 长度上限（官方 token 约 72 字符，留足余量）。
const MAX_TOKEN_CHARS: usize = 200;
/// 雪花 id 的十进制长度上限（Discord id 是 64 位，最长 20 位）。
const MAX_SNOWFLAKE_CHARS: usize = 20;

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
    pub(super) loaded: bool,
    pub(super) credentials: Option<StoredCredentials>,
    pub(super) peers: PeerBook,
    pub(super) state: String,
    pub(super) detail: Option<String>,
    pub(super) last_message_at: Option<i64>,
    /// 网关会话：断线 resume 用。
    pub(super) session_id: Option<String>,
    pub(super) resume_url: Option<String>,
    pub(super) last_seq: Option<i64>,
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
    pub(super) inner: Arc<Mutex<Inner>>,
    pub(super) epoch: Arc<AtomicU64>,
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

pub(super) fn ensure_loaded(
    host_ctx: &Arc<dyn HostContext>,
    inner: &mut Inner,
) -> Result<(), String> {
    if inner.loaded {
        return Ok(());
    }
    let dir = channel_dir(host_ctx.as_ref(), DIR_NAME)?;
    inner.credentials = read_json::<StoredCredentials>(&dir.join(CREDENTIALS_FILE))
        .filter(|item| is_valid_token(&item.token));
    inner.peers = read_json::<PeerBook>(&dir.join(PEERS_FILE)).unwrap_or_default();
    inner.state = "stopped".into();
    inner.loaded = true;
    Ok(())
}

pub(super) fn persist_peers(host_ctx: &Arc<dyn HostContext>, peers: &PeerBook) {
    let Ok(dir) = channel_dir(host_ctx.as_ref(), DIR_NAME) else {
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
    pub(super) sink: EventSink,
    pub(super) persist: Arc<dyn Fn(&PeerBook) + Send + Sync>,
    /// 除归属人外是否也答复其他人（连接建立时定下，改设置后重连生效）。
    pub(super) allow_other_senders: bool,
    /// 入站媒体收件目录（连上时解析一次；不可用时入站附件整体丢弃并记日志）。
    pub(super) inbox: Option<PathBuf>,
}

impl GatewayDeps {
    fn for_host(host_ctx: &Arc<dyn HostContext>) -> Self {
        let handle = Arc::clone(host_ctx);
        let inbox = inbox_dir(host_ctx.as_ref(), DIR_NAME)
            .inspect_err(|error| log::warn("discord", format!("收件目录不可用: {error}")))
            .ok();
        Self {
            sink: app_sink(Arc::clone(host_ctx)),
            persist: Arc::new(move |peers: &PeerBook| persist_peers(&handle, peers)),
            allow_other_senders: false,
            inbox,
        }
    }

    fn emit(&self, event: &str, payload: serde_json::Value) {
        (self.sink)(event, payload);
    }
}

pub(super) fn emit_state(inner: &Inner, deps: &GatewayDeps) {
    deps.emit(
        STATE_EVENT,
        serde_json::to_value(inner.status()).unwrap_or(serde_json::Value::Null),
    );
}

pub(super) async fn set_state(
    inner: &Mutex<Inner>,
    deps: &GatewayDeps,
    state: &str,
    detail: Option<String>,
) {
    let mut guard = inner.lock().await;
    guard.state = state.to_string();
    guard.detail = detail;
    emit_state(&guard, deps);
}

mod commands;
mod connect;
mod persist;
mod protocol;

#[cfg(test)]
mod tests;

pub use commands::*;
pub use persist::*;
pub use protocol::*;
