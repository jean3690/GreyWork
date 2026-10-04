use std::sync::atomic::Ordering;
use std::sync::Arc;

use crate::channel_common::{channel_dir, now_ms};
use crate::channel_media::prune_inbox;
use crate::host::HostContext;
use crate::log;

use super::connect::*;
use super::persist::*;
use super::protocol::*;
use super::*;

/* ===== 宿主层：Tauri 命令 ===== */

/// 当前通道状态（是否已配置凭证、长连接状态、已建档联系人数）。
pub async fn dingtalk_status(
    host_ctx: Arc<dyn HostContext>,
    host: &DingTalkHost,
) -> Result<DingTalkStatusDto, String> {
    let mut inner = host.lock().await;
    ensure_loaded(&host_ctx, &mut inner)?;
    Ok(inner.status())
}

/// 保存应用凭证（clientId = AppKey，clientSecret = AppSecret）。
/// `client_secret` 缺省表示仅更新 clientId / 保持原密钥不变。
pub async fn dingtalk_save_credentials(
    host_ctx: Arc<dyn HostContext>,
    host: &DingTalkHost,
    client_id: String,
    client_secret: Option<String>,
) -> Result<DingTalkStatusDto, String> {
    let client_id = client_id.trim().to_string();
    if client_id.is_empty() {
        return Err("clientId 不能为空".into());
    }
    let mut inner = host.lock().await;
    ensure_loaded(&host_ctx, &mut inner)?;
    let secret = client_secret
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            inner
                .credentials
                .as_ref()
                .map(|credentials| credentials.client_secret.clone())
        });
    let Some(secret) = secret else {
        return Err("clientSecret 不能为空".into());
    };
    let credentials = StoredCredentials {
        client_id,
        client_secret: secret,
        saved_at: Some(chrono::Utc::now().to_rfc3339()),
    };
    store_credentials(&host_ctx, &credentials)?;
    inner.credentials = Some(credentials);
    // 换了凭证就作废 accessToken：旧票据属于上一个应用。
    inner.access_token = None;
    inner.token_expires_at = 0;
    inner.detail = None;
    log::info("dingtalk", "应用凭证已保存");
    Ok(inner.status())
}

/// 清除凭证与联系人凭据（相当于退出登录）。
pub async fn dingtalk_clear_credentials(
    host_ctx: Arc<dyn HostContext>,
    host: &DingTalkHost,
) -> Result<DingTalkStatusDto, String> {
    host.epoch.fetch_add(1, Ordering::SeqCst);
    let mut inner = host.lock().await;
    ensure_loaded(&host_ctx, &mut inner)?;
    inner.credentials = None;
    inner.peers = PeerBook::default();
    inner.registration = None;
    inner.access_token = None;
    inner.token_expires_at = 0;
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
    log::info("dingtalk", "凭证已清除");
    prune_inbox(host_ctx.as_ref(), DIR_NAME, true);
    Ok(inner.status())
}

/// 发起扫码创建应用：返回二维码链接与配对码（`device_code` 留在宿主内存）。
pub async fn dingtalk_register_begin(host: &DingTalkHost) -> Result<RegisterStartDto, String> {
    let client = crate::http::shared_client(10)?;
    let (session, dto) = begin_registration(&client, REGISTRATION_BASE_URL).await?;
    log::info("dingtalk", "已发起扫码创建应用");
    host.lock().await.registration = Some(session);
    Ok(dto)
}

