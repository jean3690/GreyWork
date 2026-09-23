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

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use aes::cipher::generic_array::GenericArray;
use aes::cipher::{BlockDecrypt, KeyInit};
use aes::Aes256;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_tungstenite::tungstenite::Message;

use crate::channel_common::{
    app_sink, channel_dir, now_ms, read_json, sleep_or_stop, write_private, EventSink,
};
use crate::channel_media::{
    inbox_dir, prune_inbox, store_inbound_media, MediaKind, MediaRefDto, OutboundMedia,
    MAX_MEDIA_BYTES,
};
use crate::http::{shared_client, RESPONSE_READ_TIMEOUT};
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

/* ===== 协议形状 ===== */

/// 服务端下行帧：请求回执（无 cmd，带 headers.req_id + errcode）与回调（有 cmd）共用一份形状。
#[derive(Debug, Clone, Deserialize)]
struct ServerFrame {
    #[serde(default)]
    cmd: Option<String>,
    #[serde(default)]
    headers: FrameHeaders,
    #[serde(default)]
    errcode: Option<i64>,
    #[serde(default)]
    errmsg: Option<String>,
    #[serde(default)]
    body: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct FrameHeaders {
    #[serde(default)]
    req_id: Option<String>,
}

/// `aibot_msg_callback` / `aibot_event_callback` 的 body（只取用得到的字段）。
#[derive(Debug, Clone, Default, Deserialize)]
struct CallbackBody {
    #[serde(default)]
    msgid: String,
    #[serde(default)]
    create_time: Option<i64>,
    #[serde(default)]
    chatid: Option<String>,
    #[serde(default)]
    chattype: Option<String>,
    #[serde(default)]
    from: FromUser,
    #[serde(default)]
    msgtype: Option<String>,
    #[serde(default)]
    text: Option<TextBlock>,
    #[serde(default)]
    event: Option<EventBlock>,
    /// 图片 / 视频：`{url, aeskey}`（长连接模式额外给 aeskey，字节要解密）。
    #[serde(default)]
    image: Option<MediaBlock>,
    #[serde(default)]
    video: Option<MediaBlock>,
    /// 文件：`{url, aeskey, name?, size?}`。
    #[serde(default)]
    file: Option<FileBlock>,
    /// 图文混排：`{msg_item: [{type, text?, image?}]}`。
    #[serde(default)]
    mixed: Option<MixedBlock>,
}

/// 图片 / 视频块。
#[derive(Debug, Clone, Default, Deserialize)]
struct MediaBlock {
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    aeskey: Option<String>,
}

/// 文件块。
#[derive(Debug, Clone, Default, Deserialize)]
struct FileBlock {
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    aeskey: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    size: Option<u64>,
}

/// 图文混排块。
#[derive(Debug, Clone, Default, Deserialize)]
struct MixedBlock {
    #[serde(default)]
    msg_item: Vec<MixedItem>,
}

/// 图文混排里的一项：`type` 是 `text` 或 `image`。
#[derive(Debug, Clone, Default, Deserialize)]
struct MixedItem {
    #[serde(default, rename = "type")]
    kind: Option<String>,
    #[serde(default)]
    text: Option<TextBlock>,
    #[serde(default)]
    image: Option<MediaBlock>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct FromUser {
    #[serde(default)]
    userid: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct TextBlock {
    #[serde(default)]
    content: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct EventBlock {
    #[serde(default)]
    eventtype: Option<String>,
}

/* ===== 归一（纯函数，可单测） ===== */

/// 会话范围：单聊 / 群聊（主动推送要区分 chat_type）。
#[derive(Debug, Clone, PartialEq)]
pub enum ChatScope {
    Single,
    Group,
}

/// 对端 id 编码：`single:<userid>` / `group:<chatid>`。
pub fn encode_peer(scope: &ChatScope, id: &str) -> String {
    let prefix = match scope {
        ChatScope::Single => "single",
        ChatScope::Group => "group",
    };
    format!("{prefix}:{id}")
}

/// 解码对端 id；形状不对返回 None。
pub fn decode_peer(peer_id: &str) -> Option<(ChatScope, String)> {
    let (prefix, id) = peer_id.split_once(':')?;
    let scope = match prefix {
        "single" => ChatScope::Single,
        "group" => ChatScope::Group,
        _ => return None,
    };
    let id = id.trim();
    if id.is_empty() {
        return None;
    }
    Some((scope, id.to_string()))
}

/// 一条入站消息的归一形状。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WecomInboundDto {
    pub msg_id: String,
    /// 对端 id（`single:<userid>` / `group:<chatid>`）。
    pub peer_id: String,
    /// 发送者展示名：企业微信只给 userid，这里回落对端 id。
    pub nick: String,
    /// 发送者 userid（判归属人）。
    pub sender_id: String,
    pub text: String,
    /// 收不下也转不成文本的消息类型（如 voice），其余为空串。
    pub unsupported: String,
    /// 随消息到达的图片 / 文件；字节在宿主 inbox，凭 `path` 取走。
    pub media: Vec<MediaRefDto>,
    pub at: i64,
}

/// 归一后的入站草稿：媒体还是「待下载」的 `{url, aeskey}`，等异步取字节落盘后再产 DTO。
#[derive(Debug, Clone)]
pub(crate) struct WecomInboundDraft {
    pub msg_id: String,
    pub peer_id: String,
    pub nick: String,
    pub sender_id: String,
    pub text: String,
    pub unsupported: String,
    pub at: i64,
    pub media: Vec<PendingMedia>,
}

/// 待下载的一条入站媒体（长连接模式给的是加密直链 + aeskey）。
#[derive(Debug, Clone)]
pub(crate) struct PendingMedia {
    url: String,
    aeskey: Option<String>,
    kind: MediaKind,
    name: String,
    declared_size: Option<u64>,
}

/// 归一条消息回调；缺关键字段返回 None。
pub(crate) fn normalize_callback(
    body: &serde_json::Value,
    received_at: i64,
) -> Option<WecomInboundDraft> {
    let parsed: CallbackBody = serde_json::from_value(body.clone()).ok()?;
    let sender = parsed
        .from
        .userid
        .clone()
        .filter(|value| !value.trim().is_empty())?;
    let is_group = parsed.chattype.as_deref() == Some("group");
    let peer_id = if is_group {
        encode_peer(
            &ChatScope::Group,
            parsed.chatid.as_deref().unwrap_or_default(),
        )
    } else {
        encode_peer(&ChatScope::Single, &sender)
    };
    if peer_id.ends_with(':') {
        // 群聊消息没有 chatid：没法回发，丢掉而不是猜一个
        return None;
    }
    let msgtype = parsed.msgtype.clone().unwrap_or_default();
    let text = match msgtype.as_str() {
        "text" => parsed
            .text
            .as_ref()
            .and_then(|block| block.content.clone())
            .unwrap_or_default(),
        // 图文混排里的文本项也当正文转达，免得只有图没话。
        "mixed" => parsed.mixed.as_ref().map(mixed_text).unwrap_or_default(),
        _ => String::new(),
    };
    let media = pending_media(&parsed);
    // 文本 / 有媒体的消息都算「转达到了」；其余（voice、缺直链的 image…）如实标注类型。
    let handled = msgtype == "text" || !media.is_empty();
    let at = parsed
        .create_time
        .filter(|seconds| *seconds > 0)
        .map(|seconds| seconds.saturating_mul(1000))
        .unwrap_or(received_at);
    Some(WecomInboundDraft {
        msg_id: parsed.msgid,
        nick: peer_id.clone(),
        peer_id,
        sender_id: sender,
        text,
        unsupported: if handled { String::new() } else { msgtype },
        at,
        media,
    })
}

/// 图文混排里的文本项拼成正文。
fn mixed_text(mixed: &MixedBlock) -> String {
    mixed
        .msg_item
        .iter()
        .filter(|item| item.kind.as_deref() == Some("text"))
        .filter_map(|item| item.text.as_ref())
        .filter_map(|block| block.content.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// 从回调里挑出可下载的媒体（图片 / 文件 / 视频 / 图文混排里的图），最多 4 条。
fn pending_media(body: &CallbackBody) -> Vec<PendingMedia> {
    let mut out = Vec::new();
    if let Some(block) = body.image.as_ref() {
        push_pending(&mut out, block, MediaKind::Image);
    }
    if let Some(block) = body.video.as_ref() {
        push_pending(&mut out, block, MediaKind::File);
    }
    if let Some(block) = body.file.as_ref() {
        out.push(PendingMedia {
            url: block.url.clone().unwrap_or_default().trim().to_string(),
            aeskey: block.aeskey.clone(),
            kind: MediaKind::File,
            name: block
                .name
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("attachment")
                .to_string(),
            declared_size: block.size,
        });
    }
    if let Some(mixed) = body.mixed.as_ref() {
        for item in &mixed.msg_item {
            if item.kind.as_deref() == Some("image") {
                if let Some(block) = item.image.as_ref() {
                    push_pending(&mut out, block, MediaKind::Image);
                }
            }
        }
    }
    out.retain(|item| !item.url.is_empty());
    out.truncate(MAX_INBOUND_MEDIA);
    out
}

/// 把图片 / 视频块归一成待下载项（无直链的丢掉）。
fn push_pending(out: &mut Vec<PendingMedia>, block: &MediaBlock, kind: MediaKind) {
    let url = block.url.clone().unwrap_or_default().trim().to_string();
    if url.is_empty() {
        return;
    }
    out.push(PendingMedia {
        url,
        aeskey: block.aeskey.clone(),
        kind,
        name: "attachment".to_string(),
        declared_size: None,
    });
}

/// 文本净化：空文本拒绝，超长截断。
pub fn clamp_text(raw: &str) -> Result<String, String> {
    let text = raw.trim();
    if text.is_empty() {
        return Err("回复内容为空".into());
    }
    if text.chars().count() <= MAX_TEXT_CHARS {
        return Ok(text.to_string());
    }
    Ok(text.chars().take(MAX_TEXT_CHARS).collect())
}

/// 被动回复帧：必须透传回调的 req_id。
pub fn respond_frame(req_id: &str, text: &str) -> serde_json::Value {
    serde_json::json!({
        "cmd": "aibot_respond_msg",
        "headers": { "req_id": req_id },
        "body": { "msgtype": "text", "text": { "content": text } },
    })
}

/// 主动推送帧：只在没有回调凭据时用（要求对方先给机器人发过消息）。
/// 主动推送只支持 template_card / markdown，这里用 markdown 承载纯文本。
pub fn push_frame(scope: &ChatScope, id: &str, text: &str, req_id: &str) -> serde_json::Value {
    serde_json::json!({
        "cmd": "aibot_send_msg",
        "headers": { "req_id": req_id },
        "body": {
            "chatid": id,
            "chat_type": if *scope == ChatScope::Single { 1 } else { 2 },
            "msgtype": "markdown",
            "markdown": { "content": text },
        },
    })
}

/// 订阅帧。
pub fn subscribe_frame(bot_id: &str, secret: &str, req_id: &str) -> serde_json::Value {
    serde_json::json!({
        "cmd": "aibot_subscribe",
        "headers": { "req_id": req_id },
        "body": { "bot_id": bot_id, "secret": secret },
    })
}

/// 心跳帧。
pub fn ping_frame(req_id: &str) -> serde_json::Value {
    serde_json::json!({ "cmd": "ping", "headers": { "req_id": req_id } })
}

/* ===== 媒体：出站帧与上传体（纯函数，可单测） ===== */

/// 媒体消息体：`{msgtype: <type>, <type>: {media_id}}`（键名随类别变，故用 Map 拼）。
fn media_body(media_type: &str, media_id: &str) -> serde_json::Map<String, serde_json::Value> {
    let mut body = serde_json::Map::new();
    body.insert(
        "msgtype".into(),
        serde_json::Value::String(media_type.to_string()),
    );
    body.insert(
        media_type.into(),
        serde_json::json!({ "media_id": media_id }),
    );
    body
}

/// 媒体被动回复帧：msgtype 就是媒体类别（image），media_id 由上传换得。
pub fn respond_media_frame(req_id: &str, media_type: &str, media_id: &str) -> serde_json::Value {
    serde_json::json!({
        "cmd": RESPOND_CMD,
        "headers": { "req_id": req_id },
        "body": serde_json::Value::Object(media_body(media_type, media_id)),
    })
}

/// 媒体主动推送帧：与文本推送同形，只把 msgtype 换成媒体类别。
pub fn push_media_frame(
    scope: &ChatScope,
    id: &str,
    media_type: &str,
    media_id: &str,
    req_id: &str,
) -> serde_json::Value {
    let mut body = media_body(media_type, media_id);
    body.insert("chatid".into(), serde_json::Value::String(id.to_string()));
    body.insert(
        "chat_type".into(),
        serde_json::json!(if *scope == ChatScope::Single { 1 } else { 2 }),
    );
    serde_json::json!({
        "cmd": PUSH_CMD,
        "headers": { "req_id": req_id },
        "body": serde_json::Value::Object(body),
    })
}

/// 上传第一步的请求体。
pub fn upload_init_body(
    name: &str,
    media_type: &str,
    size: usize,
    total_chunks: usize,
    md5: &str,
) -> serde_json::Value {
    serde_json::json!({
        "filename": name,
        "type": media_type,
        "total_size": size,
        "total_chunks": total_chunks,
        "md5": md5,
    })
}

/// 上传第二步（每片）的请求体：分片原文 base64。
pub fn upload_chunk_body(
    upload_id: &str,
    index: usize,
    total_chunks: usize,
    base64_data: &str,
) -> serde_json::Value {
    serde_json::json!({
        "upload_id": upload_id,
        "chunk_index": index,
        "total_chunks": total_chunks,
        "base64_data": base64_data,
    })
}

/// 上传第三步（合并）的请求体。
pub fn upload_finish_body(upload_id: &str, name: &str, media_type: &str) -> serde_json::Value {
    serde_json::json!({
        "upload_id": upload_id,
        "filename": name,
        "media_type": media_type,
    })
}

/* ===== 媒体：入站解密（AES-256-CBC，密钥即 aeskey） ===== */

/// 小写十六进制（上传第一步要带的整文件 md5）。
fn md5_hex(bytes: &[u8]) -> String {
    use md5::Md5;
    use sha2::Digest as _;
    let mut hasher = Md5::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest.iter() {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// 解 aeskey：base64（长度非 4 的倍数时补齐 `=`），须解出 32 字节。
fn decode_aes_key(aes_key: &str) -> Result<Vec<u8>, String> {
    let raw = aes_key.trim();
    if raw.is_empty() {
        return Err("缺少 aeskey".into());
    }
    let padded = if raw.len().is_multiple_of(4) {
        raw.to_string()
    } else {
        format!("{raw}{}", "=".repeat(4 - raw.len() % 4))
    };
    let key = BASE64
        .decode(padded)
        .map_err(|_| "aeskey base64 解码失败".to_string())?;
    if key.len() != 32 {
        return Err("aeskey 不是 32 字节".into());
    }
    Ok(key)
}

/// 解密企业微信入站媒体：AES-256-CBC，IV 取密钥前 16 字节，PKCS#7 去填充。
///
/// 与官方 SDK（`download_file`）同一算法；`aes` 已是 `aes-gcm` 的传递依赖，这里不引新 crate。
pub fn decrypt_media(encrypted: &[u8], aes_key: &str) -> Result<Vec<u8>, String> {
    if encrypted.is_empty() {
        return Err("密文为空".into());
    }
    if !encrypted.len().is_multiple_of(16) {
        return Err("密文长度不是 16 的倍数".into());
    }
    let key = decode_aes_key(aes_key)?;
    let cipher = Aes256::new(GenericArray::from_slice(&key));
    let mut prev = [0u8; 16];
    prev.copy_from_slice(&key[..16]);
    let mut out = Vec::with_capacity(encrypted.len());
    for block in encrypted.as_chunks::<16>().0 {
        let mut buf = GenericArray::clone_from_slice(block);
        cipher.decrypt_block(&mut buf);
        for (index, byte) in buf.iter().enumerate() {
            out.push(byte ^ prev[index]);
        }
        prev.copy_from_slice(block);
    }
    unpad_pkcs7(out)
}

/// PKCS#7 去填充（块长 16）。
fn unpad_pkcs7(mut data: Vec<u8>) -> Result<Vec<u8>, String> {
    let pad = *data.last().ok_or("解密结果为空")? as usize;
    if pad == 0 || pad > 16 || pad > data.len() {
        return Err("PKCS#7 填充值非法".into());
    }
    if data[data.len() - pad..]
        .iter()
        .any(|byte| *byte as usize != pad)
    {
        return Err("PKCS#7 填充字节不一致".into());
    }
    data.truncate(data.len() - pad);
    Ok(data)
}

/// 请求回执判定：errcode 缺失或 0 视为成功。
fn frame_error(frame: &ServerFrame) -> Option<String> {
    match frame.errcode {
        Some(0) | None => None,
        Some(code) => Some(format!(
            "企业微信拒绝了请求（{code}）：{}",
            frame
                .errmsg
                .clone()
                .unwrap_or_else(|| "unknown error".into())
        )),
    }
}

/* ===== 宿主层：持久化 ===== */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredCredentials {
    pub bot_id: String,
    pub secret: String,
    #[serde(default)]
    pub saved_at: Option<String>,
}

/// 联系人档案 + 归属人 + 被动回复凭据（最近一次回调的 req_id）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerBook {
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub peers: BTreeMap<String, PeerRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerRecord {
    /// 最近一次回调的 req_id（被动回复凭据，24 小时内有效）。
    #[serde(default)]
    pub req_id: String,
    #[serde(default)]
    pub last_at: i64,
}

impl PeerBook {
    pub fn remember(&mut self, peer: &str, req_id: &str, at: i64) {
        let entry = self.peers.entry(peer.to_string()).or_insert(PeerRecord {
            req_id: req_id.to_string(),
            last_at: at,
        });
        if !req_id.is_empty() {
            entry.req_id = req_id.to_string();
        }
        entry.last_at = at;
    }

    /// 被动回复凭据（可能已过期，由服务端裁决）。
    pub fn reply_credential(&self, peer: &str) -> Option<String> {
        self.peers
            .get(peer)
            .map(|record| record.req_id.clone())
            .filter(|value| !value.is_empty())
    }

    pub fn claim_owner(&mut self, sender: &str) -> bool {
        if self.owner.is_some() {
            return false;
        }
        self.owner = Some(sender.to_string());
        true
    }

    pub fn allows(&self, sender: &str, allow_other_senders: bool) -> bool {
        allow_other_senders || self.owner.as_deref() == Some(sender)
    }
}

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

fn ensure_loaded(app: &AppHandle, inner: &mut Inner) -> Result<(), String> {
    if inner.loaded {
        return Ok(());
    }
    let dir = channel_dir(app, DIR_NAME)?;
    inner.credentials = read_json::<StoredCredentials>(&dir.join(CREDENTIALS_FILE))
        .filter(|item| !item.bot_id.trim().is_empty() && !item.secret.trim().is_empty());
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
    fn for_app(app: &AppHandle) -> Self {
        let handle = app.clone();
        let inbox = inbox_dir(app, DIR_NAME)
            .inspect_err(|error| log::warn("wecom", format!("收件目录不可用: {error}")))
            .ok();
        Self {
            sink: app_sink(app),
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

/* ===== 宿主层：连接主循环 ===== */

/// 一次连接的结局。
#[derive(Debug, PartialEq)]
pub(crate) enum LinkEnd {
    /// 被新连接踢掉（disconnected_event）：重连也没意义，等用户手动再连。
    TakenOver,
    Closed,
}

/// 建连 → 订阅 → 收发循环（可单测：url 是参数）。
pub(crate) async fn link_once(
    url: &str,
    deps: &LinkDeps,
    inner: &Mutex<Inner>,
    allow_other_senders: bool,
) -> Result<LinkEnd, String> {
    let credentials = {
        let mut guard = inner.lock().await;
        guard.loaded = true;
        guard
            .credentials
            .clone()
            .ok_or("尚未配置企业微信智能机器人 BotID / Secret")?
    };

    let (mut socket, _response) = tokio_tungstenite::connect_async(url)
        .await
        .map_err(|error| format!("WebSocket 建连失败: {error}"))?;

    // 订阅：拿 req_id 等一条回执（errcode != 0 即失败）。
    let subscribe_id = new_req_id();
    socket
        .send(Message::text(
            subscribe_frame(&credentials.bot_id, &credentials.secret, &subscribe_id).to_string(),
        ))
        .await
        .map_err(|error| format!("订阅帧发送失败: {error}"))?;
    let ack = wait_frame(&mut socket, |frame| {
        frame.headers.req_id.as_deref() == Some(subscribe_id.as_str())
    })
    .await?;
    if let Some(error) = frame_error(&ack) {
        return Err(error);
    }
    set_state(inner, deps, "connected", None).await;

    let (tx, mut rx) = mpsc::channel::<Outgoing>(32);
    {
        let mut guard = inner.lock().await;
        guard.outgoing = Some(tx);
    }
    let result = serve(&mut socket, &mut rx, deps, inner, allow_other_senders).await;
    {
        let mut guard = inner.lock().await;
        guard.outgoing = None;
    }
    result
}

/// 收发循环：发送请求等回执、处理回调、定期心跳。
async fn serve(
    socket: &mut WsStream,
    rx: &mut mpsc::Receiver<Outgoing>,
    deps: &LinkDeps,
    inner: &Mutex<Inner>,
    allow_other_senders: bool,
) -> Result<LinkEnd, String> {
    let mut ping = tokio::time::interval(PING_INTERVAL);
    ping.tick().await; // 跳过立即触发的首个 tick

    loop {
        tokio::select! {
            outgoing = rx.recv() => {
                let Some(outgoing) = outgoing else {
                    return Ok(LinkEnd::Closed);
                };
                if let Err(error) = socket.send(Message::text(outgoing.frame.to_string())).await {
                    if let Some(ack) = outgoing.ack {
                        let _ = ack.send(Err(format!("发送失败: {error}")));
                    }
                    return Err(format!("发送失败: {error}"));
                }
                if let (Some(ack), Some(req_id)) = (outgoing.ack, outgoing.req_id) {
                    // 等自己的回执：期间到达的回调照常处理。
                    match ack_with_callbacks(socket, &req_id, deps, inner, allow_other_senders).await {
                        Ok(body) => { let _ = ack.send(Ok(body)); }
                        Err(error) => {
                            let fatal = error.starts_with("__closed__");
                            let _ = ack.send(Err(error.trim_start_matches("__closed__").to_string()));
                            if fatal {
                                return Ok(LinkEnd::Closed);
                            }
                        }
                    }
                }
            }
            _ = ping.tick() => {
                let frame = ping_frame(&new_req_id());
                if let Err(error) = socket.send(Message::text(frame.to_string())).await {
                    return Err(format!("心跳发送失败: {error}"));
                }
            }
            incoming = socket.next() => {
                let Some(frame) = incoming else {
                    return Ok(LinkEnd::Closed);
                };
                match frame {
                    Ok(Message::Text(text)) => {
                        let parsed: ServerFrame = match serde_json::from_str(&text) {
                            Ok(parsed) => parsed,
                            Err(error) => {
                                log::warn("wecom", format!("长连接帧解析失败: {error}"));
                                continue;
                            }
                        };
                        if let Some(end) = handle_callback_frame(&parsed, deps, inner, allow_other_senders).await {
                            return Ok(end);
                        }
                    }
                    Ok(Message::Close(_)) => return Ok(LinkEnd::Closed),
                    Ok(_) => {}
                    Err(error) => return Err(format!("长连接读取失败: {error}")),
                }
            }
        }
    }
}

/// 等某条请求的回执；期间到达的回调照常分发（回调不能被回执等丢）。返回回执帧的 body。
async fn ack_with_callbacks(
    socket: &mut WsStream,
    req_id: &str,
    deps: &LinkDeps,
    inner: &Mutex<Inner>,
    allow_other_senders: bool,
) -> Result<serde_json::Value, String> {
    let deadline = tokio::time::Instant::now() + REQUEST_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err("等待企业微信回执超时".into());
        }
        let frame = tokio::time::timeout(remaining, next_text(socket))
            .await
            .map_err(|_| "等待企业微信回执超时".to_string())??;
        if frame.headers.req_id.as_deref() == Some(req_id) {
            return match frame_error(&frame) {
                Some(error) => Err(error),
                None => Ok(frame.body.unwrap_or(serde_json::Value::Null)),
            };
        }
        if let Some(end) = handle_callback_frame(&frame, deps, inner, allow_other_senders).await {
            // 连接被接管/关闭：让调用方也结束
            return Err(format!("__closed__{:?}", end));
        }
    }
}

/// 处理回调帧：消息入流、事件记账、被接管即结束。
async fn handle_callback_frame(
    frame: &ServerFrame,
    deps: &LinkDeps,
    inner: &Mutex<Inner>,
    allow_other_senders: bool,
) -> Option<LinkEnd> {
    let cmd = frame.cmd.as_deref()?;
    match cmd {
        "aibot_msg_callback" => {
            let body = frame.body.clone().unwrap_or(serde_json::Value::Null);
            let req_id = frame.headers.req_id.clone().unwrap_or_default();
            let Some(draft) = normalize_callback(&body, now_ms()) else {
                log::warn("wecom", "回调缺少发送者/会话标识，忽略");
                return None;
            };
            let (peers, allowed) = {
                let mut guard = inner.lock().await;
                guard.peers.claim_owner(&draft.sender_id);
                guard.peers.remember(&draft.peer_id, &req_id, draft.at);
                if guard
                    .last_message_at
                    .map(|last| draft.at > last)
                    .unwrap_or(true)
                {
                    guard.last_message_at = Some(draft.at);
                }
                let allowed = guard.peers.allows(&draft.sender_id, allow_other_senders);
                emit_state(&guard, deps);
                (guard.peers.clone(), allowed)
            };
            (deps.persist)(&peers);
            if !allowed {
                log::info(
                    "wecom",
                    format!(
                        "忽略非授权发送者 {}（可在设置中允许其他联系人）",
                        draft.sender_id
                    ),
                );
                return None;
            }
            // 媒体字节下载（并解密）进 inbox 后再广播（渲染端凭 path 取走）。
            let message = materialize_inbound(deps, draft).await;
            deps.emit(
                INBOUND_EVENT,
                serde_json::to_value(message).unwrap_or(serde_json::Value::Null),
            );
            None
        }
        "aibot_event_callback" => {
            let eventtype = frame
                .body
                .as_ref()
                .and_then(|body| serde_json::from_value::<CallbackBody>(body.clone()).ok())
                .and_then(|parsed| parsed.event)
                .and_then(|event| event.eventtype)
                .unwrap_or_default();
            match eventtype.as_str() {
                // 新连接完成订阅时旧连接会收到这条：不再重连，交给用户手动再连。
                "disconnected_event" => {
                    set_state(
                        inner,
                        deps,
                        "stopped",
                        Some("连接已被新的长连接接管".into()),
                    )
                    .await;
                    Some(LinkEnd::TakenOver)
                }
                "enter_chat" => {
                    log::info("wecom", "用户进入会话事件");
                    None
                }
                other => {
                    log::info("wecom", format!("忽略事件回调 {other}"));
                    None
                }
            }
        }
        other => {
            log::info("wecom", format!("忽略未处理的回调 cmd={other}"));
            None
        }
    }
}

/// 下载一条入站媒体（长连接模式给的是加密直链 + aeskey），解密后卡 20MB 上限。
async fn download_media(
    client: &reqwest::Client,
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
    let response = client
        .get(&pending.url)
        .send()
        .await
        .map_err(|error| format!("下载媒体请求失败: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("下载媒体返回 {status}"));
    }
    let bytes = tokio::time::timeout(RESPONSE_READ_TIMEOUT, response.bytes())
        .await
        .map_err(|_| "下载媒体读取超时".to_string())?
        .map_err(|error| format!("读取媒体字节失败: {error}"))?;
    let plain = match pending.aeskey.as_deref().map(str::trim) {
        Some(key) if !key.is_empty() => decrypt_media(&bytes, key)?,
        _ => bytes.to_vec(),
    };
    if plain.len() as u64 > MAX_MEDIA_BYTES {
        return Err(format!(
            "媒体超过 {} MB 上限",
            MAX_MEDIA_BYTES / (1024 * 1024)
        ));
    }
    Ok(plain)
}

/// 把入站草稿的媒体下载进 inbox（单条失败只记日志，不中断整轮）。
async fn materialize_inbound(deps: &LinkDeps, draft: WecomInboundDraft) -> WecomInboundDto {
    let WecomInboundDraft {
        msg_id,
        peer_id,
        nick,
        sender_id,
        text,
        unsupported,
        at,
        media,
    } = draft;
    let mut refs = Vec::new();
    if !media.is_empty() {
        match deps.inbox.as_deref() {
            None => log::warn("wecom", "收件目录不可用，丢弃入站媒体"),
            Some(inbox) => match shared_client(10) {
                Err(error) => log::warn("wecom", format!("下载媒体前建客户端失败: {error}")),
                Ok(client) => {
                    let received_at = now_ms();
                    for (index, pending) in media.iter().enumerate() {
                        match download_media(&client, pending).await {
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
                            Err(error) => log::warn("wecom", format!("入站媒体下载失败: {error}")),
                        }
                    }
                }
            },
        }
    }
    WecomInboundDto {
        msg_id,
        peer_id,
        nick,
        sender_id,
        text,
        unsupported,
        media: refs,
        at,
    }
}

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn next_text(socket: &mut WsStream) -> Result<ServerFrame, String> {
    loop {
        let frame = socket
            .next()
            .await
            .ok_or("长连接已关闭")?
            .map_err(|error| format!("长连接读取失败: {error}"))?;
        match frame {
            Message::Text(text) => {
                return serde_json::from_str(&text)
                    .map_err(|error| format!("长连接帧解析失败: {error}"));
            }
            Message::Close(_) => return Err("长连接已关闭".into()),
            _ => continue,
        }
    }
}

/// 等一条满足条件的帧（订阅回执用）。
async fn wait_frame(
    socket: &mut WsStream,
    predicate: impl Fn(&ServerFrame) -> bool,
) -> Result<ServerFrame, String> {
    let deadline = tokio::time::Instant::now() + REQUEST_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err("等待企业微信回执超时".into());
        }
        let frame = tokio::time::timeout(remaining, next_text(socket))
            .await
            .map_err(|_| "等待企业微信回执超时".to_string())??;
        if predicate(&frame) {
            return Ok(frame);
        }
        // 订阅阶段不该有别的帧；真有就记一笔继续等。
        log::info("wecom", "订阅等待期间收到其它帧，继续等待回执");
    }
}

/// 指数退避（1s → 60s）。
fn reconnect_delay(attempt: u32) -> Duration {
    let seconds = 1u64 << attempt.min(6);
    Duration::from_secs(seconds.min(60))
}

/// 请求 id：时间戳 + 自增序号，够用且可读（官方只要求同一连接内唯一）。
fn new_req_id() -> String {
    use std::sync::atomic::AtomicU64 as IdCounter;
    static COUNTER: IdCounter = IdCounter::new(0);
    format!(
        "gw-{}-{}",
        now_ms(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

async fn run_link(deps: LinkDeps, inner: Arc<Mutex<Inner>>, epochs: Arc<AtomicU64>, epoch: u64) {
    let mut attempt: u32 = 0;
    log::info("wecom", "智能机器人长连接启动");
    while epochs.load(Ordering::SeqCst) == epoch {
        match link_once(WS_URL, &deps, &inner, deps.allow_other_senders).await {
            Ok(end) => {
                log::info("wecom", format!("长连接结束: {end:?}"));
                if end == LinkEnd::TakenOver {
                    return; // 被接管：不再自动重连（会把对方踢掉，来回抢）
                }
                attempt = 0;
            }
            Err(error) => {
                attempt = attempt.saturating_add(1);
                log::warn("wecom", format!("长连接异常({attempt}): {error}"));
                set_state(&inner, &deps, "error", Some(error)).await;
            }
        }
        if !sleep_or_stop(&epochs, epoch, reconnect_delay(attempt)).await {
            break;
        }
        set_state(&inner, &deps, "connecting", None).await;
    }
    log::info("wecom", "智能机器人长连接已停止");
}

/* ===== 宿主层：Tauri 命令 ===== */

/// 当前通道状态（是否已配置凭证、长连接状态、已建档联系人数）。
#[tauri::command]
pub async fn wecom_status(
    app: AppHandle,
    host: State<'_, WecomHost>,
) -> Result<WecomStatusDto, String> {
    let mut inner = host.lock().await;
    ensure_loaded(&app, &mut inner)?;
    Ok(inner.status())
}

/// 保存 BotID / Secret（Secret 留空表示沿用已存密钥）。
#[tauri::command]
pub async fn wecom_save_credentials(
    app: AppHandle,
    host: State<'_, WecomHost>,
    bot_id: String,
    secret: Option<String>,
) -> Result<WecomStatusDto, String> {
    let bot_id = bot_id.trim().to_string();
    if bot_id.is_empty() {
        return Err("BotID 不能为空".into());
    }
    let mut inner = host.lock().await;
    ensure_loaded(&app, &mut inner)?;
    let secret = secret
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| inner.credentials.as_ref().map(|item| item.secret.clone()));
    let Some(secret) = secret else {
        return Err("Secret 不能为空".into());
    };
    let credentials = StoredCredentials {
        bot_id,
        secret,
        saved_at: Some(chrono::Utc::now().to_rfc3339()),
    };
    let dir = channel_dir(&app, DIR_NAME)?;
    let bytes = serde_json::to_vec_pretty(&credentials)
        .map_err(|error| format!("凭证序列化失败: {error}"))?;
    write_private(&dir.join(CREDENTIALS_FILE), &bytes)?;
    inner.credentials = Some(credentials);
    inner.detail = None;
    log::info("wecom", "BotID / Secret 已保存");
    Ok(inner.status())
}

/// 清除凭证与联系人凭据（相当于退出登录）。
#[tauri::command]
pub async fn wecom_clear_credentials(
    app: AppHandle,
    host: State<'_, WecomHost>,
) -> Result<WecomStatusDto, String> {
    host.epoch.fetch_add(1, Ordering::SeqCst);
    let mut inner = host.lock().await;
    ensure_loaded(&app, &mut inner)?;
    inner.credentials = None;
    inner.peers = PeerBook::default();
    inner.outgoing = None;
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
    log::info("wecom", "凭证已清除");
    prune_inbox(&app, DIR_NAME, true);
    Ok(inner.status())
}

/// 启动长连接（未配置凭证时报错，由界面引导去填）。
#[tauri::command]
pub async fn wecom_connect(
    app: AppHandle,
    host: State<'_, WecomHost>,
    allow_other_senders: bool,
) -> Result<(), String> {
    {
        let mut inner = host.lock().await;
        ensure_loaded(&app, &mut inner)?;
        if inner.credentials.is_none() {
            return Err("尚未配置企业微信智能机器人 BotID / Secret".into());
        }
        inner.state = "connecting".into();
        inner.detail = None;
    }
    let epoch = host.epoch.fetch_add(1, Ordering::SeqCst) + 1;
    // 上次会话遗留的未取走收件文件先清掉（渲染端崩溃 / 未取走）。
    prune_inbox(&app, DIR_NAME, false);
    let inner = host.inner.clone();
    let epochs = host.epoch.clone();
    let mut deps = LinkDeps::for_app(&app);
    deps.allow_other_senders = allow_other_senders;
    set_state(&inner, &deps, "connecting", None).await;
    tauri::async_runtime::spawn(async move {
        run_link(deps, inner, epochs, epoch).await;
    });
    Ok(())
}

/// 停止长连接（保留凭证与联系人凭据）。
#[tauri::command]
pub async fn wecom_disconnect(app: AppHandle, host: State<'_, WecomHost>) -> Result<(), String> {
    host.epoch.fetch_add(1, Ordering::SeqCst);
    let mut inner = host.lock().await;
    ensure_loaded(&app, &mut inner)?;
    let deps = LinkDeps::for_app(&app);
    inner.outgoing = None;
    inner.state = "stopped".into();
    inner.detail = None;
    emit_state(&inner, &deps);
    Ok(())
}

/// 回一条文本：优先被动回复（带该会话最近回调的 req_id），没有凭据则主动推送。
#[tauri::command]
pub async fn wecom_send(
    app: AppHandle,
    host: State<'_, WecomHost>,
    peer_id: String,
    text: String,
) -> Result<(), String> {
    let text = clamp_text(&text)?;
    let (scope, id) =
        decode_peer(&peer_id).ok_or_else(|| format!("对端 id 无法解析: {peer_id:?}"))?;
    let (sender, credential) = {
        let mut inner = host.lock().await;
        ensure_loaded(&app, &mut inner)?;
        let sender = inner
            .outgoing
            .clone()
            .ok_or("通道未连接：先连接企业微信通道再发送")?;
        (sender, inner.peers.reply_credential(&peer_id))
    };
    // 有回调凭据就走被动回复（保真、不占主动推送额度）；没有才退回主动推送。
    let (frame, req_id) = match credential {
        Some(req_id) => (respond_frame(&req_id, &text), req_id),
        None => {
            let req_id = new_req_id();
            (push_frame(&scope, &id, &text, &req_id), req_id)
        }
    };
    send_frame(&sender, frame, req_id).await.map(|_| ())
}

/// 发一个已拼好的帧并等它自己的回执（期间到达的回调照常处理），返回回执帧的 body。
async fn send_frame(
    sender: &mpsc::Sender<Outgoing>,
    frame: serde_json::Value,
    req_id: String,
) -> Result<serde_json::Value, String> {
    let (ack_tx, ack_rx) = oneshot::channel();
    sender
        .send(Outgoing {
            frame,
            ack: Some(ack_tx),
            req_id: Some(req_id),
        })
        .await
        .map_err(|_| "长连接已断开".to_string())?;
    ack_rx.await.map_err(|_| "长连接已断开".to_string())?
}

/// 发一个「命令 + body」请求（req_id 自动生成），返回回执 body。媒体上传三步用它。
async fn request(
    sender: &mpsc::Sender<Outgoing>,
    cmd: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let req_id = new_req_id();
    let frame = serde_json::json!({
        "cmd": cmd,
        "headers": { "req_id": req_id.clone() },
        "body": body,
    });
    send_frame(sender, frame, req_id).await
}

/// 上传一条本地媒体换 `media_id`：init → 分片 × N → finish（同一长连接上三步请求）。
async fn upload_media(
    sender: &mpsc::Sender<Outgoing>,
    media: &OutboundMedia,
    media_type: &str,
) -> Result<String, String> {
    if media.bytes.is_empty() {
        return Err("不能发送空文件".into());
    }
    let total_chunks = media.bytes.len().div_ceil(UPLOAD_CHUNK_SIZE);
    let init = request(
        sender,
        UPLOAD_INIT_CMD,
        upload_init_body(
            &media.name,
            media_type,
            media.bytes.len(),
            total_chunks,
            &md5_hex(&media.bytes),
        ),
    )
    .await?;
    let upload_id = init
        .get("upload_id")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "媒体上传缺少 upload_id".to_string())?
        .to_string();
    for (index, chunk) in media.bytes.chunks(UPLOAD_CHUNK_SIZE).enumerate() {
        request(
            sender,
            UPLOAD_CHUNK_CMD,
            upload_chunk_body(&upload_id, index, total_chunks, &BASE64.encode(chunk)),
        )
        .await?;
    }
    let finish = request(
        sender,
        UPLOAD_FINISH_CMD,
        upload_finish_body(&upload_id, &media.name, media_type),
    )
    .await?;
    finish
        .get("media_id")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "媒体上传缺少 media_id".to_string())
}

/// 发一条媒体：先上传换 `media_id`，再被动回复（有 req_id）或主动推送。
///
/// 企业微信出站只有图片出口（图文混排），文件出口不存在 —— 能力矩阵已拦文件，这里再兜一层。
pub(crate) async fn send_media_impl(
    app: &AppHandle,
    peer_id: &str,
    media: OutboundMedia,
) -> Result<(), String> {
    if media.kind != MediaKind::Image {
        return Err("企业微信只能发送图片".into());
    }
    let (scope, id) =
        decode_peer(peer_id).ok_or_else(|| format!("对端 id 无法解析: {peer_id:?}"))?;
    let (sender, credential) = {
        let host = app.state::<WecomHost>();
        let mut inner = host.lock().await;
        ensure_loaded(app, &mut inner)?;
        let sender = inner
            .outgoing
            .clone()
            .ok_or("通道未连接：先连接企业微信通道再发送")?;
        (sender, inner.peers.reply_credential(peer_id))
    };
    let media_id = upload_media(&sender, &media, MEDIA_TYPE_IMAGE).await?;
    match credential {
        Some(req_id) => {
            let frame = respond_media_frame(&req_id, MEDIA_TYPE_IMAGE, &media_id);
            send_frame(&sender, frame, req_id).await.map(|_| ())
        }
        None => {
            let req_id = new_req_id();
            let frame = push_media_frame(&scope, &id, MEDIA_TYPE_IMAGE, &media_id, &req_id);
            send_frame(&sender, frame, req_id).await.map(|_| ())
        }
    }
}

/* ===== 单测（纯函数） ===== */

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn peer_id_roundtrip_by_scope() {
        assert_eq!(encode_peer(&ChatScope::Single, "u1"), "single:u1");
        assert_eq!(encode_peer(&ChatScope::Group, "c1"), "group:c1");
        assert_eq!(
            decode_peer("single:u1"),
            Some((ChatScope::Single, "u1".into()))
        );
        assert_eq!(
            decode_peer("group:c1"),
            Some((ChatScope::Group, "c1".into()))
        );
        assert_eq!(decode_peer("u1"), None);
        assert_eq!(decode_peer("dm:u1"), None);
        assert_eq!(decode_peer("single:"), None);
    }

    #[test]
    fn normalize_single_chat_message() {
        let body = json!({
            "msgid": "MSG1",
            "create_time": 1700000000,
            "chattype": "single",
            "from": { "userid": "zhangsan" },
            "msgtype": "text",
            "text": { "content": "你好" },
        });
        let inbound = normalize_callback(&body, 999).expect("单聊消息");
        assert_eq!(inbound.peer_id, "single:zhangsan");
        assert_eq!(inbound.sender_id, "zhangsan");
        assert_eq!(inbound.text, "你好");
        assert_eq!(inbound.unsupported, "");
        assert_eq!(inbound.at, 1_700_000_000_000);
    }

    #[test]
    fn normalize_group_message_keeps_chatid_as_peer() {
        let body = json!({
            "msgid": "MSG2",
            "chatid": "CHAT1",
            "chattype": "group",
            "from": { "userid": "lisi" },
            "msgtype": "text",
            "text": { "content": "@RobotA 干活" },
        });
        let inbound = normalize_callback(&body, 1_700_000_000_500).expect("群消息");
        assert_eq!(inbound.peer_id, "group:CHAT1", "回发要回群");
        assert_eq!(inbound.sender_id, "lisi", "归属人按发送者判");
        assert_eq!(inbound.at, 1_700_000_000_500, "缺时间戳时用收包时间");
    }

    #[test]
    fn normalize_marks_non_text_and_rejects_incomplete() {
        let image = json!({
            "msgid": "MSG3",
            "chattype": "single",
            "from": { "userid": "u" },
            "msgtype": "image",
        });
        let inbound = normalize_callback(&image, 1).expect("图片消息也要如实转达");
        assert_eq!(inbound.text, "");
        assert_eq!(inbound.unsupported, "image");

        assert!(
            normalize_callback(&json!({ "msgid": "M", "chattype": "single" }), 1).is_none(),
            "缺发送者"
        );
        assert!(
            normalize_callback(
                &json!({ "msgid": "M", "chattype": "group", "from": { "userid": "u" } }),
                1
            )
            .is_none(),
            "群消息缺 chatid 无从回发"
        );
    }

    #[test]
    fn frames_carry_required_fields() {
        let subscribe = subscribe_frame("BOT", "SECRET", "req-1");
        assert_eq!(subscribe["cmd"], "aibot_subscribe");
        assert_eq!(subscribe["body"]["bot_id"], "BOT");
        assert_eq!(subscribe["headers"]["req_id"], "req-1");

        let respond = respond_frame("req-2", "hi");
        assert_eq!(respond["cmd"], "aibot_respond_msg");
        assert_eq!(respond["headers"]["req_id"], "req-2", "必须透传回调 req_id");
        assert_eq!(respond["body"]["msgtype"], "text");
        assert_eq!(respond["body"]["text"]["content"], "hi");

        let push = push_frame(&ChatScope::Group, "CHAT1", "hi", "req-3");
        assert_eq!(push["cmd"], "aibot_send_msg");
        assert_eq!(push["body"]["chatid"], "CHAT1");
        assert_eq!(push["body"]["chat_type"], 2);
        assert_eq!(push["body"]["msgtype"], "markdown");
        let push_single = push_frame(&ChatScope::Single, "u1", "hi", "req-4");
        assert_eq!(push_single["body"]["chat_type"], 1);

        assert_eq!(ping_frame("req-5")["cmd"], "ping");
    }

    #[test]
    fn frame_error_reads_errcode() {
        let ok: ServerFrame =
            serde_json::from_value(json!({ "errcode": 0, "errmsg": "ok" })).unwrap();
        assert!(frame_error(&ok).is_none());
        let missing: ServerFrame = serde_json::from_value(json!({})).unwrap();
        assert!(frame_error(&missing).is_none(), "没有 errcode 视为成功");
        let failed: ServerFrame =
            serde_json::from_value(json!({ "errcode": 40001, "errmsg": "invalid secret" }))
                .unwrap();
        let error = frame_error(&failed).expect("非 0 即错误");
        assert!(error.contains("40001") && error.contains("invalid secret"));
    }

    #[test]
    fn peer_book_tracks_reply_credential_and_owner() {
        let mut book = PeerBook::default();
        book.remember("single:u1", "req-1", 10);
        assert_eq!(book.reply_credential("single:u1").as_deref(), Some("req-1"));
        book.remember("single:u1", "", 20);
        assert_eq!(
            book.reply_credential("single:u1").as_deref(),
            Some("req-1"),
            "空 req_id 不覆盖旧凭据"
        );
        assert_eq!(book.reply_credential("single:u2"), None);

        assert!(book.claim_owner("u1"));
        assert!(!book.claim_owner("u2"));
        assert!(book.allows("u1", false));
        assert!(!book.allows("u2", false));
        assert!(book.allows("u2", true));
    }

    #[test]
    fn text_clamp_rejects_empty_and_truncates() {
        assert!(clamp_text("  ").is_err());
        let long: String = "字".repeat(MAX_TEXT_CHARS + 1);
        assert_eq!(clamp_text(&long).unwrap().chars().count(), MAX_TEXT_CHARS);
    }

    #[test]
    fn req_ids_are_unique_per_call() {
        let a = new_req_id();
        let b = new_req_id();
        assert_ne!(a, b);
        assert!(a.starts_with("gw-"));
    }

    #[test]
    fn ws_url_is_the_official_long_connection_endpoint() {
        assert_eq!(WS_URL, "wss://openws.work.weixin.qq.com");
    }

    #[test]
    fn normalize_extracts_media_from_image_file_and_mixed() {
        let image = json!({
            "msgid": "M1", "chattype": "single", "from": { "userid": "u" },
            "msgtype": "image",
            "image": { "url": "https://cdn/1", "aeskey": "K1" },
        });
        let draft = normalize_callback(&image, 1).expect("图片消息");
        assert_eq!(draft.unsupported, "", "有可下载媒体的消息不算 unsupported");
        assert_eq!(draft.media.len(), 1);
        assert_eq!(draft.media[0].kind, MediaKind::Image);
        assert_eq!(draft.media[0].url, "https://cdn/1");
        assert_eq!(draft.media[0].aeskey.as_deref(), Some("K1"));

        let file = json!({
            "msgid": "M2", "chattype": "single", "from": { "userid": "u" },
            "msgtype": "file",
            "file": { "url": "https://cdn/2", "aeskey": "K2", "name": "报表.pdf", "size": 99 },
        });
        let draft = normalize_callback(&file, 1).expect("文件消息");
        assert_eq!(draft.media.len(), 1);
        assert_eq!(draft.media[0].kind, MediaKind::File);
        assert_eq!(draft.media[0].name, "报表.pdf");
        assert_eq!(draft.media[0].declared_size, Some(99));

        let mixed = json!({
            "msgid": "M3", "chattype": "single", "from": { "userid": "u" },
            "msgtype": "mixed",
            "mixed": { "msg_item": [
                { "type": "text", "text": { "content": "看这张" } },
                { "type": "image", "image": { "url": "https://cdn/3", "aeskey": "K3" } },
            ] },
        });
        let draft = normalize_callback(&mixed, 1).expect("图文混排");
        assert_eq!(draft.text, "看这张", "图文混排的文本项也当正文");
        assert_eq!(draft.media.len(), 1);
        assert_eq!(draft.media[0].kind, MediaKind::Image);
    }

    #[test]
    fn pending_media_drops_empty_urls_and_caps() {
        let body = CallbackBody {
            image: Some(MediaBlock {
                url: Some("   ".into()),
                aeskey: None,
            }),
            ..CallbackBody::default()
        };
        assert!(pending_media(&body).is_empty(), "空直链丢掉");

        let items: Vec<MixedItem> = (0..(MAX_INBOUND_MEDIA + 2))
            .map(|index| MixedItem {
                kind: Some("image".into()),
                image: Some(MediaBlock {
                    url: Some(format!("https://cdn/{index}")),
                    aeskey: None,
                }),
                ..MixedItem::default()
            })
            .collect();
        let body = CallbackBody {
            mixed: Some(MixedBlock { msg_item: items }),
            ..CallbackBody::default()
        };
        assert_eq!(pending_media(&body).len(), MAX_INBOUND_MEDIA);
    }

    /// 按服务端口径加密一份媒体：AES-256-CBC，IV 取密钥前 16 字节，PKCS#7 填充。
    fn encrypt_media(plain: &[u8], key: &[u8; 32]) -> Vec<u8> {
        use aes::cipher::BlockEncrypt;
        let cipher = Aes256::new(GenericArray::from_slice(key));
        let pad = 16 - (plain.len() % 16);
        let mut padded = plain.to_vec();
        for _ in 0..pad {
            padded.push(pad as u8);
        }
        let mut prev = [0u8; 16];
        prev.copy_from_slice(&key[..16]);
        let mut out = Vec::with_capacity(padded.len());
        for block in padded.as_chunks::<16>().0 {
            let mut buf = GenericArray::clone_from_slice(block);
            for (index, byte) in buf.iter_mut().enumerate() {
                *byte ^= prev[index];
            }
            cipher.encrypt_block(&mut buf);
            out.extend_from_slice(&buf);
            prev.copy_from_slice(&buf);
        }
        out
    }

    #[test]
    fn decrypt_media_roundtrips_aes_256_cbc() {
        let key = [7u8; 32];
        let encoded = BASE64.encode(key);
        let plain = b"hello wecom media".to_vec();
        let encrypted = encrypt_media(&plain, &key);
        assert_eq!(decrypt_media(&encrypted, &encoded).unwrap(), plain);

        // 真实形状：43 字符、不带 `=` 的 aeskey 也要能解。
        let trimmed = encoded.trim_end_matches('=');
        assert_eq!(trimmed.len(), 43);
        assert_eq!(decrypt_media(&encrypted, trimmed).unwrap(), plain);

        // 密文长度不是 16 的倍数 / 缺密钥 → 报错而不是给出乱码。
        assert!(decrypt_media(&encrypted[..encrypted.len() - 1], &encoded).is_err());
        assert!(decrypt_media(&encrypted, "  ").is_err());
        assert!(
            decrypt_media(&encrypted, &BASE64.encode([9u8; 16])).is_err(),
            "密钥长度不对"
        );
    }

    #[test]
    fn md5_hex_matches_known_vector() {
        assert_eq!(md5_hex(b"abc"), "900150983cd24fb0d6963f7d28e17f72");
    }

    #[test]
    fn media_frames_carry_media_id() {
        let respond = respond_media_frame("req-1", MEDIA_TYPE_IMAGE, "MID");
        assert_eq!(respond["cmd"], "aibot_respond_msg");
        assert_eq!(respond["headers"]["req_id"], "req-1", "必须透传回调 req_id");
        assert_eq!(respond["body"]["msgtype"], "image");
        assert_eq!(respond["body"]["image"]["media_id"], "MID");

        let push = push_media_frame(&ChatScope::Group, "CHAT1", MEDIA_TYPE_IMAGE, "MID", "req-2");
        assert_eq!(push["cmd"], "aibot_send_msg");
        assert_eq!(push["body"]["chatid"], "CHAT1");
        assert_eq!(push["body"]["chat_type"], 2);
        assert_eq!(push["body"]["msgtype"], "image");
        assert_eq!(push["body"]["image"]["media_id"], "MID");
    }

    #[test]
    fn upload_bodies_carry_required_fields() {
        let init = upload_init_body("a.png", MEDIA_TYPE_IMAGE, 1024, 1, "deadbeef");
        assert_eq!(init["filename"], "a.png");
        assert_eq!(init["type"], "image");
        assert_eq!(init["total_size"], 1024);
        assert_eq!(init["total_chunks"], 1);
        assert_eq!(init["md5"], "deadbeef");

        let chunk = upload_chunk_body("UP1", 0, 2, "QUJD");
        assert_eq!(chunk["upload_id"], "UP1");
        assert_eq!(chunk["chunk_index"], 0);
        assert_eq!(chunk["total_chunks"], 2);
        assert_eq!(chunk["base64_data"], "QUJD");

        let finish = upload_finish_body("UP1", "a.png", MEDIA_TYPE_IMAGE);
        assert_eq!(finish["upload_id"], "UP1");
        assert_eq!(finish["filename"], "a.png");
        assert_eq!(finish["media_type"], "image");
    }
}
