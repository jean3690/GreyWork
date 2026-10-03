use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;

use crate::channel_common::{now_ms, sleep_or_stop};
use crate::channel_media::{inbox_dir, store_inbound_media, MAX_MEDIA_BYTES};
use crate::host::HostContext;
use crate::http::{shared_client, RESPONSE_READ_TIMEOUT};
use crate::log;

use super::protocol::*;
use super::*;

/* ===== 宿主层：HTTP ===== */

pub(super) fn api_url(token: &str, method: &str) -> String {
    format!("{API_BASE}/bot{token}/{method}")
}

/// 一次 `getUpdates`：长轮询 `timeout` 秒；返回归一后的入站草稿与本轮最大 update_id。
pub(super) async fn poll_once(
    client: &reqwest::Client,
    token: &str,
    offset: i64,
) -> Result<(Vec<InboundDraft>, Option<i64>), String> {
    let response = client
        .get(api_url(token, "getUpdates"))
        .query(&[
            ("offset", offset.to_string()),
            ("timeout", POLL_TIMEOUT_SECS.to_string()),
            ("allowed_updates", "[\"message\"]".to_string()),
        ])
        .send()
        .await
        .map_err(|error| format!("getUpdates 请求失败: {error}"))?;
    let status = response.status();
    let body = crate::http::read_text(response, RESPONSE_READ_TIMEOUT)
        .await
        .map_err(|error| format!("getUpdates 响应读取失败: {error}"))?;
    if !status.is_success() {
        return Err(format!("getUpdates 返回 {status}: {}", brief(&body)));
    }
    let updates = parse_updates(&body)?;
    let received_at = now_ms();
    let next_offset = updates.iter().map(|update| update.update_id + 1).max();
    let inbound = updates
        .iter()
        .filter_map(|update| normalize_update(update, received_at))
        .collect();
    Ok((inbound, next_offset))
}

/// 回一条文本：`chat_id` 用对方 chat 的十进制 id。
pub(crate) async fn send_text(
    client: &reqwest::Client,
    token: &str,
    chat_id: i64,
    text: &str,
) -> Result<(), String> {
    let response = client
        .post(api_url(token, "sendMessage"))
        .json(&serde_json::json!({ "chat_id": chat_id, "text": text }))
        .send()
        .await
        .map_err(|error| format!("sendMessage 请求失败: {error}"))?;
    let status = response.status();
    let body = crate::http::read_text(response, RESPONSE_READ_TIMEOUT)
        .await
        .map_err(|error| format!("sendMessage 响应读取失败: {error}"))?;
    if !status.is_success() {
        return Err(format!("sendMessage 返回 {status}: {}", brief(&body)));
    }
    let parsed: SendResponse = serde_json::from_str(&body)
        .map_err(|error| format!("sendMessage 响应解析失败: {error}"))?;
    if !parsed.ok {
        return Err(format!(
            "Telegram 拒绝了这条消息：{}",
            parsed.description.unwrap_or_else(|| "unknown error".into())
        ));
    }
    Ok(())
}

/// `getFile`：把 file_id 换成可下载的 `file_path`（再拼 `/file/bot<token>/<file_path>`）。
pub(crate) async fn get_file_path(
    client: &reqwest::Client,
    token: &str,
    file_id: &str,
) -> Result<String, String> {
    let response = client
        .get(api_url(token, "getFile"))
        .query(&[("file_id", file_id)])
        .send()
        .await
        .map_err(|error| format!("getFile 请求失败: {error}"))?;
    let status = response.status();
    let body = crate::http::read_text(response, RESPONSE_READ_TIMEOUT)
        .await
        .map_err(|error| format!("getFile 响应读取失败: {error}"))?;
    if !status.is_success() {
        return Err(format!("getFile 返回 {status}: {}", brief(&body)));
    }
    let parsed: FileResponse =
        serde_json::from_str(&body).map_err(|error| format!("getFile 响应解析失败: {error}"))?;
    if !parsed.ok {
        return Err(format!(
            "Telegram 拒绝了 getFile：{}",
            parsed.description.unwrap_or_else(|| "unknown error".into())
        ));
    }
    parsed
        .result
        .and_then(|info| info.file_path)
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty())
        .ok_or_else(|| "getFile 回包里没有 file_path".to_string())
}

