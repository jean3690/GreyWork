use std::sync::Arc;

use wechatbot::SendContent;

use crate::channel_media::{prune_inbox, MediaKind, OutboundMedia};
use crate::host::HostContext;
use crate::log;

use super::connect::*;
use super::persist::*;
use super::protocol::*;
use super::*;

/// 当前通道状态（含是否已登录、长轮询状态、最近收消息时间）。
pub async fn wechat_status(
    host_ctx: Arc<dyn HostContext>,
    host: &WechatHost,
) -> Result<WechatStatusDto, String> {
    let handles = host.handles(&host_ctx)?;
    let pending = handles.pending_login();
    let mut inner = handles.inner.lock().await;
    ensure_loaded(&handles, &mut inner);
    // SDK 可能在后台完成过一次登录（例如会话过期后自行重登）：内存里没有就回读一次盘。
    if inner.creds.is_none() {
        inner.creds = read_creds(&handles.cred_path);
    }
    Ok(inner.status(pending))
}

/// 申请登录二维码；返回要编码成二维码的链接文本。
///
/// SDK 的登录是「后台跑 + 回调给码」，这里等首张码就绪再返回，保持「调一次拿到码」的契约。
pub async fn wechat_login_qr(
    host_ctx: Arc<dyn HostContext>,
    host: &WechatHost,
) -> Result<WechatQrDto, String> {
    let handles = host.handles(&host_ctx)?;

    // 已有进行中的显式扫码：把那张码还回去，别起第二个登录任务。
    let (existing_qr, generation) = {
        let mut run = handles.login.lock();
        let in_flight = run.explicit && run.qr.is_some() && run.outcome.is_none();
        if in_flight {
            (run.qr.clone(), None)
        } else {
            run.generation = run.generation.wrapping_add(1);
            run.explicit = true;
            run.qr = None;
            run.refreshed = false;
            run.outcome = None;
            (None, Some(run.generation))
        }
    };
    let Some(generation) = generation else {
        return Ok(WechatQrDto {
            content: existing_qr.unwrap_or_default(),
        });
    };

    if let Some(previous) = host.login_task.lock().await.take() {
        previous.abort();
    }
    let task = {
        let handles = handles.clone();
        tokio::spawn(async move { run_login(handles, generation).await })
    };
    *host.login_task.lock().await = Some(task);

    let mut rx = handles.progress.subscribe();
    let mut seen = *rx.borrow();
    let deadline = tokio::time::Instant::now() + LOGIN_QR_TIMEOUT;
    loop {
        {
            let run = handles.login.lock();
            if run.generation == generation {
                if let Some(qr) = run.qr.clone() {
                    return Ok(WechatQrDto { content: qr });
                }
                if let Some(outcome) = run.outcome.as_ref() {
                    return Err(match outcome {
                        LoginOutcome::Failed(detail) => detail.clone(),
                        LoginOutcome::Confirmed { bot_id, .. } => {
                            format!("该账号已登录（bot={bot_id}），无需重新扫码")
                        }
                    });
                }
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("等待二维码超时".into());
        }
        seen = wait_progress(&mut rx, seen, LOGIN_QR_TIMEOUT).await;
    }
}

/// 轮询扫码结果；一次调用最多挂 `LOGIN_POLL_HOLD`（前端按长轮询使用）。
///
/// 返回：`wait`（还在等扫）/ `expired`（换码，带新二维码内容；或带 `detail` 表示失败）/
/// `confirmed`。SDK 不暴露「已扫码待确认」，故不会有 `scaned`。
pub async fn wechat_login_poll(
    host_ctx: Arc<dyn HostContext>,
    host: &WechatHost,
) -> Result<WechatLoginPollDto, String> {
    let handles = host.handles(&host_ctx)?;
    let generation = handles.login.lock().generation;
    let mut rx = handles.progress.subscribe();
    let mut seen = *rx.borrow();
    let deadline = tokio::time::Instant::now() + LOGIN_POLL_HOLD;

    loop {
        let result = {
            let mut run = handles.login.lock();
            if run.generation != generation || run.qr.is_none() {
                // 会话已被取消 / 被新的扫码取代：让前端的轮询循环干净收尾。
                Some(WechatLoginPollDto {
                    status: "expired".into(),
                    qr_content: None,
                    user_id: None,
                    bot_id: None,
                    detail: Some("本次扫码已结束".into()),
                })
            } else if let Some(outcome) = run.outcome.take() {
                run.qr = None;
                run.explicit = false;
                Some(match outcome {
                    LoginOutcome::Confirmed { user_id, bot_id } => WechatLoginPollDto {
                        status: "confirmed".into(),
                        qr_content: None,
                        user_id: Some(user_id),
                        bot_id: Some(bot_id),
                        detail: None,
                    },
                    LoginOutcome::Failed(detail) => WechatLoginPollDto {
                        status: "expired".into(),
                        qr_content: None,
                        user_id: None,
                        bot_id: None,
                        detail: Some(detail),
                    },
                })
            } else if run.refreshed {
                run.refreshed = false;
                Some(WechatLoginPollDto {
                    status: "expired".into(),
                    qr_content: run.qr.clone(),
                    user_id: None,
                    bot_id: None,
                    detail: None,
                })
            } else {
                None
            }
        };

        if let Some(result) = result {
            handles.broadcast().await;
            return Ok(result);
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(WechatLoginPollDto {
                status: "wait".into(),
                qr_content: None,
                user_id: None,
                bot_id: None,
                detail: None,
            });
        }
        seen = wait_progress(&mut rx, seen, LOGIN_POLL_HOLD).await;
    }
}

/// 取消进行中的扫码会话（关闭二维码视图时调用）。
///
/// SDK 的登录一旦开始就无法从外部中止，所以这里只作废宿主侧的会话与界面状态；
/// 若用户其实已经扫过码，服务端仍会确认，凭证会落地并在下一次状态刷新时体现出来。
pub async fn wechat_login_cancel(host: &WechatHost) -> Result<(), String> {
    {
        let mut run = host.login.lock();
        run.generation = run.generation.wrapping_add(1);
        run.explicit = false;
        run.qr = None;
        run.refreshed = false;
        run.outcome = None;
    }
    if let Some(task) = host.login_task.lock().await.take() {
        task.abort();
    }
    let next = host.progress.borrow().wrapping_add(1);
    let _ = host.progress.send(next);
    Ok(())
}

/// 启动收消息长轮询。`allow_other_senders=false` 时只放行扫码本人的消息。
pub async fn wechat_connect(
    host_ctx: Arc<dyn HostContext>,
    host: &WechatHost,
    allow_other_senders: bool,
) -> Result<(), String> {
    let handles = host.handles(&host_ctx)?;
    {
        let mut inner = handles.inner.lock().await;
        ensure_loaded(&handles, &mut inner);
        if inner.creds.is_none() {
            return Err("尚未扫码登录微信".into());
        }
        inner.allow_other_senders = allow_other_senders;
    }
    // 上一次运行可能留下没被取走的收件文件，先清掉陈旧的。
    prune_inbox(host_ctx.as_ref(), DIR_NAME, false);
    handles.set_state("connecting", None).await;

    // 换人：先停掉旧任务。abort 让断开是立即的（否则要等一轮最长 45s 的长轮询返回）。
    if let Some(previous) = host.run.lock().await.take() {
        previous.abort();
    }
    let bot = ensure_bot(handles.clone()).await?;
    // 把磁盘上的凭证装进 SDK 实例（force = false：有凭证就直接复用，不发请求）。
    let creds = bot
        .login(false)
        .await
        .map_err(|error| format!("登录凭证不可用: {error}"))?;
    // 复核一次：SDK 自己重新读了盘上的文件，它不校验地址，而 run() 会把 token 打到这个 base 上。
    trusted_api_base(&creds.base_url)?;

    let task = {
        let handles = handles.clone();
        tokio::spawn(async move {
            if let Err(error) = bot.run().await {
                log::warn("wechat", format!("长轮询异常结束: {error}"));
            }
            // 自然结束 = 没人让它停：那就是出事了，如实报出来。
            // （disconnect / 退出登录走 stop + abort，状态已被置成 stopped，这里不会再报。）
            let state = handles.inner.lock().await.state.clone();
            if state != "stopped" && state != "error" {
                handles
                    .set_state("error", Some("收消息任务已停止".into()))
                    .await;
            }
        })
    };
    *host.run.lock().await = Some(task);
    // SDK 的长轮询没有「首轮成功」回调：凭证可用 + 任务已挂起即视为已连接；
    // 真出错会经 on_error 落到 error 状态，收到任何消息也会把状态钉回 connected。
    handles.set_state("connected", None).await;
    Ok(())
}

/// 停止长轮询（保留登录态）。
pub async fn wechat_disconnect(
    host_ctx: Arc<dyn HostContext>,
    host: &WechatHost,
) -> Result<(), String> {
    let handles = host.handles(&host_ctx)?;
    handles.set_state("stopped", None).await;
    if let Some(task) = host.run.lock().await.take() {
        task.abort();
    }
    if let Some(bot) = handles.current_bot().await {
        bot.stop().await;
    }
    Ok(())
}

/// 退出登录：停长轮询 + 删除本机凭证（下次使用需重新扫码）。
pub async fn wechat_logout(
    host_ctx: Arc<dyn HostContext>,
    host: &WechatHost,
) -> Result<(), String> {
    let handles = host.handles(&host_ctx)?;
    if let Some(task) = host.run.lock().await.take() {
        task.abort();
    }
    if let Some(task) = host.login_task.lock().await.take() {
        task.abort();
    }
    if let Some(bot) = handles.current_bot().await {
        bot.stop().await;
    }
    // SDK 没有 logout：只有丢掉整个实例，它内部那份凭证缓存才会消失。
    drop_bot(&handles).await;
    {
        let mut run = handles.login.lock();
        run.generation = run.generation.wrapping_add(1);
        run.explicit = false;
        run.qr = None;
        run.refreshed = false;
        run.outcome = None;
    }
    handles.cache.lock().clear();
    for name in [CRED_FILE, LEGACY_SESSION_FILE] {
        let path = handles.cred_path.with_file_name(name);
        if path.exists() {
            if let Err(error) = std::fs::remove_file(&path) {
                log::warn("wechat", format!("删除 {} 失败: {error}", path.display()));
            }
        }
    }
    // 退出登录即清空收件目录：里面的媒体属于这次登录的会话，没有保留价值。
    prune_inbox(host_ctx.as_ref(), DIR_NAME, true);
    {
        let mut inner = handles.inner.lock().await;
        inner.creds = None;
        inner.state = "stopped".into();
        inner.detail = None;
        inner.last_message_at = None;
    }
    handles.broadcast().await;
    log::info("wechat", "已退出登录，凭证已清除");
    Ok(())
}

/// 回一条文本；`context_token` 必须来自对应入站消息（微信按条颁发，用错会被静默丢弃）。
pub async fn wechat_send(
    host_ctx: Arc<dyn HostContext>,
    host: &WechatHost,
    to_user_id: String,
    context_token: String,
    text: String,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("回复内容为空".into());
    }
    let handles = host.handles(&host_ctx)?;
    let bot = ensure_bot(handles.clone()).await?;
    let result = match handles.message_for_token(&context_token) {
        // 用「被回复的那条消息」回：token 与消息一一对应，不受后到消息覆盖影响。
        Some(message) => bot.reply(&message, &text).await,
        // 缓存里没有（宿主重启 / 太旧）时退回 SDK 的默认路径（它记着该用户最新的 token）。
        None => bot.send(&to_user_id, &text).await,
    };
    match result {
        // 出站也留一行日志：手机收不到时，「发没发出去」是第一个要回答的问题。
        Ok(()) => {
            log::info("wechat", format!("已回复 {to_user_id}"));
            Ok(())
        }
        Err(error) => {
            let detail = error.to_string();
            log::warn("wechat", format!("回复 {to_user_id} 失败: {detail}"));
            Err(detail)
        }
    }
}

