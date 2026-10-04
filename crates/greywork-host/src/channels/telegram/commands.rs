use std::sync::atomic::Ordering;
use std::sync::Arc;

use crate::channel_common::{channel_dir, write_private};
use crate::channel_media::{ext_of, prune_inbox, MediaKind, OutboundMedia};
use crate::host::HostContext;
use crate::http::{shared_client, RESPONSE_READ_TIMEOUT};
use crate::log;

use super::connect::*;
use super::persist::*;
use super::protocol::*;
use super::*;

/* ===== 宿主层：Tauri 命令 ===== */

/// 当前通道状态（是否已配置 token、长轮询状态、已建档联系人数）。
pub async fn telegram_status(
    host_ctx: Arc<dyn HostContext>,
    host: &TelegramHost,
) -> Result<TelegramStatusDto, String> {
    let mut inner = host.lock().await;
    ensure_loaded(&host_ctx, &mut inner)?;
    Ok(inner.status())
}

/// 保存 bot token（形状校验通过才落盘）。
pub async fn telegram_save_credentials(
    host_ctx: Arc<dyn HostContext>,
    host: &TelegramHost,
    token: String,
) -> Result<TelegramStatusDto, String> {
    let token = validate_token(&token)?;
    let mut inner = host.lock().await;
    ensure_loaded(&host_ctx, &mut inner)?;
    let credentials = StoredCredentials {
        token,
        saved_at: Some(chrono::Utc::now().to_rfc3339()),
    };
    let dir = channel_dir(host_ctx.as_ref(), DIR_NAME)?;
    let bytes = serde_json::to_vec_pretty(&credentials)
        .map_err(|error| format!("凭证序列化失败: {error}"))?;
    write_private(&dir.join(CREDENTIALS_FILE), &bytes)?;
    inner.credentials = Some(credentials);
    inner.detail = None;
    log::info("telegram", "bot token 已保存");
    Ok(inner.status())
}

/// 清除凭证与联系人档案（相当于退出登录），长轮询随之停止。
pub async fn telegram_clear_credentials(
    host_ctx: Arc<dyn HostContext>,
    host: &TelegramHost,
) -> Result<TelegramStatusDto, String> {
    host.epoch.fetch_add(1, Ordering::SeqCst);
    let mut inner = host.lock().await;
    ensure_loaded(&host_ctx, &mut inner)?;
    inner.credentials = None;
    inner.peers = PeerBook::default();
    inner.state = "stopped".into();
    inner.detail = None;
    inner.last_message_at = None;
    let dir = channel_dir(host_ctx.as_ref(), DIR_NAME)?;
    for name in [CREDENTIALS_FILE, PEERS_FILE] {
        let path = dir.join(name);
        if path.exists() {
            let _ = std::fs::remove_file(&path);
        }
    }
    prune_inbox(host_ctx.as_ref(), DIR_NAME, true);
    log::info("telegram", "凭证已清除");
    Ok(inner.status())
}

/// 启动长轮询（未配置 token 时报错，由界面引导去填）。
pub async fn telegram_connect(
    host_ctx: Arc<dyn HostContext>,
    host: &TelegramHost,
    allow_other_senders: bool,
) -> Result<(), String> {
    let token = {
        let mut inner = host.lock().await;
        ensure_loaded(&host_ctx, &mut inner)?;
        let credentials = inner
            .credentials
            .clone()
            .ok_or("尚未配置 Telegram bot token")?;
        inner.state = "connecting".into();
        inner.detail = None;
        credentials.token
    };
    let epoch = host.epoch.fetch_add(1, Ordering::SeqCst) + 1;
    // 上次会话遗留的未取走收件文件先清掉（渲染端崩溃 / 未取走）。
    prune_inbox(host_ctx.as_ref(), DIR_NAME, false);
    let inner = host.inner.clone();
    let epochs = host.epoch.clone();
    let deps = PollDeps::for_host(&host_ctx);
    let handle = Arc::clone(&host_ctx);
    set_state(&inner, &deps, "connecting", None).await;
    tokio::spawn(async move {
        run_poll(
            handle,
            deps,
            inner,
            epochs,
            epoch,
            token,
            allow_other_senders,
        )
        .await;
    });
    Ok(())
}

/// 停止长轮询（保留凭证与联系人档案）。
pub async fn telegram_disconnect(
    host_ctx: Arc<dyn HostContext>,
    host: &TelegramHost,
) -> Result<(), String> {
    host.epoch.fetch_add(1, Ordering::SeqCst);
    let mut inner = host.lock().await;
    ensure_loaded(&host_ctx, &mut inner)?;
    let deps = PollDeps::for_host(&host_ctx);
    inner.state = "stopped".into();
    inner.detail = None;
    emit_state(&inner, &deps);
    Ok(())
}