/// 下载一条媒体字节（`/file/bot<token>/<file_path>`），读入后卡 20MB 上限。
pub(crate) async fn download_file(
    client: &reqwest::Client,
    token: &str,
    file_path: &str,
) -> Result<Vec<u8>, String> {
    let url = format!("{API_BASE}/file/bot{token}/{file_path}");
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|error| format!("下载媒体请求失败: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = crate::http::read_text(response, RESPONSE_READ_TIMEOUT)
            .await
            .unwrap_or_default();
        return Err(format!("下载媒体返回 {status}: {}", brief(&body)));
    }
    let bytes = tokio::time::timeout(RESPONSE_READ_TIMEOUT, response.bytes())
        .await
        .map_err(|_| "下载媒体读取超时".to_string())?
        .map_err(|error| format!("读取媒体字节失败: {error}"))?;
    if bytes.len() as u64 > MAX_MEDIA_BYTES {
        return Err(format!(
            "媒体超过 {} MB 上限",
            MAX_MEDIA_BYTES / (1024 * 1024)
        ));
    }
    Ok(bytes.to_vec())
}

/// 取一条待下载媒体的字节：先按声明的 size 预筛，再 getFile + 下载。
pub(super) async fn fetch_media(
    client: &reqwest::Client,
    token: &str,
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
    let file_path = get_file_path(client, token, &pending.file_id).await?;
    download_file(client, token, &file_path).await
}

