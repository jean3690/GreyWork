//! 企业微信通道（智能机器人「API 模式 · 长连接」）。
//!
//! 为什么是这条路：企业微信自建应用收消息必须挂公网回调 URL（本机应用做不到），
//! 而**智能机器人**提供官方 WebSocket 长连接（`wss://openws.work.weixin.qq.com`），
//! 无需公网 IP、也无需自行做消息加解密——与钉钉 Stream / 飞书长连接同一类能力。
//!
//! 协议要点（官方《智能机器人长连接》）：
//! - 凭证是 BotID + Secret（后台「API 模式 → 长连接」里拿），订阅帧 `aibot_subscribe`；
//! - 收消息 `aibot_msg_callback`（带 `headers.req_id`），收事件 `aibot_event_callback`；
//! - 回复 `aibot_respond_msg` 必须**透传回调的 req_id**（24 小时内可回该会话）；
//! - 没有 req_id（如桌面端主动发）走 `aibot_send_msg` 主动推送，但要求对方先给机器人发过消息；
//! - 心跳是 `{"cmd":"ping"}`；同一机器人只允许一条长连接，新连接会踢掉旧连接。
//!
//! 安全边界：Secret 与 req_id 都只留在宿主内存/磁盘（0600），渲染端只传文本与对端 id；
//! 归属人策略与其余通道一致（第一个来消息的人成为默认主人）。

use std::fmt::Write as _;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use serde::Serialize;
use tokio::sync::{mpsc, oneshot, Mutex};

use crate::channel_common::{app_sink, channel_dir, read_json, write_private, EventSink};
use crate::channel_media::inbox_dir;
use crate::host::HostContext;
use crate::log;

const DIR_NAME: &str = "wecom";
const CREDENTIALS_FILE: &str = "credentials.json";
const PEERS_FILE: &str = "peers.json";

pub const STATE_EVENT: &str = "wecom://state";
pub const INBOUND_EVENT: &str = "wecom://inbound";

/// 官方长连接地址（固定值，不由服务发现下发）。
pub const WS_URL: &str = "wss://openws.work.weixin.qq.com";
/// 心跳间隔：官方只要求「定期 ping」，这里取 25s（低于常见 30s 空闲断连阈值）。
const PING_INTERVAL: Duration = Duration::from_secs(25);
/// 等一次请求回执的上限（订阅 / 回复 / ping 都走这里）。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// 单条文本上限：markdown 消息上限 20480 字节，这里按字符保守取 4000。
const MAX_TEXT_CHARS: usize = 4000;
/// 单条消息最多收几条媒体（防止一条消息拖垮一整轮下载）。
const MAX_INBOUND_MEDIA: usize = 4;
/// 媒体上传分片大小（base64 编码前的原始字节）。
const UPLOAD_CHUNK_SIZE: usize = 512 * 1024;
/// 媒体上传三步（init → chunk × N → finish）的命令名。
const UPLOAD_INIT_CMD: &str = "aibot_upload_media_init";
const UPLOAD_CHUNK_CMD: &str = "aibot_upload_media_chunk";
const UPLOAD_FINISH_CMD: &str = "aibot_upload_media_finish";
/// 被动回复 / 主动推送的命令名。
const RESPOND_CMD: &str = "aibot_respond_msg";
const PUSH_CMD: &str = "aibot_send_msg";
/// 媒体消息里的类别字段值（企业微信出站只认 image，文件出口不存在）。
const MEDIA_TYPE_IMAGE: &str = "image";

/* ===== 宿主层：状态与命令 ===== */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WecomStatusDto {
    /// 是否已保存 BotID + Secret。
    pub configured: bool,
    /// 非秘密的 BotID（展示出来便于确认填对了）。
    pub bot_id: Option<String>,
    /// stopped / connecting / connected / error
    pub state: String,
    pub detail: Option<String>,
    pub last_message_at: Option<i64>,
    pub peer_count: usize,
}

/// 连接任务要发出去的一帧：可选回执通道（有回执的调用会等它自己的 errcode / body）。
pub(crate) struct Outgoing {
    pub frame: serde_json::Value,
    /// 回执通道：等待方拿到回执帧的 body（媒体上传要从这里读 upload_id / media_id）。
    pub ack: Option<oneshot::Sender<Result<serde_json::Value, String>>>,
    pub req_id: Option<String>,
}

#[derive(Default)]
pub(crate) struct Inner {
    loaded: bool,
    credentials: Option<StoredCredentials>,
    peers: PeerBook,
    state: String,
    detail: Option<String>,
    last_message_at: Option<i64>,
    /// 当前连接的发送端（None = 未连接）。
    outgoing: Option<mpsc::Sender<Outgoing>>,
}

impl Inner {
    fn status(&self) -> WecomStatusDto {
        WecomStatusDto {
            configured: self.credentials.is_some(),
            bot_id: self.credentials.as_ref().map(|item| item.bot_id.clone()),
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

/// 企业微信通道宿主：凭证、联系人凭据与连接任务代际。
pub struct WecomHost {
    inner: Arc<Mutex<Inner>>,
    epoch: Arc<AtomicU64>,
}

impl Default for WecomHost {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner::default())),
            epoch: Arc::new(AtomicU64::new(0)),
        }
    }
}

impl WecomHost {
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
        .filter(|item| !item.bot_id.trim().is_empty() && !item.secret.trim().is_empty());
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
                log::warn("wecom", format!("联系人凭据落盘失败: {error}"));
            }
        }
        Err(error) => log::warn("wecom", format!("联系人凭据序列化失败: {error}")),
    }
}

/// 连接任务的对外出口：事件广播 + 联系人凭据落盘 + 本次连接的发送者策略。
pub(crate) struct LinkDeps {
    sink: EventSink,
    persist: Arc<dyn Fn(&PeerBook) + Send + Sync>,
    /// 除归属人外是否也答复其他人（连接建立时定下，改设置后重连生效）。
    allow_other_senders: bool,
    /// 入站媒体收件目录（连上时解析一次；不可用时入站附件整体丢弃并记日志）。
    inbox: Option<PathBuf>,
}

impl LinkDeps {
    fn for_host(host_ctx: &Arc<dyn HostContext>) -> Self {
        let handle = Arc::clone(host_ctx);
        let inbox = inbox_dir(host_ctx.as_ref(), DIR_NAME)
            .inspect_err(|error| log::warn("wecom", format!("收件目录不可用: {error}")))
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

fn emit_state(inner: &Inner, deps: &LinkDeps) {
    deps.emit(
        STATE_EVENT,
        serde_json::to_value(inner.status()).unwrap_or(serde_json::Value::Null),
    );
}

async fn set_state(inner: &Mutex<Inner>, deps: &LinkDeps, state: &str, detail: Option<String>) {
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
