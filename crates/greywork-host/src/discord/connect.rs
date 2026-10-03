use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message;

use crate::channel_common::{now_ms, sleep_or_stop};
use crate::channel_media::{store_inbound_media, MAX_MEDIA_BYTES};
use crate::http::{read_text, shared_client, RESPONSE_READ_TIMEOUT};
use crate::log;

use super::commands::*;
use super::protocol::*;
use super::*;

/* ===== 宿主层：HTTP（探针、网关地址、发消息） ===== */

/// 探针：确认 token 有效并取回 bot 身份（保存凭证前跑一次，比「填完连不上」友好）。
pub(super) async fn probe_bot_user(
    client: &reqwest::Client,
    token: &str,
) -> Result<BotUser, String> {
    let response = client
        .get(format!("{API_BASE}/users/@me"))
        .header("Authorization", auth_header(token))
        .send()
        .await
        .map_err(|error| format!("校验 bot token 失败: {error}"))?;
    let status = response.status();
    let body = read_text(response, RESPONSE_READ_TIMEOUT)
        .await
        .map_err(|error| format!("校验响应读取失败: {error}"))?;
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(
            "Discord 拒绝这枚 token（401）：请确认复制的是 Bot token，必要时在门户里 Reset Token"
                .into(),
        );
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err("Discord 限流（429）：稍后再试".into());
    }
    if !status.is_success() {
        return Err(format!("校验 bot token 返回 {status}: {}", brief(&body)));
    }
    let parsed: BotUser =
        serde_json::from_str(&body).map_err(|error| format!("校验响应解析失败: {error}"))?;
    if parsed.id.trim().is_empty() {
        return Err("校验响里没有 bot 用户 id".into());
    }
    Ok(parsed)
}

/// 取网关地址（`GET /gateway/bot`）。
pub(crate) async fn gateway_url(client: &reqwest::Client, token: &str) -> Result<String, String> {
    let response = client
        .get(format!("{API_BASE}/gateway/bot"))
        .header("Authorization", auth_header(token))
        .send()
        .await
        .map_err(|error| format!("取网关地址失败: {error}"))?;
    let status = response.status();
    let body = read_text(response, RESPONSE_READ_TIMEOUT)
        .await
        .map_err(|error| format!("网关地址响应读取失败: {error}"))?;
    if !status.is_success() {
        return Err(format!("取网关地址返回 {status}: {}", brief(&body)));
    }
    let parsed: GatewayResponse =
        serde_json::from_str(&body).map_err(|error| format!("网关地址响应解析失败: {error}"))?;
    parsed
        .url
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            format!(
                "网关地址不可用：{}",
                parsed.message.unwrap_or_else(|| "响应里没有 url".into())
            )
        })
}

/// 往私聊频道发一条文本。
pub(crate) async fn send_text(
    client: &reqwest::Client,
    token: &str,
    peer_id: &str,
    text: &str,
) -> Result<(), String> {
    let channel_id =
        decode_peer(peer_id).ok_or_else(|| format!("对端 id 无法解析: {peer_id:?}"))?;
    let response = client
        .post(format!("{API_BASE}/channels/{channel_id}/messages"))
        .header("Authorization", auth_header(token))
        .json(&serde_json::json!({ "content": text }))
        .send()
        .await
        .map_err(|error| format!("发送消息失败: {error}"))?;
    let status = response.status();
    let body = read_text(response, RESPONSE_READ_TIMEOUT)
        .await
        .map_err(|error| format!("发送响应读取失败: {error}"))?;
    if status.is_success() {
        return Ok(());
    }
    if status == reqwest::StatusCode::FORBIDDEN {
        return Err(
            "Discord 拒绝了这条消息（403）：私聊需要对方先发起过会话，且不能给已拉黑机器人的用户发"
                .into(),
        );
    }
    Err(format!("发送消息返回 {status}: {}", brief(&body)))
}

/* ===== 宿主层：网关主循环 ===== */

/// 一次连接的结果。
#[derive(Debug, PartialEq)]
pub(crate) enum GatewayEnd {
    /// 可重连（断线 / op 7 / op 9 可恢复）。
    Reconnect,
    /// 对端正常关闭。
    Closed,
    /// 致命错误：重试无用，停下等用户改配置。
    Fatal(String),
}

