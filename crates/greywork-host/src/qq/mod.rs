//! QQ 通道（QQ 开放平台机器人，官方 WebSocket 网关 + OpenAPI）。
//!
//! 与其余通道同构：协议差异在本模块收敛，宿主侧动作（事件广播、凭证落盘、代际可中断
//! 等待）复用 [`crate::channel_common`]。选它的理由是 QQ 官方给的是**网关长连接**
//! （`/gateway/bot` 下发 wss 地址 + 心跳 + 断线 resume），桌面端不需要公网回调。
//!
//! 安全与边界：
//! - AppSecret 与 access_token 都只在宿主内存/磁盘（0600），渲染端只传文本与对端 id；
//! - 归属人策略：第一个来消息的 QQ 用户成为默认主人，其他人是否答复由设置决定；
//! - **被动回复**：QQ 要求带着入站消息的 `msg_id` 回（5 分钟有效，同一 `msg_id +
//!   msg_seq` 只能发一次），所以回发凭据（msg_id）与序号都留在宿主，渲染端不碰。

use std::fmt::Write as _;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use sha2::Digest as _;
use tokio::sync::Mutex;

use crate::channel_common::{app_sink, channel_dir, read_json, write_private, EventSink};
use crate::channel_media::inbox_dir;
use crate::host::HostContext;
use crate::log;

const DIR_NAME: &str = "qq";
const CREDENTIALS_FILE: &str = "credentials.json";
const PEERS_FILE: &str = "peers.json";

pub const STATE_EVENT: &str = "qq://state";
pub const INBOUND_EVENT: &str = "qq://inbound";

/// 取 access_token（官方新版接入票据接口）。
const TOKEN_URL: &str = "https://api.bot.qq.com/app/getAppAccessToken";
/// OpenAPI 根（网关地址也在这里取）。
const API_BASE: &str = "https://api.sgroup.qq.com";
/// 机器人接入票据：公域群 / C2C 消息事件（`GROUP_AND_C2C_EVENT`，1 << 25）。
/// 只订阅这一位：频道（公会）事件与论坛事件与「手机 QQ 里跟机器人聊天」无关。
const INTENTS_PUBLIC_MESSAGES: i64 = 1 << 25;
/// 心跳兜底间隔：正常用网关 hello 下发的 `heartbeat_interval`，缺失时按 30s。
const FALLBACK_HEARTBEAT: Duration = Duration::from_secs(30);
/// 单条文本上限（QQ 文本消息 1000 字符量级，这里取保守值）。
const MAX_TEXT_CHARS: usize = 1000;
/// 单条消息最多收几条媒体（防止一条消息拖垮一整轮下载）。
const MAX_INBOUND_MEDIA: usize = 4;
/// 分片预上传要求的 `md5_10m`：文件前 10002432 字节（约 10MB）的 MD5。
const MD5_10M_LEN: usize = 10_002_432;
/// 富媒体业务类型：1 图片（仅 png/jpg）、2 视频（mp4/mov）、4 文件。
/// 语音（3）要 SILK 编码，本版不发 —— 共享层已把音频降级为文件。
const FILE_TYPE_IMAGE: i64 = 1;
const FILE_TYPE_MEDIA: i64 = 2;
const FILE_TYPE_FILE: i64 = 4;
/// access_token 提前刷新窗口（官方说明：到期前 60s 内取会拿到新 token）。
const TOKEN_REFRESH_MARGIN_SECS: i64 = 60;

/* ===== 宿主层：状态与命令 ===== */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QqStatusDto {
    /// 是否已保存 AppID + AppSecret。
    pub configured: bool,
    /// 非秘密的 AppID（展示出来便于确认填对了）。
    pub app_id: Option<String>,
    /// stopped / connecting / connected / error
    pub state: String,
    pub detail: Option<String>,
    pub last_message_at: Option<i64>,
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
    /// access_token 缓存（含过期时间戳，秒）。
    access_token: Option<String>,
    token_expires_at: i64,
    /// 网关会话：断线 resume 用（session_id + 最后事件序号）。
    session_id: Option<String>,
    last_seq: i64,
    /// 进行中的扫码创建会话（task_id + bind_key 只在内存里，不落盘）。
    registration: Option<RegisterSession>,
}

impl Inner {
    fn status(&self) -> QqStatusDto {
        QqStatusDto {
            configured: self.credentials.is_some(),
            app_id: self.credentials.as_ref().map(|item| item.app_id.clone()),
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

/// QQ 通道宿主：凭证、联系人凭据与网关任务代际。
pub struct QqHost {
    inner: Arc<Mutex<Inner>>,
    epoch: Arc<AtomicU64>,
}

impl Default for QqHost {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner::default())),
            epoch: Arc::new(AtomicU64::new(0)),
        }
    }
}

impl QqHost {
    async fn lock(&self) -> tokio::sync::MutexGuard<'_, Inner> {
        self.inner.lock().await
    }
}

fn ensure_loaded(host_ctx: &Arc<dyn HostContext>, inner: &mut Inner) -> Result<(), String> {
    if inner.loaded {
        return Ok(());
    }
    let dir = channel_dir(host_ctx.as_ref(), DIR_NAME)?;
    inner.credentials = read_json::<StoredCredentials>(&dir.join(CREDENTIALS_FILE))
        .filter(|item| !item.app_id.trim().is_empty() && !item.app_secret.trim().is_empty());
    inner.peers = read_json::<PeerBook>(&dir.join(PEERS_FILE)).unwrap_or_default();
    inner.state = "stopped".into();
    inner.loaded = true;
    Ok(())
}

fn persist_peers(host_ctx: &Arc<dyn HostContext>, peers: &PeerBook) {
    let Ok(dir) = channel_dir(host_ctx.as_ref(), DIR_NAME) else {
        return;
    };
    match serde_json::to_vec_pretty(peers) {
        Ok(bytes) => {
            if let Err(error) = write_private(&dir.join(PEERS_FILE), &bytes) {
                log::warn("qq", format!("联系人凭据落盘失败: {error}"));
            }
        }
        Err(error) => log::warn("qq", format!("联系人凭据序列化失败: {error}")),
    }
}

/// 网关的对外出口：事件广播 + 联系人凭据落盘 + 本次连接的发送者策略。
pub(crate) struct GatewayDeps {
    sink: EventSink,
    persist: Arc<dyn Fn(&PeerBook) + Send + Sync>,
    /// 除归属人外是否也答复其他人（连接建立时定下，改设置后重连生效）。
    allow_other_senders: bool,
    /// 入站媒体收件目录（连上时解析一次；不可用时入站附件整体丢弃并记日志）。
    inbox: Option<PathBuf>,
}

impl GatewayDeps {
    fn for_host(host_ctx: &Arc<dyn HostContext>) -> Self {
        let handle = Arc::clone(host_ctx);
        let inbox = inbox_dir(host_ctx.as_ref(), DIR_NAME)
            .inspect_err(|error| log::warn("qq", format!("收件目录不可用: {error}")))
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

fn emit_state(inner: &Inner, deps: &GatewayDeps) {
    deps.emit(
        STATE_EVENT,
        serde_json::to_value(inner.status()).unwrap_or(serde_json::Value::Null),
    );
}

async fn set_state(inner: &Mutex<Inner>, deps: &GatewayDeps, state: &str, detail: Option<String>) {
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
pub use connect::*;
pub use persist::*;
pub use protocol::*;