/// 把入站草稿的媒体下载进 inbox，产出渲染端可取的引用（单条失败只记日志，不中断整轮）。
pub(super) async fn materialize_inbound(
    host_ctx: &Arc<dyn HostContext>,
    client: &reqwest::Client,
    token: &str,
    draft: InboundDraft,
) -> TelegramInboundDto {
    let InboundDraft {
        message_id,
        peer_id,
        nick,
        text,
        at,
        media,
    } = draft;
    let inbox = match inbox_dir(host_ctx.as_ref(), DIR_NAME) {
        Ok(inbox) => inbox,
        Err(error) => {
            log::warn("telegram", format!("收件目录不可用，丢弃入站媒体: {error}"));
            return TelegramInboundDto {
                message_id,
                peer_id,
                nick,
                text,
                at,
                media: Vec::new(),
            };
        }
    };
    let received_at = now_ms();
    let mut refs = Vec::new();
    for (index, pending) in media.iter().enumerate() {
        match fetch_media(client, token, pending).await {
            Ok(bytes) => {
                if let Some(dto) = store_inbound_media(
                    &inbox,
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
            Err(error) => log::warn("telegram", format!("入站媒体下载失败: {error}")),
        }
    }
    TelegramInboundDto {
        message_id,
        peer_id,
        nick,
        text,
        at,
        media: refs,
    }
}

/// 取机器人自身的公开身份并拼出扫码链接。
///
/// 用 `getMe` 而不是让用户手抄 bot 名：token 已经在宿主手里，机器人名是公开信息，
/// 查一次即可。username 缺失（机器人未设置用户名）时明确报错——没有 username 就没有
/// 可扫的 `t.me/...` 链接。
pub(crate) async fn bot_link(
    client: &reqwest::Client,
    token: &str,
) -> Result<TelegramBotLinkDto, String> {
    let response = client
        .get(api_url(token, "getMe"))
        .send()
        .await
        .map_err(|error| format!("getMe 请求失败: {error}"))?;
    let status = response.status();
    let body = crate::http::read_text(response, RESPONSE_READ_TIMEOUT)
        .await
        .map_err(|error| format!("getMe 响应读取失败: {error}"))?;
    if !status.is_success() {
        return Err(format!("getMe 返回 {status}: {}", brief(&body)));
    }
    let parsed: MeResponse =
        serde_json::from_str(&body).map_err(|error| format!("getMe 响应解析失败: {error}"))?;
    if !parsed.ok {
        return Err(format!(
            "Telegram 拒绝了 getMe：{}",
            parsed.description.unwrap_or_else(|| "unknown error".into())
        ));
    }
    let bot = parsed.result.ok_or("getMe 回包里没有机器人信息")?;
    let username = bot
        .username
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or("该机器人没有 username：到 @BotFather 里用 /setname 设置用户名后才能生成扫码链接")?;
    Ok(TelegramBotLinkDto {
        url: format!("https://t.me/{username}"),
        name: bot.first_name,
        username,
    })
}

/// 错误体只留一段摘要（远端错误可能夹带整段 HTML）。
pub(super) fn brief(text: &str) -> String {
    let trimmed = text.trim();
    let head: String = trimmed.chars().take(200).collect();
    if trimmed.chars().count() > 200 {
        format!("{head}…")
    } else {
        head
    }
}

/* ===== 宿主层：长轮询主循环（带重连退避） ===== */

pub(super) async fn run_poll(
    host_ctx: Arc<dyn HostContext>,
    deps: PollDeps,
    inner: Arc<Mutex<Inner>>,
    epochs: Arc<AtomicU64>,
    epoch: u64,
    token: String,
    allow_other_senders: bool,
) {
    let mut attempt: u32 = 0;
    log::info("telegram", "长轮询启动");
    while epochs.load(Ordering::SeqCst) == epoch {
        let client = match shared_client(10) {
            Ok(client) => client,
            Err(error) => {
                set_state(&inner, &deps, "error", Some(error)).await;
                return;
            }
        };
        let offset = {
            let guard = inner.lock().await;
            guard.offset
        };
        match poll_once(&client, &token, offset).await {
            Ok((inbound, next_offset)) => {
                attempt = 0;
                if let Some(next) = next_offset {
                    let mut guard = inner.lock().await;
                    guard.offset = next;
                }
                if inbound.is_empty() {
                    // 长轮询超时无消息属正常：只在首次连上时广播一次 connected。
                    let mut guard = inner.lock().await;
                    if guard.state != "connected" {
                        guard.state = "connected".into();
                        guard.detail = None;
                    }
                    emit_state(&guard, &deps);
                } else {
                    for draft in inbound {
                        // 先把媒体字节下载进 inbox（渲染端凭 path 取走），再广播归一消息。
                        let message = materialize_inbound(&host_ctx, &client, &token, draft).await;
                        handle_inbound(&deps, &inner, message, allow_other_senders).await;
                    }
                }
            }
            Err(error) => {
                attempt = attempt.saturating_add(1);
                log::warn("telegram", format!("长轮询失败({attempt}): {error}"));
                set_state(&inner, &deps, "error", Some(error)).await;
                if !sleep_or_stop(&epochs, epoch, reconnect_delay(attempt)).await {
                    break;
                }
                set_state(&inner, &deps, "connecting", None).await;
            }
        }
    }
    log::info("telegram", "长轮询已停止");
}

/// 单条入站：归属人判定 → 更新档案与状态 → 允许则广播。
pub(super) async fn handle_inbound(
    deps: &PollDeps,
    inner: &Mutex<Inner>,
    message: TelegramInboundDto,
    allow_other_senders: bool,
) {
    let (peers, allowed) = {
        let mut guard = inner.lock().await;
        guard.peers.claim_owner(&message.peer_id);
        guard
            .peers
            .remember(&message.peer_id, &message.nick, message.at);
        if guard
            .last_message_at
            .map(|last| message.at > last)
            .unwrap_or(true)
        {
            guard.last_message_at = Some(message.at);
        }
        let allowed = guard.peers.allows(&message.peer_id, allow_other_senders);
        guard.state = "connected".into();
        guard.detail = None;
        emit_state(&guard, deps);
        (guard.peers.clone(), allowed)
    };
    (deps.persist)(&peers);
    if !allowed {
        log::info(
            "telegram",
            format!(
                "忽略非授权发送者 {}（可在设置中允许其他联系人）",
                message.peer_id
            ),
        );
        return;
    }
    deps.emit(
        INBOUND_EVENT,
        serde_json::to_value(message).unwrap_or(serde_json::Value::Null),
    );
}

/// 指数退避（1s → 60s 上限），与钉钉同一条曲线。
pub(super) fn reconnect_delay(attempt: u32) -> Duration {
    let seconds = 1u64 << attempt.min(6);
    Duration::from_secs(seconds.min(60))
}