/// 建连 → hello → identify/resume → 收帧直到断开。
pub(crate) async fn gateway_once(
    url: &str,
    token: &str,
    deps: &GatewayDeps,
    inner: &Mutex<Inner>,
) -> Result<GatewayEnd, String> {
    let (mut socket, _response) = tokio_tungstenite::connect_async(url)
        .await
        .map_err(|error| format!("WebSocket 建连失败: {error}"))?;

    // 有会话就 resume（官方建议 resume 时改用 ready 给的 resume_gateway_url，由调用方负责）。
    let resume = {
        let guard = inner.lock().await;
        guard
            .session_id
            .clone()
            .filter(|value| !value.is_empty())
            .map(|session_id| (session_id, guard.last_seq.unwrap_or(0)))
    };

    // 第一帧应是 hello（op 10），拿心跳间隔。
    let hello = next_text(&mut socket).await?;
    let hello: GatewayFrame =
        serde_json::from_str(&hello).map_err(|error| format!("网关 hello 解析失败: {error}"))?;
    if hello.op != 10 {
        return Err(format!("网关首帧不是 hello（op={}）", hello.op));
    }
    let interval = hello
        .d
        .as_ref()
        .and_then(|data| data.get("heartbeat_interval"))
        .and_then(serde_json::Value::as_u64)
        .filter(|value| *value > 0)
        .map(Duration::from_millis)
        .unwrap_or(FALLBACK_HEARTBEAT);

    let auth = match resume {
        Some((session_id, seq)) => resume_frame(token, &session_id, seq),
        None => identify_frame(token, INTENTS_DIRECT_MESSAGES),
    };
    socket
        .send(Message::text(auth.to_string()))
        .await
        .map_err(|error| format!("鉴权帧发送失败: {error}"))?;
    set_state(inner, deps, "connected", None).await;

    let mut heartbeat_task = tokio::time::interval(interval);
    heartbeat_task.tick().await; // 跳过立即触发的首个 tick
                                 // 上一拍心跳是否还没等到 ACK：没等到说明连接已经「僵尸」，必须重连。
    let mut pending_ack: Option<Instant> = None;

    loop {
        tokio::select! {
            _ = heartbeat_task.tick() => {
                if pending_ack.map(|sent| sent.elapsed() >= interval).unwrap_or(false) {
                    return Err("心跳未收到 ACK，连接已失效".into());
                }
                let seq = { inner.lock().await.last_seq };
                let payload = heartbeat_frame(seq);
                if let Err(error) = socket.send(Message::text(payload.to_string())).await {
                    return Err(format!("心跳发送失败: {error}"));
                }
                pending_ack = Some(Instant::now());
            }
            incoming = socket.next() => {
                let Some(frame) = incoming else {
                    return Ok(GatewayEnd::Closed);
                };
                let raw = match frame {
                    Ok(Message::Text(text)) => text.to_string(),
                    Ok(Message::Close(frame)) => {
                        let code = frame.map(|item| u16::from(item.code));
                        return Ok(match classify_close(code) {
                            CloseAction::Fatal => GatewayEnd::Fatal(match code {
                                Some(code) => format!("Discord 关闭连接 {code}（{}）", close_hint(code)),
                                None => "Discord 关闭连接（原因未知）".into(),
                            }),
                            CloseAction::Reidentify => {
                                inner.lock().await.forget_session();
                                GatewayEnd::Reconnect
                            }
                            CloseAction::Resume => GatewayEnd::Reconnect,
                        });
                    }
                    Ok(_) => continue,
                    Err(error) => return Err(format!("网关读取失败: {error}")),
                };
                let parsed: GatewayFrame = match serde_json::from_str(&raw) {
                    Ok(parsed) => parsed,
                    Err(error) => {
                        log::warn("discord", format!("网关帧解析失败: {error}"));
                        continue;
                    }
                };
                match parsed.op {
                    // 事件下发
                    0 => {
                        if let Some(seq) = parsed.s {
                            let mut guard = inner.lock().await;
                            guard.last_seq = Some(seq);
                        }
                        if let Some(kind) = parsed.t.as_deref() {
                            match kind {
                                "READY" => {
                                    let data = parsed.d.as_ref();
                                    let mut guard = inner.lock().await;
                                    guard.session_id = data
                                        .and_then(|item| item.get("session_id"))
                                        .and_then(serde_json::Value::as_str)
                                        .map(|value| value.to_string());
                                    guard.resume_url = data
                                        .and_then(|item| item.get("resume_gateway_url"))
                                        .and_then(serde_json::Value::as_str)
                                        .map(|value| value.to_string());
                                    guard.last_seq = None;
                                    drop(guard);
                                    set_state(inner, deps, "connected", None).await;
                                }
                                "RESUMED" => set_state(inner, deps, "connected", None).await,
                                _ => {
                                    if let Some(data) = parsed.d.as_ref() {
                                        handle_dispatch(kind, data, deps, inner).await;
                                    }
                                }
                            }
                        }
                    }
                    // 服务端要求立刻补一拍心跳
                    1 => {
                        let seq = { inner.lock().await.last_seq };
                        let payload = heartbeat_frame(seq);
                        if let Err(error) = socket.send(Message::text(payload.to_string())).await {
                            return Err(format!("心跳发送失败: {error}"));
                        }
                        pending_ack = Some(Instant::now());
                    }
                    // 心跳 ACK
                    11 => pending_ack = None,
                    // 服务端要求重连（resume 即可）
                    7 => return Ok(GatewayEnd::Reconnect),
                    // 会话失效：Discord 的 `d` 语义与 QQ 相反 —— true 表示可 resume，false 必须重新 identify。
                    9 => {
                        let resumable = parsed.d.as_ref().and_then(serde_json::Value::as_bool).unwrap_or(false);
                        if !resumable {
                            inner.lock().await.forget_session();
                        }
                        return Ok(GatewayEnd::Reconnect);
                    }
                    other => {
                        log::info("discord", format!("忽略未处理的网关帧 op={other}"));
                    }
                }
            }
        }
    }
}