/// 发送「正在输入」。
///
/// SDK 只提供「发一条正在输入」（内部固定 status=1），没有取消接口，故 `typing=false`
/// 是 no-op —— 指示器由微信自己超时消失，比旧实现少一次显式取消。
pub async fn wechat_send_typing(
    host_ctx: Arc<dyn HostContext>,
    host: &WechatHost,
    to_user_id: String,
    typing: bool,
) -> Result<(), String> {
    if !typing {
        return Ok(());
    }
    let handles = host.handles(&host_ctx)?;
    let bot = ensure_bot(handles).await?;
    bot.send_typing(&to_user_id)
        .await
        .map_err(|error| error.to_string())
}

/// 发一条媒体：交给 SDK 加密上传并发送。
///
/// 由通用命令 `channel_send_media` 分发进来（授权面、大小闸与能力校验已在那边做过），
/// 这里只管微信这一套协议：按 `context_token` 找回被回复的那条消息（微信的 token 按条
/// 颁发，用错会被服务端静默丢弃），用 SDK 的 `reply_media` / `send_media` 发出去。
///
/// 日志带上「走哪个端点（图片 / 视频 / 文件）、回复还是主动发、多大」——出站媒体端点是否
/// 被账号放行只有真机才能确认，失败时这几项能一眼区分是端点没权限、凭据过期，还是体积被拒。
impl crate::channel_media::ChannelHost for WechatHost {
    fn send_media<'a>(
        &'a self,
        host_ctx: &'a Arc<dyn HostContext>,
        peer_id: &'a str,
        context_token: Option<&'a str>,
        media: OutboundMedia,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(send_media_impl(
            host_ctx,
            self,
            peer_id,
            context_token,
            media,
        ))
    }
}

