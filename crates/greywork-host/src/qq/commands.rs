use std::sync::atomic::Ordering;
use std::sync::Arc;

use crate::channel_common::{channel_dir, now_ms, write_private};
use crate::channel_media::{prune_inbox, OutboundMedia};
use crate::host::HostContext;
use crate::http::shared_client;
use crate::log;

use super::connect::*;
use super::persist::*;
use super::protocol::*;
use super::*;

/// 发一条媒体：先分片上传换 `file_info`，再以 `msg_type=7` 被动回复出去。
///
/// token 与被动回复凭据都不出宿主：渲染端只传对端 id 与授权面内的本地路径。
impl crate::channel_media::ChannelHost for QqHost {
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
    host: &QqHost,
    peer_id: &str,
    media: OutboundMedia,
) -> Result<(), String> {
    let (scope, openid) =
        decode_peer(peer_id).ok_or_else(|| format!("对端 id 无法解析: {peer_id:?}"))?;
    let client = shared_client(10)?;
    {
        // 只做首次装载，随后立刻放锁：下面几步各自加锁，不能套着锁等网络。
        let mut inner = host.lock().await;
        ensure_loaded(host_ctx, &mut inner)?;
    }
    let token = ensure_token(&client, &host.inner).await?;
    let (msg_id, msg_seq) = {
        let mut inner = host.lock().await;
        let reply = inner.peers.next_reply(peer_id).ok_or(
            "会话凭据不可用：等对方再发一条消息（QQ 要求带回该消息的 msg_id，且只有 5 分钟窗口）",
        )?;
        let snapshot = inner.peers.clone();
        persist_peers(host_ctx, &snapshot);
        reply
    };
    let file_info = upload_rich_media(&client, &token, &scope, &openid, &media).await?;
    post_api(
        &client,
        &token,
        &messages_url(&scope, &openid),
        &rich_media_payload(&file_info, &msg_id, msg_seq),
        "发送媒体",
    )
    .await?;
    let kind = media.kind.as_str();
    log::info("qq", format!("已发送{kind}"));
    Ok(())
}

/* ===== 宿主层：Tauri 命令 ===== */

/// 当前通道状态（是否已配置凭证、网关状态、已建档联系人数）。
pub async fn qq_status(
    host_ctx: Arc<dyn HostContext>,
    host: &QqHost,
) -> Result<QqStatusDto, String> {
    let mut inner = host.lock().await;
    ensure_loaded(&host_ctx, &mut inner)?;
    Ok(inner.status())
}

/// 保存 AppID / AppSecret（AppSecret 留空表示沿用已存密钥）。
pub async fn qq_save_credentials(
    host_ctx: Arc<dyn HostContext>,
    host: &QqHost,
    app_id: String,
    app_secret: Option<String>,
) -> Result<QqStatusDto, String> {
    let app_id = app_id.trim().to_string();
    if app_id.is_empty() {
        return Err("AppID 不能为空".into());
    }
    let mut inner = host.lock().await;
    ensure_loaded(&host_ctx, &mut inner)?;
    let secret = app_secret
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            inner
                .credentials
                .as_ref()
                .map(|item| item.app_secret.clone())
        });
    let Some(secret) = secret else {
        return Err("AppSecret 不能为空".into());
    };
    let credentials = StoredCredentials {
        app_id,
        app_secret: secret,
        saved_at: Some(chrono::Utc::now().to_rfc3339()),
    };
    store_credentials(&host_ctx, &credentials)?;
    inner.credentials = Some(credentials);
    // 换了凭证就作废 token 与会话：旧票据属于上一个机器人。
    inner.access_token = None;
    inner.token_expires_at = 0;
    inner.session_id = None;
    inner.detail = None;
    log::info("qq", "AppID / AppSecret 已保存");
    Ok(inner.status())
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

/// 发起扫码创建机器人：返回二维码链接（`task_id` / `bind_key` 留在宿主内存）。
pub async fn qq_register_begin(host: &QqHost) -> Result<RegisterStartDto, String> {
    let client = shared_client(10)?;
    let (session, dto) = begin_registration(&client, BIND_HOST).await?;
    log::info("qq", "已发起扫码创建机器人");
    host.lock().await.registration = Some(session);
    Ok(dto)
}

