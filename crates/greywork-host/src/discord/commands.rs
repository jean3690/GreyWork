use std::sync::atomic::Ordering;
use std::sync::Arc;

use crate::channel_common::{channel_dir, write_private};
use crate::channel_media::{prune_inbox, OutboundMedia};
use crate::host::HostContext;
use crate::http::{read_text, shared_client, RESPONSE_READ_TIMEOUT};
use crate::log;

use super::connect::*;
use super::persist::*;
use super::protocol::*;
use super::*;

/// 发一条媒体：multipart 直传字节（`payload_json` 空对象 = 只发附件、不带正文）。
///
/// 图片与文件走同一条附件通道（Discord 不区分端点），所以不需要按 kind 分叉。
impl crate::channel_media::ChannelHost for DiscordHost {
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
    host: &DiscordHost,
    peer_id: &str,
    media: OutboundMedia,
) -> Result<(), String> {
    let channel_id =
        decode_peer(peer_id).ok_or_else(|| format!("对端 id 无法解析: {peer_id:?}"))?;
    let token = {
        let mut inner = host.lock().await;
        ensure_loaded(host_ctx, &mut inner)?;
        inner.token()?
    };
    let part = reqwest::multipart::Part::bytes(media.bytes).file_name(media.name);
    let form = reqwest::multipart::Form::new()
        .text("payload_json", "{}")
        .part("files[0]", part);
    let client = shared_client(10)?;
    let response = client
        .post(format!("{API_BASE}/channels/{channel_id}/messages"))
        .header("Authorization", auth_header(&token))
        .multipart(form)
        .send()
        .await
        .map_err(|error| format!("发送媒体失败: {error}"))?;
    let status = response.status();
    let body = read_text(response, RESPONSE_READ_TIMEOUT)
        .await
        .map_err(|error| format!("发送媒体响应读取失败: {error}"))?;
    if status.is_success() {
        return Ok(());
    }
    if status == reqwest::StatusCode::FORBIDDEN {
        return Err(
            "Discord 拒绝了这条媒体（403）：私聊需要对方先发起过会话，且不能给已拉黑机器人的用户发"
                .into(),
        );
    }
    if status == reqwest::StatusCode::PAYLOAD_TOO_LARGE {
        return Err("Discord 拒绝了这条媒体（413）：超过该频道的附件大小上限".into());
    }
    Err(format!("发送媒体返回 {status}: {}", brief(&body)))
}

/// 错误体只留一段摘要。
pub(super) fn brief(text: &str) -> String {
    let trimmed = text.trim();
    let head: String = trimmed.chars().take(200).collect();
    if trimmed.chars().count() > 200 {
        format!("{head}…")
    } else {
        head
    }
}

/* ===== 宿主层：Tauri 命令 ===== */

/// 当前通道状态（是否已配置 token、网关状态、已建档私聊数）。
pub async fn discord_status(
    host_ctx: Arc<dyn HostContext>,
    host: &DiscordHost,
) -> Result<DiscordStatusDto, String> {
    let mut inner = host.lock().await;
    ensure_loaded(&host_ctx, &mut inner)?;
    Ok(inner.status())
}

/// 保存 bot token：先探针确认有效并取回 bot 身份，再落盘。
pub async fn discord_save_credentials(
    host_ctx: Arc<dyn HostContext>,
    host: &DiscordHost,
    token: String,
) -> Result<DiscordStatusDto, String> {
    let token = token.trim().to_string();
    if !is_valid_token(&token) {
        return Err(
            "bot token 形状不对：应为 `xxx.yyy.zzz` 三段（门户 → Bot → Reset Token）".into(),
        );
    }
    let client = shared_client(10)?;
    let bot = probe_bot_user(&client, &token).await?;
    let credentials = StoredCredentials {
        token,
        bot_user_id: bot.id.clone(),
        bot_username: bot.display_name(),
        saved_at: Some(chrono::Utc::now().to_rfc3339()),
    };
    let mut inner = host.lock().await;
    ensure_loaded(&host_ctx, &mut inner)?;
    let dir = channel_dir(host_ctx.as_ref(), DIR_NAME)?;
    let bytes = serde_json::to_vec_pretty(&credentials)
        .map_err(|error| format!("凭证序列化失败: {error}"))?;
    write_private(&dir.join(CREDENTIALS_FILE), &bytes)?;
    // 换了 token 就作废会话：旧会话属于上一个 bot。
    inner.forget_session();
    inner.credentials = Some(credentials);
    inner.detail = None;
    log::info("discord", format!("bot token 已保存（{}）", bot.id));
    Ok(inner.status())
}

/// 清除 token 与私聊档案（相当于退出登录）。
pub async fn discord_clear_credentials(
    host_ctx: Arc<dyn HostContext>,
    host: &DiscordHost,
) -> Result<DiscordStatusDto, String> {
    host.epoch.fetch_add(1, Ordering::SeqCst);
    let mut inner = host.lock().await;
    ensure_loaded(&host_ctx, &mut inner)?;
    inner.credentials = None;
    inner.peers = PeerBook::default();
    inner.forget_session();
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
    log::info("discord", "凭证已清除");
    Ok(inner.status())
}

/// 启动网关长连接（未配置 token 时报错，由界面引导去填）。
pub async fn discord_connect(
    host_ctx: Arc<dyn HostContext>,
    host: &DiscordHost,
    allow_other_senders: bool,
) -> Result<(), String> {
    {
        let mut inner = host.lock().await;
        ensure_loaded(&host_ctx, &mut inner)?;
        if inner.credentials.is_none() {
            return Err("尚未配置 Discord bot token".into());
        }
        inner.state = "connecting".into();
        inner.detail = None;
    }
    let epoch = host.epoch.fetch_add(1, Ordering::SeqCst) + 1;
    // 上次会话遗留的未取走收件文件先清掉（渲染端崩溃 / 未取走）。
    prune_inbox(host_ctx.as_ref(), DIR_NAME, false);
    let inner = host.inner.clone();
    let epochs = host.epoch.clone();
    let mut deps = GatewayDeps::for_host(&host_ctx);
    deps.allow_other_senders = allow_other_senders;
    set_state(&inner, &deps, "connecting", None).await;
    tokio::spawn(async move {
        run_gateway(deps, inner, epochs, epoch).await;
    });
    Ok(())
}

/// 停止网关长连接（保留 token 与私聊档案）。
pub async fn discord_disconnect(
    host_ctx: Arc<dyn HostContext>,
    host: &DiscordHost,
) -> Result<(), String> {
    host.epoch.fetch_add(1, Ordering::SeqCst);
    let mut inner = host.lock().await;
    ensure_loaded(&host_ctx, &mut inner)?;
    let deps = GatewayDeps::for_host(&host_ctx);
    inner.state = "stopped".into();
    inner.detail = None;
    emit_state(&inner, &deps);
    Ok(())
}

/// 往已建档的私聊频道发一条文本。
pub async fn discord_send(
    host_ctx: Arc<dyn HostContext>,
    host: &DiscordHost,
    peer_id: String,
    text: String,
) -> Result<(), String> {
    let text = clamp_text(&text)?;
    let client = shared_client(10)?;
    let token = {
        // 只做首次装载与凭据读取，随后立刻放锁：发消息要等网络，不能套着锁。
        let mut inner = host.lock().await;
        ensure_loaded(&host_ctx, &mut inner)?;
        if !inner.peers.peers.contains_key(&peer_id) {
            return Err("该私聊尚未建档：等对方先发一条消息，本机才知道这个会话".into());
        }
        inner.token()?
    };
    send_text(&client, &token, &peer_id, &text).await
}
