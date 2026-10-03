use std::sync::Arc;

use tokio::sync::Mutex;
use wechatbot::{IncomingMessage, WeChatBotError};

use crate::channel_common::now_ms;
use crate::channel_media::{store_inbound_media, MediaRefDto, MAX_MEDIA_BYTES};
use crate::log;

use super::protocol::*;
use super::*;

/* ===== 宿主层：入站处理 ===== */

/// 入站上下文：SDK 的回调是同步的，真正的下载 / 落盘 / 广播在派生任务里按到达顺序跑。
#[derive(Clone)]
pub(super) struct InboundCtx {
    pub(super) handles: HostHandles,
    /// 串行闸：媒体下载是异步的，不串行相邻两条消息就可能乱序落到会话里。
    pub(super) serial: Arc<Mutex<()>>,
}

impl InboundCtx {
    /// SDK 的回调是同步的：这里只做转发，不做任何 await。
    pub(super) fn spawn(&self, message: &IncomingMessage) {
        let ctx = self.clone();
        let message = message.clone();
        tokio::spawn(async move { ctx.handle(message).await });
    }

    /// SDK 拿到（或换到）二维码时回调。同步上下文：只落状态 + 唤醒在等的命令。
    pub(super) fn on_qr_url(&self, url: &str) {
        let (internal, repeat) = {
            let mut run = self.handles.login.lock();
            let repeat = run.qr.is_some();
            run.qr = Some(url.to_string());
            if repeat {
                run.refreshed = true;
            }
            (!run.explicit, repeat)
        };
        log::info(
            "wechat",
            if repeat {
                "二维码已过期，SDK 自动换了新码"
            } else {
                "二维码已就绪，等待扫码"
            },
        );
        self.handles.tick();
        if internal {
            // 不是用户点出来的扫码 = SDK 在会话过期后自行重登：如实报成「已过期，请重新扫码」。
            // （SDK 会把重登做完，但那条路的二维码没有任何界面承载，用户看不到。）
            let handles = self.handles.clone();
            tokio::spawn(async move {
                handles
                    .set_state("paused", Some("登录态已过期，请重新扫码".into()))
                    .await;
            });
        }
    }

    /// SDK 报告一次请求失败（含长轮询的每一次重试）。
    pub(super) fn on_error(&self, error: &WeChatBotError) {
        let detail = error.to_string();
        log::warn("wechat", format!("通道请求失败: {detail}"));
        let handles = self.handles.clone();
        tokio::spawn(async move { handles.set_state("error", Some(detail)).await });
    }

    /// 单条入站：门禁 → 缓存回信凭据 → 下载媒体 → 广播。
    async fn handle(&self, message: IncomingMessage) {
        let _serial = self.serial.lock().await;

        if !has_recognizable_items(&message) {
            log::info("wechat", "入站消息没有可识别条目（如纯视频），忽略");
            return;
        }

        let (owner, allow_other_senders) = {
            let inner = self.handles.inner.lock().await;
            (
                inner
                    .creds
                    .as_ref()
                    .map(|creds| creds.user_id.clone())
                    .unwrap_or_default(),
                inner.allow_other_senders,
            )
        };
        // 扫码者之外的人默认不答复。拿不到归属人（登录响应没带 user_id）时不做限制：
        // 宁可答复也不要把整条通道变成静默丢弃 —— 真发生会在这里留下一行日志。
        if !allow_other_senders && !owner.is_empty() && owner != message.user_id {
            log::info(
                "wechat",
                format!(
                    "忽略非授权发送者 {}（可在设置中允许其他联系人）",
                    message.user_id
                ),
            );
            return;
        }

        // 回信凭据：微信的 context_token 按条颁发，必须原样带回被回复那条的 token。
        let token = message.context_token().to_string();
        self.handles.remember_token(&token, &message);

        let received_at = now_ms();
        let media = self.materialize(&message, received_at).await;

        let dto = WechatInboundDto {
            from_user_id: message.user_id.clone(),
            context_token: token,
            text: text_of(&message),
            item_types: item_types_of(&message),
            media,
            create_time_ms: message.raw.create_time_ms,
            at: received_at,
        };
        log::info(
            "wechat",
            format!(
                "入站 from={} types={:?} token_len={}",
                dto.from_user_id,
                dto.item_types,
                dto.context_token.len()
            ),
        );
        (self.handles.sink)(
            INBOUND_EVENT,
            serde_json::to_value(dto).unwrap_or(serde_json::Value::Null),
        );

        // 收到消息即证明通道是通的：把状态钉到 connected 并刷新「最近来信」。
        let pending = self.handles.pending_login();
        let status = {
            let mut inner = self.handles.inner.lock().await;
            inner.state = "connected".into();
            inner.detail = None;
            inner.last_message_at = Some(received_at);
            inner.status(pending)
        };
        self.handles.emit_status(status);
    }

    /// 逐条下载解密并落 inbox；单条失败只记日志，不影响同一条消息里的文本与其他媒体。
    async fn materialize(&self, message: &IncomingMessage, received_at: i64) -> Vec<MediaRefDto> {
        let items = collect_media(message);
        if items.is_empty() {
            return Vec::new();
        }
        let Some(bot) = self.handles.current_bot().await else {
            log::warn("wechat", "SDK 实例不在，入站媒体无法下载");
            return Vec::new();
        };
        let mut out = Vec::new();
        for (index, item) in items.iter().enumerate() {
            if let Some(size) = item.declared_size {
                if size > MAX_MEDIA_BYTES {
                    log::warn(
                        "wechat",
                        format!("入站媒体声明大小超过 {MAX_MEDIA_BYTES} 字节上限，跳过"),
                    );
                    continue;
                }
            }
            match bot.download_raw(&item.media, item.aes_key.as_deref()).await {
                Ok(bytes) => {
                    // SDK 的下载不带大小闸（它把整段收进内存），这里至少别把超限文件落盘。
                    if bytes.len() as u64 > MAX_MEDIA_BYTES {
                        log::warn(
                            "wechat",
                            format!("入站媒体超过 {MAX_MEDIA_BYTES} 字节上限，跳过"),
                        );
                        continue;
                    }
                    if let Some(dto) = store_inbound_media(
                        &self.handles.inbox,
                        DIR_NAME,
                        received_at,
                        index,
                        item.kind,
                        &item.name,
                        bytes,
                    ) {
                        out.push(dto);
                    }
                }
                Err(error) => {
                    // 真机排查用：把 CDN 引用的形状一并记下 ——「服务端有没有给 full_url」
                    // 与「key 是 media 自带还是 image_item.aeskey 覆盖」直接对应协议里两个
                    // 待确认项；若失败样本清一色 full_url=无，就说明按 encrypt_query_param
                    // 拼下载地址这条路不对。
                    log::warn(
                        "wechat",
                        format!(
                            "入站媒体 {} 下载失败（kind={}，full_url={}，aes_key={}）: {error}",
                            item.name,
                            item.kind.as_str(),
                            if item.media.full_url.is_some() {
                                "有"
                            } else {
                                "无"
                            },
                            if item.aes_key.is_some() {
                                "覆盖"
                            } else {
                                "自带"
                            },
                        ),
                    );
                }
            }
        }
        out
    }
}