/// 轮询扫码结果：成功时凭证直接落盘并写进宿主状态，渲染端只需刷新状态。
pub async fn dingtalk_register_poll(
    host_ctx: Arc<dyn HostContext>,
    host: &DingTalkHost,
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
        if current_device_code(&inner).as_deref() == Some(session.device_code.as_str()) {
            inner.registration = None;
        }
        return Ok(RegisterPollDto {
            state: "expired".into(),
            detail: None,
            client_id: None,
        });
    }

    let client = crate::http::shared_client(10)?;
    // 传输层错误 / `errcode != 0` 直接抛给渲染端计次重试；协议层的 pending / 失败走返回的 DTO。
    let outcome = poll_registration(&client, REGISTRATION_BASE_URL, &session).await?;
    let mut inner = host.lock().await;
    let same_session = current_device_code(&inner).as_deref() == Some(session.device_code.as_str());
    if let PollOutcome::Done {
        client_id,
        client_secret,
    } = &outcome
    {
        let credentials = StoredCredentials {
            client_id: client_id.clone(),
            client_secret: client_secret.clone(),
            saved_at: Some(chrono::Utc::now().to_rfc3339()),
        };
        // 落盘失败就留着会话（服务端在有效期内还会给凭证），让用户能重试。
        store_credentials(&host_ctx, &credentials)?;
        inner.credentials = Some(credentials);
        inner.detail = None;
        if same_session {
            inner.registration = None;
        }
        log::info("dingtalk", "扫码创建应用成功，凭证已落盘");
        return Ok(RegisterPollDto {
            state: outcome.state().into(),
            detail: None,
            client_id: Some(client_id.clone()),
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
        client_id: None,
    })
}

/// 取消扫码创建（作废本次 device_code，不再轮询）。
pub async fn dingtalk_register_cancel(host: &DingTalkHost) -> Result<(), String> {
    host.lock().await.registration = None;
    Ok(())
}

fn current_device_code(inner: &Inner) -> Option<String> {
    inner
        .registration
        .as_ref()
        .map(|session| session.device_code.clone())
}

/// 启动 Stream 长连接（未配置凭证时报错，由界面引导去设置里填）。
pub async fn dingtalk_connect(
    host_ctx: Arc<dyn HostContext>,
    host: &DingTalkHost,
    allow_other_senders: bool,
) -> Result<(), String> {
    let (client_id, client_secret) = {
        let mut inner = host.lock().await;
        ensure_loaded(&host_ctx, &mut inner)?;
        let credentials = inner.credentials.clone().ok_or("尚未配置钉钉应用凭证")?;
        inner.state = "connecting".into();
        inner.detail = None;
        (credentials.client_id, credentials.client_secret)
    };
    let epoch = host.epoch.fetch_add(1, Ordering::SeqCst) + 1;
    // 上次会话遗留的未取走收件图片先清掉（渲染端崩溃 / 未取走）。
    prune_inbox(host_ctx.as_ref(), DIR_NAME, false);
    let inner = host.inner.clone();
    let epochs = host.epoch.clone();
    let deps = StreamDeps::for_host(&host_ctx);
    let handle = Arc::clone(&host_ctx);
    set_state(&inner, &deps, "connecting", None).await;
    tokio::spawn(async move {
        run_stream(
            &handle,
            deps,
            inner,
            epochs,
            epoch,
            StreamCredentials {
                client_id,
                client_secret,
            },
            allow_other_senders,
        )
        .await;
    });
    Ok(())
}

/// 停止长连接（保留凭证与联系人凭据）。
pub async fn dingtalk_disconnect(
    host_ctx: Arc<dyn HostContext>,
    host: &DingTalkHost,
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

/// 回一条文本给联系人（凭据在宿主侧：sessionWebhook 不出宿主）。
pub async fn dingtalk_send(
    host_ctx: Arc<dyn HostContext>,
    host: &DingTalkHost,
    peer_id: String,
    text: String,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("回复内容为空".into());
    }
    let (record, owner) = {
        let mut inner = host.lock().await;
        ensure_loaded(&host_ctx, &mut inner)?;
        let now = now_ms();
        let record = inner
            .peers
            .live_webhook(&peer_id, now)
            .cloned()
            .ok_or("会话凭据不可用：等对方再发一条消息（钉钉的回复凭据约 30 分钟过期）")?;
        (record, Some(peer_id.clone()))
    };
    let client = crate::http::shared_client(10)?;
    reply_via_webhook(&client, &record.webhook, text.trim(), owner.as_deref()).await
}