/// 扫码绑定：返回机器人的 `t.me/<username>` 链接（渲染端把它编成二维码）。
///
/// 与「连接」无关：链接只依赖 token，正因为不需要连接态，未连接的机器人也能先把码摆出来。
pub async fn telegram_bot_link(
    host_ctx: Arc<dyn HostContext>,
    host: &TelegramHost,
) -> Result<TelegramBotLinkDto, String> {
    let token = {
        let mut inner = host.lock().await;
        ensure_loaded(&host_ctx, &mut inner)?;
        inner
            .credentials
            .as_ref()
            .map(|credentials| credentials.token.clone())
            .ok_or("尚未配置 Telegram bot token")?
    };
    let client = shared_client(10)?;
    bot_link(&client, &token).await
}

/// 回一条文本（token 不出宿主，渲染端只传对端 id 与文本）。
pub async fn telegram_send(
    host_ctx: Arc<dyn HostContext>,
    host: &TelegramHost,
    peer_id: String,
    text: String,
) -> Result<(), String> {
    let text = clamp_text(&text)?;
    let chat_id: i64 = peer_id
        .trim()
        .parse()
        .map_err(|_| format!("对端 id 不是合法的 chat id: {peer_id:?}"))?;
    let token = {
        let mut inner = host.lock().await;
        ensure_loaded(&host_ctx, &mut inner)?;
        inner
            .credentials
            .as_ref()
            .map(|credentials| credentials.token.clone())
            .ok_or("尚未配置 Telegram bot token")?
    };
    let client = shared_client(10)?;
    send_text(&client, &token, chat_id, &text).await
}

/// 出站端点：图片 / 视频 / 语音 / 文件各走各的 Telegram 方法。
///
/// 语音 OGG/OPUS 走 `sendVoice`（对端显示为语音条），其余音频走 `sendAudio`。
pub(super) fn send_endpoint(kind: MediaKind, name: &str) -> (&'static str, &'static str) {
    match kind {
        MediaKind::Image => ("sendPhoto", "photo"),
        MediaKind::Video => ("sendVideo", "video"),
        MediaKind::Audio => {
            if matches!(ext_of(name).as_str(), "ogg" | "opus") {
                ("sendVoice", "voice")
            } else {
                ("sendAudio", "audio")
            }
        }
        MediaKind::File => ("sendDocument", "document"),
    }
}

/// 回一条媒体：按类别走对应端点（multipart 直传字节，不落临时文件）。
///
/// token 不出宿主：与文本同一条路径，渲染端只传对端 id 与授权面内的本地路径。
impl crate::channel_media::ChannelHost for TelegramHost {
    fn send_media<'a>(
        &'a self,
        host_ctx: &'a Arc<dyn HostContext>,
        peer_id: &'a str,
        _context_token: Option<&'a str>,
        media: OutboundMedia,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(send_media_impl(host_ctx, self, peer_id, media))
    }
}

pub async fn send_media_impl(
    host_ctx: &Arc<dyn HostContext>,
    host: &TelegramHost,
    peer_id: &str,
    media: OutboundMedia,
) -> Result<(), String> {
    let chat_id: i64 = peer_id
        .trim()
        .parse()
        .map_err(|_| format!("对端 id 不是合法的 chat id: {peer_id:?}"))?;
    let token = {
        let mut inner = host.lock().await;
        ensure_loaded(host_ctx, &mut inner)?;
        inner
            .credentials
            .as_ref()
            .map(|credentials| credentials.token.clone())
            .ok_or("尚未配置 Telegram bot token")?
    };
    let (method, field) = send_endpoint(media.kind, &media.name);
    let part = reqwest::multipart::Part::bytes(media.bytes).file_name(media.name);
    let form = reqwest::multipart::Form::new()
        .text("chat_id", chat_id.to_string())
        .part(field, part);
    let client = shared_client(10)?;
    let response = client
        .post(api_url(&token, method))
        .multipart(form)
        .send()
        .await
        .map_err(|error| format!("{method} 请求失败: {error}"))?;
    let status = response.status();
    let body = crate::http::read_text(response, RESPONSE_READ_TIMEOUT)
        .await
        .map_err(|error| format!("{method} 响应读取失败: {error}"))?;
    if !status.is_success() {
        return Err(format!("{method} 返回 {status}: {}", brief(&body)));
    }
    let parsed: SendResponse =
        serde_json::from_str(&body).map_err(|error| format!("{method} 响应解析失败: {error}"))?;
    if !parsed.ok {
        return Err(format!(
            "Telegram 拒绝了这条媒体：{}",
            parsed.description.unwrap_or_else(|| "unknown error".into())
        ));
    }
    Ok(())
}
