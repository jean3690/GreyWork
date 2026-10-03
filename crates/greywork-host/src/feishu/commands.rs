use std::sync::atomic::Ordering;
use std::sync::Arc;

use crate::channel_common::{channel_dir, now_ms};
use crate::channel_media::{prune_inbox, MediaKind, OutboundMedia};
use crate::host::HostContext;
use crate::log;

use super::connect::*;
use super::persist::*;
use super::protocol::*;
use super::*;

/// 发一条媒体：图片先传 `im/v1/images` 换 image_key，文件先传 `im/v1/files` 换 file_key，
/// 再以 `msg_type=image|file` 发出去（飞书没有「一步直传」的消息接口）。
impl crate::channel_media::ChannelHost for FeishuHost {
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
    host: &FeishuHost,
    peer_id: &str,
    media: OutboundMedia,
) -> Result<(), String> {
    let (credentials, record) = {
        let mut inner = host.lock().await;
        ensure_loaded(host_ctx, &mut inner)?;
        let credentials = inner.credentials.clone().ok_or("尚未配置飞书应用凭证")?;
        let record = inner
            .peers
            .target(peer_id)
            .cloned()
            .ok_or("会话信息不可用：等对方再发一条消息")?;
        (credentials, record)
    };
    let client = crate::http::shared_client(10)?;
    let token = tenant_access_token(
        &client,
        DEFAULT_DOMAIN,
        &credentials.app_id,
        &credentials.app_secret,
    )
    .await?;
    let (msg_type, content) = match media.kind {
        MediaKind::Image => {
            let image_key =
                upload_image(&client, DEFAULT_DOMAIN, &token, media.bytes, media.name).await?;
            ("image", serde_json::json!({ "image_key": image_key }))
        }
        // 视频 / 语音无原生出站端点（media 需封面、audio 需 opus），共享层已降级为文件。
        MediaKind::Video | MediaKind::Audio | MediaKind::File => {
            let file_key =
                upload_file(&client, DEFAULT_DOMAIN, &token, media.bytes, &media.name).await?;
            ("file", serde_json::json!({ "file_key": file_key }))
        }
    };
    send_message(
        &client,
        DEFAULT_DOMAIN,
        &token,
        &record.receive_id_type,
        message_body(&record.receive_id, msg_type, &content),
    )
    .await
}

/* ===== 宿主层：Tauri 命令 ===== */

/// 当前通道状态（是否已配置凭证、长连接状态、已建档联系人数）。
pub async fn feishu_status(
    host_ctx: Arc<dyn HostContext>,
    host: &FeishuHost,
) -> Result<FeishuStatusDto, String> {
    let mut inner = host.lock().await;
    ensure_loaded(&host_ctx, &mut inner)?;
    Ok(inner.status())
}

/// 保存应用凭证（AppID + AppSecret）。`app_secret` 传 None 表示沿用已存密钥。
pub async fn feishu_save_credentials(
    host_ctx: Arc<dyn HostContext>,
    host: &FeishuHost,
    app_id: String,
    app_secret: Option<String>,
) -> Result<FeishuStatusDto, String> {
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
                .map(|credentials| credentials.app_secret.clone())
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
    inner.detail = None;
    log::info("feishu", "应用凭证已保存");
    Ok(inner.status())
}

/// 清除凭证与联系人档案。
pub async fn feishu_clear_credentials(
    host_ctx: Arc<dyn HostContext>,
    host: &FeishuHost,
) -> Result<FeishuStatusDto, String> {
    host.epoch.fetch_add(1, Ordering::SeqCst);
    let mut inner = host.lock().await;
    ensure_loaded(&host_ctx, &mut inner)?;
    inner.credentials = None;
    inner.peers = PeerBook::default();
    inner.registration = None;
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
    log::info("feishu", "凭证已清除");
    Ok(inner.status())
}

/// 发起扫码创建应用：返回二维码链接与配对码（`device_code` 留在宿主内存）。
pub async fn feishu_register_begin(host: &FeishuHost) -> Result<RegisterStartDto, String> {
    let client = crate::http::shared_client(10)?;
    let (session, dto) = begin_registration(&client, ACCOUNTS_DOMAIN).await?;
    log::info("feishu", "已发起扫码创建应用");
    host.lock().await.registration = Some(session);
    Ok(dto)
}

