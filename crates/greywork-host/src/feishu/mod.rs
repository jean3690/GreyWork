//! 飞书通道：自建应用 + 长连接（WebSocket）事件订阅。
//!
//! 与钉钉 Stream 同属「客户端主动连出」的收消息方式：不需要公网回调地址，也不需要
//! 在开放平台填写请求网址。差别在协议细节：
//! 1. `POST /callback/ws/endpoint`（AppID/AppSecret）→ `{data:{URL, ClientConfig}}`
//! 2. 连接 `wss://…`；帧是 **protobuf**（`pbbp2.Frame`：SeqID/LogID/service/method/headers/payload），
//!    `method=0` 是控制帧（客户端发 ping，服务端回 pong，pong 里可能带新的 ClientConfig），
//!    `method=1` 是数据帧（headers.type=event，payload 是事件 JSON）
//! 3. 每个数据帧都要在 3 秒内回一个「同 SeqID + 复制 headers + 追加 biz_rt」的 ack 帧，
//!    payload 是 `{"code":200,…}`；长于一个包的消息按 `sum/seq` 分片，要拼回去
//! 4. 发消息走 HTTP：先换 `tenant_access_token`，再调 `im/v1/messages`
//!
//! 本文件里的 protobuf 只覆盖这两个消息、手写 varint 编解码 —— 为一个已知的小协议
//! 引整个 prost 代码生成不划算，字段号与官方 `pbbp2.pb.go` 一一对应。
//!
//! 安全口径：AppSecret 只落宿主数据目录（`feishu/credentials.json`，0600）；
//! 渲染端拿不到密钥，也拿不到 tenant token。

use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::Mutex;

use crate::channel_common::{app_sink, channel_dir, read_json, write_private, EventSink};
use crate::channel_media::{inbox_dir, MediaRefDto};
use crate::host::HostContext;
use crate::log;

pub const DEFAULT_DOMAIN: &str = "https://open.feishu.cn";
/// 长连接入口路径（官方 SDK 的 GenEndpointUri）。
pub const ENDPOINT_PATH: &str = "/callback/ws/endpoint";
/// 机器人消息事件的 event_type。
pub const MESSAGE_EVENT: &str = "im.message.receive_v1";
/// 普通请求超时。
const API_TIMEOUT: Duration = Duration::from_secs(15);
/// 服务端没下发 PingInterval 时的兜底（官方默认 2 分钟）。
const DEFAULT_PING_INTERVAL: Duration = Duration::from_secs(120);
/// 收不到任何帧的容忍窗口（官方 pongWait = 2 × pingInterval + 5s）。
const PONG_GRACE: Duration = Duration::from_secs(5);
/// 分片重组缓存上限与 TTL。
const FRAGMENT_LIMIT: usize = 32;
const FRAGMENT_TTL: Duration = Duration::from_secs(5);
/// 单条消息最多收几条媒体（防止一条消息拖垮一整轮下载）。
const MAX_INBOUND_MEDIA: usize = 4;
/// 重连退避上限。
const RECONNECT_MAX_DELAY: Duration = Duration::from_secs(60);

pub const STATE_EVENT: &str = "feishu://state";
pub const INBOUND_EVENT: &str = "feishu://inbound";

const CREDENTIALS_FILE: &str = "credentials.json";
const PEERS_FILE: &str = "peers.json";
const DIR_NAME: &str = "feishu";

