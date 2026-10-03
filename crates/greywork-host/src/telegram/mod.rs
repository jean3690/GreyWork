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

use std::sync::atomic::AtomicU64;
use std::sync::Arc;

use serde::Serialize;
use tokio::sync::Mutex;

use crate::channel_common::{app_sink, channel_dir, read_json, write_private, EventSink};
use crate::host::HostContext;
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
    pub(super) loaded: bool,
    pub(super) credentials: Option<StoredCredentials>,
    pub(super) peers: PeerBook,
    pub(super) state: String,
    pub(super) detail: Option<String>,
    pub(super) last_message_at: Option<i64>,
    /// 长轮询游标：已确认的最大 update_id + 1（持久化在内存里即可，重启后从 0 拉会
    /// 重放历史消息——Telegram 只在 offset 确认后丢弃队列，因此重启重放是协议行为，
    /// 用「已见过的 message_id 去重」不划算：归属人策略与消息落库都幂等）。
    pub(super) offset: i64,
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
    pub(super) inner: Arc<Mutex<Inner>>,
    pub(super) epoch: Arc<AtomicU64>,
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

pub(super) fn ensure_loaded(
    host_ctx: &Arc<dyn HostContext>,
    inner: &mut Inner,
) -> Result<(), String> {
    if inner.loaded {
        return Ok(());
    }
    let dir = channel_dir(host_ctx.as_ref(), DIR_NAME)?;
    inner.credentials = read_json::<StoredCredentials>(&dir.join(CREDENTIALS_FILE))
        .filter(|credentials| validate_token(&credentials.token).is_ok());
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
                log::warn("telegram", format!("联系人档案落盘失败: {error}"));
            }
        }
        Err(error) => log::warn("telegram", format!("联系人档案序列化失败: {error}")),
    }
}

/// 通道的对外出口：事件广播 + 联系人档案落盘。
pub(crate) struct PollDeps {
    pub(super) sink: EventSink,
    pub(super) persist: Arc<dyn Fn(&PeerBook) + Send + Sync>,
}

impl PollDeps {
    fn for_host(host_ctx: &Arc<dyn HostContext>) -> Self {
        let handle = Arc::clone(host_ctx);
        Self {
            sink: app_sink(Arc::clone(host_ctx)),
            persist: Arc::new(move |peers: &PeerBook| persist_peers(&handle, peers)),
        }
    }

    fn emit(&self, event: &str, payload: serde_json::Value) {
        (self.sink)(event, payload);
    }
}

pub(super) fn emit_state(inner: &Inner, deps: &PollDeps) {
    deps.emit(
        STATE_EVENT,
        serde_json::to_value(inner.status()).unwrap_or(serde_json::Value::Null),
    );
}

pub(super) async fn set_state(
    inner: &Mutex<Inner>,
    deps: &PollDeps,
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
