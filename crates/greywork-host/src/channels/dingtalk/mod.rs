//! 钉钉通道：企业内部机器人 + Stream 模式（WebSocket 反向连接）。
//!
//! 为什么是 Stream 模式：它在钉钉开放平台侧订阅事件，由**客户端主动**连出 WebSocket，
//! 不需要公网回调地址，也不需要注册加解密密钥 —— 桌面端在内网即可收发消息。
//!
//! 链路（与官方 `dingtalk-stream-sdk-python` 同形）：
//! 1. `POST /v1.0/gateway/connections/open`（clientId/clientSecret + 订阅表）→ `{endpoint, ticket}`
//! 2. `wss://<endpoint>?ticket=<ticket>` 建连；帧是 JSON 文本，`type` ∈ SYSTEM / EVENT / CALLBACK
//! 3. 机器人消息走 CALLBACK，`topic=/v1.0/im/bot/messages/get`，`data` 是**字符串**包一层 JSON；
//!    每条带 `sessionWebhook`（约 30 分钟有效），回消息就是 POST 到它 —— 不需要额外鉴权
//! 4. 每条帧都要回 ack（同一 messageId），SYSTEM 的 `disconnect` 表示服务端要断开，重连即可
//!
//! 安全口径：`sessionWebhook` 是「能替机器人发言」的凭据，只留在宿主（`dingtalk/peers.json`，
//! 0600），不经过渲染端；渲染端只拿得到联系人 id 与文本。

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

pub const STREAM_OPEN_URL: &str = "https://api.dingtalk.com/v1.0/gateway/connections/open";
/// 机器人单聊/群聊消息的订阅 topic。
pub const CHATBOT_TOPIC: &str = "/v1.0/im/bot/messages/get";
/// 取企业内部应用 accessToken（换下载链接要带它）。
const ACCESS_TOKEN_URL: &str = "https://api.dingtalk.com/v1.0/oauth2/accessToken";
/// 用 `downloadCode` 换临时下载链接。
const FILE_DOWNLOAD_URL: &str = "https://api.dingtalk.com/v1.0/robot/messageFiles/download";
/// `ua` 上报串：官方 SDK 也带，服务端据此放行/统计。
const UA: &str = "greywork-desktop/1.0";
/// 普通请求超时。
const API_TIMEOUT: Duration = Duration::from_secs(15);
/// 主动心跳间隔（服务端也心跳，但官方 SDK 仍每 30–60s 发一次 ping 保活）。
const PING_INTERVAL: Duration = Duration::from_secs(60);
/// 断线重连退避上限。
const RECONNECT_MAX_DELAY: Duration = Duration::from_secs(60);
/// sessionWebhook 兜底有效期（协议给绝对时间戳，这里只用作缺失时的默认值）。
const DEFAULT_WEBHOOK_TTL_MS: i64 = 30 * 60 * 1000;
/// 单条消息最多收几张图（防止一条消息拖垮一整轮下载）。
const MAX_INBOUND_MEDIA: usize = 4;
/// accessToken 提前刷新窗口（官方 7200s 有效，到期前重取）。
const TOKEN_REFRESH_MARGIN_SECS: i64 = 60;

pub const STATE_EVENT: &str = "dingtalk://state";
pub const INBOUND_EVENT: &str = "dingtalk://inbound";

const CREDENTIALS_FILE: &str = "credentials.json";
const PEERS_FILE: &str = "peers.json";
const DIR_NAME: &str = "dingtalk";

/* ===== 宿主层：状态与命令 ===== */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DingTalkStatusDto {
    /// 是否已保存应用凭证（clientId + clientSecret）。
    pub configured: bool,
    /// 凭证里的 clientId（AppKey 本身不是秘密，展示出来便于确认填对了）。
    pub client_id: Option<String>,
    /// stopped / connecting / connected / error
    pub state: String,
    pub detail: Option<String>,
    pub last_message_at: Option<i64>,
    /// 已建档联系人数量（会话页列表用）。
    pub peer_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DingTalkInboundDto {
    pub msg_id: Option<String>,
    pub peer_id: String,
    pub nick: String,
    pub text: String,
    /// 消息类型：text / picture / audio …（其余非文本由渲染端如实说明）。
    pub msg_type: Option<String>,
    pub conversation_type: Option<String>,
    /// 随消息到达的图片；字节在宿主 inbox，凭 `path` 取走。
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
    /// accessToken 缓存（含过期时间戳，秒）—— 换图片下载链接要用。
    access_token: Option<String>,
    token_expires_at: i64,
}

impl Inner {
    fn status(&self) -> DingTalkStatusDto {
        DingTalkStatusDto {
            configured: self.credentials.is_some(),
            client_id: self
                .credentials
                .as_ref()
                .map(|credentials| credentials.client_id.clone()),
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

/// 钉钉通道宿主：凭证、联系人凭据与长连接任务代际。
///
/// `epoch` 与微信通道同义：disconnect / 重连 / 清除凭证都会递增它，
/// 旧任务在下一轮检查时自行退出。
pub struct DingTalkHost {
    inner: Arc<Mutex<Inner>>,
    epoch: Arc<AtomicU64>,
}

impl Default for DingTalkHost {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner::default())),
            epoch: Arc::new(AtomicU64::new(0)),
        }
    }
}

impl DingTalkHost {
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
            !credentials.client_id.trim().is_empty() && !credentials.client_secret.trim().is_empty()
        });
    inner.peers = read_json::<PeerBook>(&dir.join(PEERS_FILE)).unwrap_or_default();
    inner.state = "stopped".into();
    inner.loaded = true;
    Ok(())
}

/// 凭证落盘（0600）：扫码路径与手填路径共用。
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
                log::warn("dingtalk", format!("联系人凭据落盘失败: {error}"));
            }
        }
        Err(error) => log::warn("dingtalk", format!("联系人凭据序列化失败: {error}")),
    }
}

/// 长连接的对外出口：事件广播 + 联系人凭据落盘 + 入站媒体收件目录。
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
            .inspect_err(|error| log::warn("dingtalk", format!("收件目录不可用: {error}")))
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

/// 广播当前状态（调用方已持有锁，这里只做序列化与派发）。
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