/* ===== 宿主层：状态与命令 ===== */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeishuStatusDto {
    pub configured: bool,
    /// AppID（应用凭证里唯一可外露的一半，便于确认填对了）。
    pub app_id: Option<String>,
    pub state: String,
    pub detail: Option<String>,
    pub last_message_at: Option<i64>,
    pub peer_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeishuInboundDto {
    pub message_id: Option<String>,
    pub peer_id: String,
    pub nick: String,
    pub text: String,
    /// text / image / audio …（非文本由界面如实说明）。
    pub message_type: Option<String>,
    pub chat_type: Option<String>,
    /// 随消息到达的图片 / 视频 / 语音 / 文件；字节在宿主 inbox，凭 `path` 取走。
    pub media: Vec<MediaRefDto>,
    pub at: i64,
}

#[derive(Default)]
pub(crate) struct Inner {
    loaded: bool,
    credentials: Option<StoredCredentials>,
    peers: PeerBook,
    state: String,
    detail: Option<String>,
    last_message_at: Option<i64>,
    /// 进行中的扫码创建应用会话（device_code 只在内存里，不落盘）。
    registration: Option<RegisterSession>,
}

impl Inner {
    fn status(&self) -> FeishuStatusDto {
        FeishuStatusDto {
            configured: self.credentials.is_some(),
            app_id: self
                .credentials
                .as_ref()
                .map(|credentials| credentials.app_id.clone()),
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

/// 飞书通道宿主：凭证、联系人档案与长连接任务代际。
pub struct FeishuHost {
    inner: Arc<Mutex<Inner>>,
    epoch: Arc<AtomicU64>,
}

impl Default for FeishuHost {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner::default())),
            epoch: Arc::new(AtomicU64::new(0)),
        }
    }
}

impl FeishuHost {
    async fn lock(&self) -> tokio::sync::MutexGuard<'_, Inner> {
        self.inner.lock().await
    }
}

fn ensure_loaded(host_ctx: &Arc<dyn HostContext>, inner: &mut Inner) -> Result<(), String> {
    if inner.loaded {
        return Ok(());
    }
    let dir = channel_dir(host_ctx.as_ref(), DIR_NAME)?;
    inner.credentials =
        read_json::<StoredCredentials>(&dir.join(CREDENTIALS_FILE)).filter(|credentials| {
            !credentials.app_id.trim().is_empty() && !credentials.app_secret.trim().is_empty()
        });
    inner.peers = read_json::<PeerBook>(&dir.join(PEERS_FILE)).unwrap_or_default();
    inner.state = "stopped".into();
    inner.loaded = true;
    Ok(())
}

/// 凭证落盘（0600）。扫码创建与手填两条路径共用，避免两处各写一遍。
fn store_credentials(
    host_ctx: &Arc<dyn HostContext>,
    credentials: &StoredCredentials,
) -> Result<(), String> {
    let dir = channel_dir(host_ctx.as_ref(), DIR_NAME)?;
    let bytes = serde_json::to_vec_pretty(credentials)
        .map_err(|error| format!("凭证序列化失败: {error}"))?;
    write_private(&dir.join(CREDENTIALS_FILE), &bytes)
}

fn persist_peers(host_ctx: &Arc<dyn HostContext>, peers: &PeerBook) {
    let Ok(dir) = channel_dir(host_ctx.as_ref(), DIR_NAME) else {
        return;
    };
    match serde_json::to_vec_pretty(peers) {
        Ok(bytes) => {
            if let Err(error) = write_private(&dir.join(PEERS_FILE), &bytes) {
                log::warn("feishu", format!("联系人档案落盘失败: {error}"));
            }
        }
        Err(error) => log::warn("feishu", format!("联系人档案序列化失败: {error}")),
    }
}

/// 长连接的对外出口：事件广播 + 联系人档案落盘。
pub(crate) struct StreamDeps {
    sink: EventSink,
    persist: Arc<dyn Fn(&PeerBook) + Send + Sync>,
    /// 入站媒体收件目录（连上时解析一次；不可用时入站媒体整体丢弃并记日志）。
    inbox: Option<PathBuf>,
}

impl StreamDeps {
    fn for_host(host_ctx: &Arc<dyn HostContext>) -> Self {
        let handle = Arc::clone(host_ctx);
        let inbox = inbox_dir(host_ctx.as_ref(), DIR_NAME)
            .inspect_err(|error| log::warn("feishu", format!("收件目录不可用: {error}")))
            .ok();
        Self {
            sink: app_sink(Arc::clone(host_ctx)),
            persist: Arc::new(move |peers: &PeerBook| persist_peers(&handle, peers)),
            inbox,
        }
    }

    fn emit(&self, event: &str, payload: serde_json::Value) {
        (self.sink)(event, payload);
    }
}

fn emit_state(inner: &Inner, deps: &StreamDeps) {
    deps.emit(
        STATE_EVENT,
        serde_json::to_value(inner.status()).unwrap_or(serde_json::Value::Null),
    );
}

async fn set_state(inner: &Mutex<Inner>, deps: &StreamDeps, state: &str, detail: Option<String>) {
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
