//! 通道媒体层的桌面命令入口；实现收在 `greywork_host::channel_media`（与 headless 服务端共用）。
//!
//! `channel_send_media` 的「按通道上传」是**宿主专有**的一步（要从宿主取到该通道的 host），
//! 因此分发 `match` 留在本壳；共享层只做授权面 / 能力 / 降级的公共准备。

use std::collections::BTreeMap;
use std::sync::Arc;

use tauri::{AppHandle, Manager, State};

use greywork_host::host::HostContext;
use greywork_host::workspace_fs::WorkspaceFsAccess;

pub use greywork_host::channel_media::ChannelMediaCapability;

/// 取走一条入站媒体：校验路径落在该通道的收件目录内 → 读原始字节 → 删除文件。
///
/// 回原始字节（`tauri::ipc::Response`）而不是 base64 —— 与 `fs_read_binary` 同一取舍，
/// 免得 20MB 的文件被撑成 ~27MB 字符串。
#[tauri::command]
pub fn channel_take_media(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    channel: String,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    greywork_host::channel_media::channel_take_media(host_ctx.inner().as_ref(), channel, path)
        .map(tauri::ipc::Response::new)
}

/// 发一条媒体：共享层过授权面 / 卡能力 / 降级，再按通道分发给该通道的上传实现。
#[tauri::command]
// Tauri 将每个 IPC 字段与宿主 State 分别注入；合并为 DTO 会无收益地改写稳定命令协议。
#[allow(clippy::too_many_arguments)]
pub async fn channel_send_media(
    app: AppHandle,
    host_ctx: State<'_, Arc<dyn HostContext>>,
    access: State<'_, WorkspaceFsAccess>,
    channel: String,
    peer_id: String,
    path: String,
    kind: Option<String>,
    context_token: Option<String>,
) -> Result<(), String> {
    let media =
        greywork_host::channel_media::prepare_outbound(&access, &channel, &path, kind.as_deref())?;
    match channel.as_str() {
        "wechat" => {
            let wechat = app.state::<greywork_host::wechat::WechatHost>();
            greywork_host::wechat::send_media_impl(
                &host_ctx,
                &wechat,
                &peer_id,
                context_token.as_deref(),
                media,
            )
            .await
        }
        "telegram" => {
            let telegram = app.state::<greywork_host::telegram::TelegramHost>();
            greywork_host::telegram::send_media_impl(&host_ctx, &telegram, &peer_id, media).await
        }
        "discord" => {
            let discord = app.state::<greywork_host::discord::DiscordHost>();
            greywork_host::discord::send_media_impl(&host_ctx, &discord, &peer_id, media).await
        }
        "feishu" => {
            let feishu = app.state::<greywork_host::feishu::FeishuHost>();
            greywork_host::feishu::send_media_impl(&host_ctx, &feishu, &peer_id, media).await
        }
        "qq" => {
            let qq = app.state::<greywork_host::qq::QqHost>();
            greywork_host::qq::send_media_impl(&host_ctx, &qq, &peer_id, media).await
        }
        "wecom" => {
            let wecom = app.state::<greywork_host::wecom::WecomHost>();
            greywork_host::wecom::send_media_impl(&host_ctx, &wecom, &peer_id, media).await
        }
        other => Err(format!("未知通道: {other}")),
    }
}

/// 各通道的媒体能力矩阵；渲染端启动时拉一次，据此提示「这条通道能发什么」。
#[tauri::command]
pub fn channel_media_capabilities() -> BTreeMap<String, ChannelMediaCapability> {
    greywork_host::channel_media::channel_media_capabilities()
}