pub(super) async fn next_text(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> Result<String, String> {
    loop {
        let frame = socket
            .next()
            .await
            .ok_or("网关在握手前关闭")?
            .map_err(|error| format!("网关握手读取失败: {error}"))?;
        match frame {
            Message::Text(text) => return Ok(text.to_string()),
            Message::Close(_) => return Err("网关在握手前关闭".into()),
            _ => continue,
        }
    }
}

/// 下载一条入站附件（带签名的 CDN 直链，无需鉴权），读入后卡 20MB 上限。
pub(super) async fn download_attachment(
    client: &reqwest::Client,
    pending: &PendingAttachment,
) -> Result<Vec<u8>, String> {
    if pending
        .declared_size
        .is_some_and(|size| size > MAX_MEDIA_BYTES)
    {
        return Err(format!(
            "附件超过 {} MB 上限",
            MAX_MEDIA_BYTES / (1024 * 1024)
        ));
    }
    let response = client
        .get(&pending.url)
        .send()
        .await
        .map_err(|error| format!("下载附件请求失败: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("下载附件返回 {status}"));
    }
    let bytes = tokio::time::timeout(RESPONSE_READ_TIMEOUT, response.bytes())
        .await
        .map_err(|_| "下载附件读取超时".to_string())?
        .map_err(|error| format!("读取附件字节失败: {error}"))?;
    if bytes.len() as u64 > MAX_MEDIA_BYTES {
        return Err(format!(
            "附件超过 {} MB 上限",
            MAX_MEDIA_BYTES / (1024 * 1024)
        ));
    }
    Ok(bytes.to_vec())
}

/// 把入站草稿的附件下载进 inbox（单条失败只记日志，不中断整轮）。
pub(super) async fn materialize_inbound(
    deps: &GatewayDeps,
    draft: DiscordInboundDraft,
) -> DiscordInboundDto {
    let DiscordInboundDraft {
        message_id,
        peer_id,
        nick,
        sender_id,
        text,
        at,
        media,
    } = draft;
    let mut refs = Vec::new();
    if !media.is_empty() {
        match deps.inbox.as_deref() {
            None => log::warn("discord", "收件目录不可用，丢弃入站附件"),
            Some(inbox) => match shared_client(10) {
                Err(error) => log::warn("discord", format!("下载附件前建客户端失败: {error}")),
                Ok(client) => {
                    let received_at = now_ms();
                    for (index, pending) in media.iter().enumerate() {
                        match download_attachment(&client, pending).await {
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
                            Err(error) => {
                                log::warn("discord", format!("入站附件下载失败: {error}"))
                            }
                        }
                    }
                }
            },
        }
    }
    DiscordInboundDto {
        message_id,
        peer_id,
        nick,
        sender_id,
        text,
        at,
        media: refs,
    }
}

/// 一条业务事件：归属人判定 → 更新档案 → 允许则广播。
pub(super) async fn handle_dispatch(
    event: &str,
    data: &serde_json::Value,
    deps: &GatewayDeps,
    inner: &Mutex<Inner>,
) {
    let Some(draft) = normalize_dispatch(event, data, now_ms()) else {
        return;
    };
    // 附件字节下载进 inbox 后再广播（渲染端凭 path 取走）。
    let message = materialize_inbound(deps, draft).await;
    let (peers, allowed) = {
        let mut guard = inner.lock().await;
        guard.peers.claim_owner(&message.sender_id);
        guard.peers.remember(
            &message.peer_id,
            &message.sender_id,
            &message.nick,
            message.at,
        );
        if guard
            .last_message_at
            .map(|last| message.at > last)
            .unwrap_or(true)
        {
            guard.last_message_at = Some(message.at);
        }
        let allowed = guard
            .peers
            .allows(&message.sender_id, deps.allow_other_senders);
        emit_state(&guard, deps);
        (guard.peers.clone(), allowed)
    };
    (deps.persist)(&peers);
    if !allowed {
        log::info(
            "discord",
            format!(
                "忽略非授权发送者 {}（可在设置中允许其他联系人）",
                message.sender_id
            ),
        );
        return;
    }
    deps.emit(
        INBOUND_EVENT,
        serde_json::to_value(message).unwrap_or(serde_json::Value::Null),
    );
}

/// 指数退避（1s → 60s）。
pub(super) fn reconnect_delay(attempt: u32) -> Duration {
    let seconds = 1u64 << attempt.min(6);
    Duration::from_secs(seconds.min(60))
}

pub(super) async fn run_gateway(
    deps: GatewayDeps,
    inner: Arc<Mutex<Inner>>,
    epochs: Arc<AtomicU64>,
    epoch: u64,
) {
    let mut attempt: u32 = 0;
    log::info("discord", "网关长连接启动");
    while epochs.load(Ordering::SeqCst) == epoch {
        let client = match shared_client(10) {
            Ok(client) => client,
            Err(error) => {
                set_state(&inner, &deps, "error", Some(error)).await;
                return;
            }
        };
        let token = match inner.lock().await.token() {
            Ok(token) => token,
            Err(error) => {
                set_state(&inner, &deps, "error", Some(error)).await;
                return;
            }
        };
        // 已有会话就按官方建议改用 resume_gateway_url，不再打 /gateway/bot。
        let cached = {
            let guard = inner.lock().await;
            guard
                .session_id
                .as_ref()
                .and_then(|_| guard.resume_url.clone())
        };
        let url = match cached {
            Some(url) => Some(url),
            None => match gateway_url(&client, &token).await {
                Ok(url) => Some(url),
                Err(error) => {
                    attempt = attempt.saturating_add(1);
                    set_state(&inner, &deps, "error", Some(error.clone())).await;
                    log::warn("discord", format!("取网关地址失败({attempt}): {error}"));
                    None
                }
            },
        };
        if let Some(url) = url {
            let url = gateway_ws_url(&url);
            match gateway_once(&url, &token, &deps, &inner).await {
                Ok(GatewayEnd::Fatal(reason)) => {
                    log::warn("discord", format!("通道致命错误: {reason}"));
                    set_state(&inner, &deps, "error", Some(reason)).await;
                    return;
                }
                Ok(end) => {
                    log::info("discord", format!("网关连接结束: {end:?}"));
                    if end == GatewayEnd::Closed {
                        attempt = 0;
                    }
                }
                Err(error) => {
                    attempt = attempt.saturating_add(1);
                    log::warn("discord", format!("网关连接异常({attempt}): {error}"));
                    set_state(&inner, &deps, "error", Some(error)).await;
                }
            }
        }
        if !sleep_or_stop(&epochs, epoch, reconnect_delay(attempt)).await {
            break;
        }
        set_state(&inner, &deps, "connecting", None).await;
    }
    log::info("discord", "网关长连接已停止");
}
