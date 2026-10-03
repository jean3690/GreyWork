use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{watch, Mutex};
use wechatbot::{BotOptions, Credentials, IncomingMessage, WeChatBot, WeChatBotError};

use crate::log;

use super::inbound::*;
use super::persist::*;
use super::*;

/* ===== 宿主层：SDK 实例 ===== */

/// 取当前 SDK 实例；没有就带着回调建一个。
///
/// 回调与宿主之间只共享 `HostHandles`：SDK 的回调是同步的，落状态用同步锁、
/// 真正的 IO 一律派生任务，避免把长轮询的读循环卡在宿主的异步锁上。
pub(super) async fn ensure_bot(handles: HostHandles) -> Result<Arc<WeChatBot>, String> {
    let mut slot = handles.bot.lock().await;
    if let Some(bot) = slot.as_ref() {
        return Ok(bot.clone());
    }
    let ctx = InboundCtx {
        handles: handles.clone(),
        serial: Arc::new(Mutex::new(())),
    };
    let bot = Arc::new(WeChatBot::new(BotOptions {
        // 初始入口由 SDK 内置；登录成功后它会切到服务端下发的 baseurl（宿主在下发处校验）。
        base_url: None,
        cred_path: Some(handles.cred_path.to_string_lossy().into_owned()),
        on_qr_url: Some({
            let ctx = ctx.clone();
            Box::new(move |url: &str| ctx.on_qr_url(url))
        }),
        on_error: Some({
            let ctx = ctx.clone();
            Box::new(move |error: &WeChatBotError| ctx.on_error(error))
        }),
        bot_agent: Some(format!("GreyWork/{}", env!("CARGO_PKG_VERSION"))),
        // 配对码要用户在手机上读出来再填进本机，设置页没有这个输入面：如实记一行日志后交空串，
        // 让服务端把这次扫码判掉（SDK 会当作配对被拒 → 换码 → 多次后放弃）。
        on_verify_code: Some(Box::new(|retry: bool| {
            log::warn(
                "wechat",
                if retry {
                    "服务端要求配对码，但当前界面没有输入入口，本次登录将失败"
                } else {
                    "服务端要求配对码，但当前界面没有输入入口"
                },
            );
            String::new()
        })),
    }));
    bot.on_message(Box::new({
        let ctx = ctx.clone();
        move |message: &IncomingMessage| ctx.spawn(message)
    }))
    .await;
    *slot = Some(bot.clone());
    Ok(bot)
}

/// 丢掉当前实例（退出登录 / 登录地址不可信时）：SDK 没有 logout，只有重建才能清掉它内部的凭证。
pub(super) async fn drop_bot(handles: &HostHandles) {
    handles.bot.lock().await.take();
}

/* ===== 宿主层：扫码登录 ===== */

/// 后台跑 SDK 的 `login`：它阻塞到确认 / 放弃，宿主只把结果镜像进 `LoginRun`。
pub(super) async fn run_login(handles: HostHandles, generation: u64) {
    let bot = match ensure_bot(handles.clone()).await {
        Ok(bot) => bot,
        Err(error) => {
            finish_login(handles, generation, Err(error)).await;
            return;
        }
    };
    // force = false：本地已有可用凭证时直接复用（不发扫码），让「已登录再点扫码」也不炸。
    let result = bot.login(false).await.map_err(|error| error.to_string());
    finish_login(handles, generation, result).await;
}

/// 登录任务的收尾：校验登录地址 → 收紧凭证权限 → 写回 `LoginRun` → 广播状态。
pub(super) async fn finish_login(
    handles: HostHandles,
    generation: u64,
    result: Result<Credentials, String>,
) {
    let outcome = match result {
        Ok(creds) => match trusted_api_base(&creds.base_url) {
            Ok(_) => {
                harden_credentials(&handles.cred_path);
                log::info("wechat", format!("扫码登录成功 bot={}", creds.account_id));
                LoginOutcome::Confirmed {
                    user_id: creds.user_id.clone(),
                    bot_id: creds.account_id.clone(),
                }
            }
            Err(error) => {
                // 地址不可信：凭证已经落盘（SDK 写的），删掉并丢掉这个实例，绝不拿它发请求。
                let _ = std::fs::remove_file(&handles.cred_path);
                drop_bot(&handles).await;
                log::warn(
                    "wechat",
                    format!("登录下发的地址不可信，已丢弃凭证: {error}"),
                );
                LoginOutcome::Failed(error)
            }
        },
        Err(error) => {
            log::warn("wechat", format!("扫码登录失败: {error}"));
            LoginOutcome::Failed(error)
        }
    };

    let confirmed = matches!(outcome, LoginOutcome::Confirmed { .. });
    {
        let mut run = handles.login.lock();
        if run.generation != generation {
            log::info("wechat", "已作废的扫码会话结束，忽略其结果");
            return;
        }
        run.outcome = Some(outcome);
    }
    // 凭证可能刚落地：刷新内存里的登录态（loggedIn 要立刻反映出来）。
    {
        let mut inner = handles.inner.lock().await;
        inner.creds = read_creds(&handles.cred_path);
    }
    if confirmed {
        // 登录完成即回到「已登录、未连接」：渲染端确认后自己会去 connect。
        handles.set_state("stopped", None).await;
    } else {
        handles.broadcast().await;
    }
    handles.tick();
}

/// 等 `progress` 世代号变化；超时或发送端消失都按「没动静」返回。
pub(super) async fn wait_progress(rx: &mut watch::Receiver<u64>, seen: u64, hold: Duration) -> u64 {
    match tokio::time::timeout(hold, rx.wait_for(|value| *value != seen)).await {
        Ok(Ok(guard)) => *guard,
        _ => seen,
    }
}
