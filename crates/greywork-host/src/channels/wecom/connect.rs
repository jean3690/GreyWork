use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_tungstenite::tungstenite::Message;

use crate::channel_common::{now_ms, sleep_or_stop};
use crate::channel_media::{store_inbound_media, OutboundMedia, MAX_MEDIA_BYTES};
use crate::http::{shared_client, RESPONSE_READ_TIMEOUT};
use crate::log;

use super::protocol::*;
use super::*;

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
pub(super) fn new_req_id() -> String {
    use std::sync::atomic::AtomicU64 as IdCounter;
    static COUNTER: IdCounter = IdCounter::new(0);
    format!(
        "gw-{}-{}",
        now_ms(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

pub(super) async fn run_link(
    deps: LinkDeps,
    inner: Arc<Mutex<Inner>>,
    epochs: Arc<AtomicU64>,
    epoch: u64,
) {
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

/// 发一个已拼好的帧并等它自己的回执（期间到达的回调照常处理），返回回执帧的 body。
pub(super) async fn send_frame(
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
pub(super) async fn request(
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
pub(super) async fn upload_media(
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