pub async fn send_media_impl(
    host_ctx: &Arc<dyn HostContext>,
    host: &WechatHost,
    to_user_id: &str,
    context_token: Option<&str>,
    media: OutboundMedia,
) -> Result<(), String> {
    let handles = host.handles(host_ctx)?;
    let bot = ensure_bot(handles.clone()).await?;
    let byte_len = media.bytes.len();
    let kind = media.kind;
    let name = media.name.clone();
    let content = match kind {
        MediaKind::Image => SendContent::Image {
            data: media.bytes,
            caption: None,
        },
        MediaKind::Video => SendContent::Video {
            data: media.bytes,
            caption: None,
        },
        // 语音无发送端点：共享层已在分发前把音频降级为文件。
        MediaKind::Audio | MediaKind::File => SendContent::File {
            data: media.bytes,
            file_name: name.clone(),
            caption: None,
        },
    };
    let reply = context_token.and_then(|token| handles.message_for_token(token));
    if context_token.is_some() && reply.is_none() {
        // 兜底：凭据过期 / 不认识时退回主动发送（协议允许但部分账号会静默丢弃），
        // 记一笔以便区分「发失败」是凭据问题还是端点问题。
        log::warn(
            "wechat",
            format!("回复凭据未命中（可能已过期），{name} 改走主动发送 → {to_user_id}"),
        );
    }
    let mode = if reply.is_some() { "reply" } else { "send" };
    let result = match reply {
        Some(message) => bot.reply_media(&message, content).await,
        None => bot.send_media(to_user_id, content).await,
    };
    match result {
        Ok(()) => {
            log::info(
                "wechat",
                format!(
                    "已发送媒体 {name}（kind={}，{mode}，{byte_len} 字节）→ {to_user_id}",
                    kind.as_str()
                ),
            );
            Ok(())
        }
        Err(error) => {
            let detail = error.to_string();
            log::warn(
                "wechat",
                format!(
                    "发送媒体 {name} 失败（kind={}，{mode}，{byte_len} 字节）→ {to_user_id}: {detail}",
                    kind.as_str()
                ),
            );
            Err(detail)
        }
    }
}
