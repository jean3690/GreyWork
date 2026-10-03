//! 通道媒体层的桌面命令入口；实现收在 `greywork_host::channel_media`（与 headless 服务端共用）。
//!
//! `channel_send_media` 的「按通道上传」是**宿主专有**的一步（要从宿主取到该通道的 host），
//! 因此本壳只负责把各 host 摆进 `ChannelRegistry`（服务端用 `CommandContext` 字段摆同一张表），
//! 分发逻辑收在共享层的 `send_media_via`，两端不再各写一遍 `match`。

use std::collections::BTreeMap;
use std::sync::Arc;

use tauri::{AppHandle, Manager, State};

use greywork_host::channel_media::ChannelRegistry;
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
        greywork_host::channel_media::prepare_outbound(&*access, &channel, &path, kind.as_deref())?;
    let wechat = app.state::<greywork_host::wechat::WechatHost>();
    let telegram = app.state::<greywork_host::telegram::TelegramHost>();
    let discord = app.state::<greywork_host::discord::DiscordHost>();
    let feishu = app.state::<greywork_host::feishu::FeishuHost>();
    let qq = app.state::<greywork_host::qq::QqHost>();
    let wecom = app.state::<greywork_host::wecom::WecomHost>();
    let registry = ChannelRegistry::new()
        .register("wechat", wechat.inner())
        .register("telegram", telegram.inner())
        .register("discord", discord.inner())
        .register("feishu", feishu.inner())
        .register("qq", qq.inner())
        .register("wecom", wecom.inner());
    greywork_host::channel_media::send_media_via(
        &registry,
        &host_ctx,
        &channel,
        &peer_id,
        context_token.as_deref(),
        media,
    )
    .await
}

/// 各通道的媒体能力矩阵；渲染端启动时拉一次，据此提示「这条通道能发什么」。
#[tauri::command]
pub fn channel_media_capabilities() -> BTreeMap<String, ChannelMediaCapability> {
    greywork_host::channel_media::channel_media_capabilities()
}