/// 轮询扫码结果：`pending` 期间间隔由服务端给（`slow_down` 会变大）；
/// 成功时凭证直接落盘并写进宿主状态，渲染端只需刷新状态。
pub async fn feishu_register_poll(
    host_ctx: Arc<dyn HostContext>,
    host: &FeishuHost,
) -> Result<RegisterPollDto, String> {
    let mut session = {
        let mut inner = host.lock().await;
        ensure_loaded(&host_ctx, &mut inner)?;
        inner
            .registration
            .clone()
            .ok_or_else(|| "没有进行中的扫码创建流程".to_string())?
    };
    if now_ms() >= session.expires_at {
        let mut inner = host.lock().await;
        if current_device_code(&inner).as_deref() == Some(session.device_code.as_str()) {
            inner.registration = None;
        }
        return Ok(RegisterPollDto {
            state: "expired".into(),
            detail: None,
            app_id: None,
            interval_ms: None,
        });
    }

    let client = crate::http::shared_client(10)?;
    // 传输层错误直接抛给渲染端计次重试；协议层的 pending / 失败走返回的 DTO。
    let outcome = poll_registration(&client, &mut session).await?;
    let mut inner = host.lock().await;
    let same_session = current_device_code(&inner).as_deref() == Some(session.device_code.as_str());
    if let PollOutcome::Done { app_id, app_secret } = &outcome {
        let credentials = StoredCredentials {
            app_id: app_id.clone(),
            app_secret: app_secret.clone(),
            saved_at: Some(chrono::Utc::now().to_rfc3339()),
        };
        // 落盘失败就留着会话（服务端在有效期内还会给凭证），让用户能重试。
        store_credentials(&host_ctx, &credentials)?;
        inner.credentials = Some(credentials);
        inner.detail = None;
        if same_session {
            inner.registration = None;
        }
        log::info("feishu", "扫码创建应用成功，凭证已落盘");
        return Ok(RegisterPollDto {
            state: outcome.state().into(),
            detail: None,
            app_id: Some(app_id.clone()),
            interval_ms: None,
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
        interval_ms: Some(session.interval.as_millis() as u64),
    })
}

/// 取消扫码创建（作废本次 device_code，不再轮询）。
pub async fn feishu_register_cancel(host: &FeishuHost) -> Result<(), String> {
    host.lock().await.registration = None;
    Ok(())
}

fn current_device_code(inner: &Inner) -> Option<String> {
    inner
        .registration
        .as_ref()
        .map(|session| session.device_code.clone())
}

/// 启动长连接（未配置凭证时报错，由界面引导去设置里填）。
pub async fn feishu_connect(
    host_ctx: Arc<dyn HostContext>,
    host: &FeishuHost,
    allow_other_senders: bool,
) -> Result<(), String> {
    let (app_id, app_secret) = {
        let mut inner = host.lock().await;
        ensure_loaded(&host_ctx, &mut inner)?;
        let credentials = inner.credentials.clone().ok_or("尚未配置飞书应用凭证")?;
        (credentials.app_id, credentials.app_secret)
    };
    let epoch = host.epoch.fetch_add(1, Ordering::SeqCst) + 1;
    // 上次会话遗留的未取走收件文件先清掉（渲染端崩溃 / 未取走）。
    prune_inbox(host_ctx.as_ref(), DIR_NAME, false);
    let inner = host.inner.clone();
    let epochs = host.epoch.clone();
    let deps = StreamDeps::for_host(&host_ctx);
    set_state(&inner, &deps, "connecting", None).await;
    tokio::spawn(async move {
        run_stream(
            deps,
            inner,
            epochs,
            epoch,
            StreamCredentials { app_id, app_secret },
            allow_other_senders,
        )
        .await;
    });
    Ok(())
}

/// 停止长连接（保留凭证与联系人档案）。
pub async fn feishu_disconnect(
    host_ctx: Arc<dyn HostContext>,
    host: &FeishuHost,
) -> Result<(), String> {
    host.epoch.fetch_add(1, Ordering::SeqCst);
    let mut inner = host.lock().await;
    ensure_loaded(&host_ctx, &mut inner)?;
    let deps = StreamDeps::for_host(&host_ctx);
    inner.state = "stopped".into();
    inner.detail = None;
    emit_state(&inner, &deps);
    Ok(())
}

/// 回一条文本给联系人（接收方信息在宿主侧，渲染端只传对端与文本）。
pub async fn feishu_send(
    host_ctx: Arc<dyn HostContext>,
    host: &FeishuHost,
    peer_id: String,
    text: String,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("回复内容为空".into());
    }
    let (credentials, record) = {
        let mut inner = host.lock().await;
        ensure_loaded(&host_ctx, &mut inner)?;
        let credentials = inner.credentials.clone().ok_or("尚未配置飞书应用凭证")?;
        let record = inner
            .peers
            .target(&peer_id)
            .cloned()
            .ok_or("会话信息不可用：等对方再发一条消息")?;
        (credentials, record)
    };
    let client = crate::http::shared_client(10)?;
    let token = tenant_access_token(
        &client,
        DEFAULT_DOMAIN,
        &credentials.app_id,
        &credentials.app_secret,
    )
    .await?;
    send_text(
        &client,
        DEFAULT_DOMAIN,
        &token,
        &record.receive_id_type,
        &record.receive_id,
        text.trim(),
    )
    .await
}