/// 轮询扫码结果：成功时解密 AppSecret 并落盘，渲染端只需刷新状态。
pub async fn qq_register_poll(
    host_ctx: Arc<dyn HostContext>,
    host: &QqHost,
) -> Result<RegisterPollDto, String> {
    let session = {
        let mut inner = host.lock().await;
        ensure_loaded(&host_ctx, &mut inner)?;
        inner
            .registration
            .clone()
            .ok_or_else(|| "没有进行中的扫码创建流程".to_string())?
    };
    if now_ms() >= session.expires_at {
        let mut inner = host.lock().await;
        if current_task_id(&inner).as_deref() == Some(session.task_id.as_str()) {
            inner.registration = None;
        }
        return Ok(RegisterPollDto {
            state: "expired".into(),
            detail: None,
            app_id: None,
        });
    }

    let client = shared_client(10)?;
    // 传输层错误直接抛给渲染端计次重试；协议层的 pending / 失败走返回的 DTO。
    let outcome = poll_registration(&client, BIND_HOST, &session).await?;
    let mut inner = host.lock().await;
    let same_session = current_task_id(&inner).as_deref() == Some(session.task_id.as_str());
    if let PollOutcome::Done { app_id, app_secret } = &outcome {
        let credentials = StoredCredentials {
            app_id: app_id.clone(),
            app_secret: app_secret.clone(),
            saved_at: Some(chrono::Utc::now().to_rfc3339()),
        };
        // 落盘失败就留着会话（服务端在有效期内还会给凭证），让用户能重试。
        store_credentials(&host_ctx, &credentials)?;
        inner.credentials = Some(credentials);
        // 新机器人：作废旧 token 与会话。
        inner.access_token = None;
        inner.token_expires_at = 0;
        inner.session_id = None;
        inner.detail = None;
        if same_session {
            inner.registration = None;
        }
        log::info("qq", "扫码创建机器人成功，凭证已落盘");
        return Ok(RegisterPollDto {
            state: outcome.state().into(),
            detail: None,
            app_id: Some(app_id.clone()),
        });
    }
    if same_session {
        if outcome.state() == "pending" {
            inner.registration = Some(session.clone());
        } else {
            inner.registration = None;
        }
    }
    Ok(RegisterPollDto {
        state: outcome.state().into(),
        detail: outcome.detail(),
        app_id: None,
    })
}

/// 取消扫码创建（作废本次 task_id，不再轮询）。
pub async fn qq_register_cancel(host: &QqHost) -> Result<(), String> {
    host.lock().await.registration = None;
    Ok(())
}

fn current_task_id(inner: &Inner) -> Option<String> {
    inner
        .registration
        .as_ref()
        .map(|session| session.task_id.clone())
}

/// 清除凭证与联系人凭据（相当于退出登录）。
pub async fn qq_clear_credentials(
    host_ctx: Arc<dyn HostContext>,
    host: &QqHost,
) -> Result<QqStatusDto, String> {
    host.epoch.fetch_add(1, Ordering::SeqCst);
    let mut inner = host.lock().await;
    ensure_loaded(&host_ctx, &mut inner)?;
    inner.credentials = None;
    inner.peers = PeerBook::default();
    inner.access_token = None;
    inner.token_expires_at = 0;
    inner.session_id = None;
    inner.last_seq = 0;
    inner.state = "stopped".into();
    inner.detail = None;
    inner.last_message_at = None;
    inner.registration = None;
    let dir = channel_dir(host_ctx.as_ref(), DIR_NAME)?;
    for name in [CREDENTIALS_FILE, PEERS_FILE] {
        let path = dir.join(name);
        if path.exists() {
            let _ = std::fs::remove_file(&path);
        }
    }
    log::info("qq", "凭证已清除");
    prune_inbox(host_ctx.as_ref(), DIR_NAME, true);
    Ok(inner.status())
}

/// 启动网关长连接（未配置凭证时报错，由界面引导去填）。
pub async fn qq_connect(
    host_ctx: Arc<dyn HostContext>,
    host: &QqHost,
    allow_other_senders: bool,
) -> Result<(), String> {
    {
        let mut inner = host.lock().await;
        ensure_loaded(&host_ctx, &mut inner)?;
        if inner.credentials.is_none() {
            return Err("尚未配置 QQ 机器人 AppID / AppSecret".into());
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

/// 停止网关长连接（保留凭证与联系人凭据）。
pub async fn qq_disconnect(host_ctx: Arc<dyn HostContext>, host: &QqHost) -> Result<(), String> {
    host.epoch.fetch_add(1, Ordering::SeqCst);
    let mut inner = host.lock().await;
    ensure_loaded(&host_ctx, &mut inner)?;
    let deps = GatewayDeps::for_host(&host_ctx);
    inner.state = "stopped".into();
    inner.detail = None;
    emit_state(&inner, &deps);
    Ok(())
}

/// 回一条文本（被动回复：带该会话最近一条入站消息的 msg_id）。
pub async fn qq_send(
    host_ctx: Arc<dyn HostContext>,
    host: &QqHost,
    peer_id: String,
    text: String,
) -> Result<(), String> {
    let text = clamp_text(&text)?;
    let client = shared_client(10)?;
    {
        // 只做首次装载，随后立刻放锁：下面两步各自加锁，不能套着锁等网络。
        let mut inner = host.lock().await;
        ensure_loaded(&host_ctx, &mut inner)?;
    }
    let token = ensure_token(&client, &host.inner).await?;
    let (msg_id, msg_seq) = {
        let mut inner = host.lock().await;
        let reply = inner.peers.next_reply(&peer_id).ok_or(
            "会话凭据不可用：等对方再发一条消息（QQ 要求带回该消息的 msg_id，且只有 5 分钟窗口）",
        )?;
        let snapshot = inner.peers.clone();
        persist_peers(&host_ctx, &snapshot);
        reply
    };
    send_text(&client, &token, &peer_id, &text, &msg_id, msg_seq).await
}
