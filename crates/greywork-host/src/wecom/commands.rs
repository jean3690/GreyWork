use std::sync::atomic::Ordering;
use std::sync::Arc;

use crate::channel_common::{channel_dir, write_private};
use crate::channel_media::{prune_inbox, MediaKind, OutboundMedia};
use crate::host::HostContext;
use crate::log;

use super::connect::*;
use super::persist::*;
use super::protocol::*;
use super::*;

/* ===== 宿主层：Tauri 命令 ===== */

/// 当前通道状态（是否已配置凭证、长连接状态、已建档联系人数）。
pub async fn wecom_status(
    host_ctx: Arc<dyn HostContext>,
    host: &WecomHost,
) -> Result<WecomStatusDto, String> {
    let mut inner = host.lock().await;
    ensure_loaded(&host_ctx, &mut inner)?;
    Ok(inner.status())
}

/// 保存 BotID / Secret（Secret 留空表示沿用已存密钥）。
pub async fn wecom_save_credentials(
    host_ctx: Arc<dyn HostContext>,
    host: &WecomHost,
    bot_id: String,
    secret: Option<String>,
) -> Result<WecomStatusDto, String> {
    let bot_id = bot_id.trim().to_string();
    if bot_id.is_empty() {
        return Err("BotID 不能为空".into());
    }
    let mut inner = host.lock().await;
    ensure_loaded(&host_ctx, &mut inner)?;
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
    let dir = channel_dir(host_ctx.as_ref(), DIR_NAME)?;
    let bytes = serde_json::to_vec_pretty(&credentials)
        .map_err(|error| format!("凭证序列化失败: {error}"))?;
    write_private(&dir.join(CREDENTIALS_FILE), &bytes)?;
    inner.credentials = Some(credentials);
    inner.detail = None;
    log::info("wecom", "BotID / Secret 已保存");
    Ok(inner.status())
}

/// 清除凭证与联系人凭据（相当于退出登录）。
pub async fn wecom_clear_credentials(
    host_ctx: Arc<dyn HostContext>,
    host: &WecomHost,
) -> Result<WecomStatusDto, String> {
    host.epoch.fetch_add(1, Ordering::SeqCst);
    let mut inner = host.lock().await;
    ensure_loaded(&host_ctx, &mut inner)?;
    inner.credentials = None;
    inner.peers = PeerBook::default();
    inner.outgoing = None;
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
    log::info("wecom", "凭证已清除");
    prune_inbox(host_ctx.as_ref(), DIR_NAME, true);
    Ok(inner.status())
}

/// 启动长连接（未配置凭证时报错，由界面引导去填）。
pub async fn wecom_connect(
    host_ctx: Arc<dyn HostContext>,
    host: &WecomHost,
    allow_other_senders: bool,
) -> Result<(), String> {
    {
        let mut inner = host.lock().await;
        ensure_loaded(&host_ctx, &mut inner)?;
        if inner.credentials.is_none() {
            return Err("尚未配置企业微信智能机器人 BotID / Secret".into());
        }
        inner.state = "connecting".into();
        inner.detail = None;
    }
    let epoch = host.epoch.fetch_add(1, Ordering::SeqCst) + 1;
    // 上次会话遗留的未取走收件文件先清掉（渲染端崩溃 / 未取走）。
    prune_inbox(host_ctx.as_ref(), DIR_NAME, false);
    let inner = host.inner.clone();
    let epochs = host.epoch.clone();
    let mut deps = LinkDeps::for_host(&host_ctx);
    deps.allow_other_senders = allow_other_senders;
    set_state(&inner, &deps, "connecting", None).await;
    tokio::spawn(async move {
        run_link(deps, inner, epochs, epoch).await;
    });
    Ok(())
}

/// 停止长连接（保留凭证与联系人凭据）。
pub async fn wecom_disconnect(
    host_ctx: Arc<dyn HostContext>,
    host: &WecomHost,
) -> Result<(), String> {
    host.epoch.fetch_add(1, Ordering::SeqCst);
    let mut inner = host.lock().await;
    ensure_loaded(&host_ctx, &mut inner)?;
    let deps = LinkDeps::for_host(&host_ctx);
    inner.outgoing = None;
    inner.state = "stopped".into();
    inner.detail = None;
    emit_state(&inner, &deps);
    Ok(())
}

/// 回一条文本：优先被动回复（带该会话最近回调的 req_id），没有凭据则主动推送。
pub async fn wecom_send(
    host_ctx: Arc<dyn HostContext>,
    host: &WecomHost,
    peer_id: String,
    text: String,
) -> Result<(), String> {
    let text = clamp_text(&text)?;
    let (scope, id) =
        decode_peer(&peer_id).ok_or_else(|| format!("对端 id 无法解析: {peer_id:?}"))?;
    let (sender, credential) = {
        let mut inner = host.lock().await;
        ensure_loaded(&host_ctx, &mut inner)?;
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

/// 发一条媒体：先上传换 `media_id`，再被动回复（有 req_id）或主动推送。
///
/// 企业微信出站只有图片出口（图文混排），文件出口不存在 —— 能力矩阵已拦文件，这里再兜一层。
impl crate::channel_media::ChannelHost for WecomHost {
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
    host: &WecomHost,
    peer_id: &str,
    media: OutboundMedia,
) -> Result<(), String> {
    if media.kind != MediaKind::Image {
        return Err("企业微信只能发送图片".into());
    }
    let (scope, id) =
        decode_peer(peer_id).ok_or_else(|| format!("对端 id 无法解析: {peer_id:?}"))?;
    let (sender, credential) = {
        let mut inner = host.lock().await;
        ensure_loaded(host_ctx, &mut inner)?;
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
