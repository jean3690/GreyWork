//! wechat 的桌面命令入口；实现收在 `greywork_host::wechat`（与 headless 服务端共用）。

use std::sync::Arc;
use tauri::State;

use greywork_host::host::HostContext;
pub use greywork_host::wechat::{
    WechatHost, WechatInboundDto, WechatLoginPollDto, WechatQrDto, WechatStatusDto,
};

#[tauri::command]
pub async fn wechat_status(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, WechatHost>,
) -> Result<WechatStatusDto, String> {
    greywork_host::wechat::wechat_status(Arc::clone(&host_ctx), &host).await
}

#[tauri::command]
pub async fn wechat_login_qr(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, WechatHost>,
) -> Result<WechatQrDto, String> {
    greywork_host::wechat::wechat_login_qr(Arc::clone(&host_ctx), &host).await
}

#[tauri::command]
pub async fn wechat_login_poll(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, WechatHost>,
) -> Result<WechatLoginPollDto, String> {
    greywork_host::wechat::wechat_login_poll(Arc::clone(&host_ctx), &host).await
}

#[tauri::command]
pub async fn wechat_login_cancel(host: State<'_, WechatHost>) -> Result<(), String> {
    greywork_host::wechat::wechat_login_cancel(&host).await
}

#[tauri::command]
pub async fn wechat_connect(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, WechatHost>,
    allow_other_senders: bool,
) -> Result<(), String> {
    greywork_host::wechat::wechat_connect(Arc::clone(&host_ctx), &host, allow_other_senders).await
}

#[tauri::command]
pub async fn wechat_disconnect(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, WechatHost>,
) -> Result<(), String> {
    greywork_host::wechat::wechat_disconnect(Arc::clone(&host_ctx), &host).await
}

#[tauri::command]
pub async fn wechat_logout(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, WechatHost>,
) -> Result<(), String> {
    greywork_host::wechat::wechat_logout(Arc::clone(&host_ctx), &host).await
}

#[tauri::command]
pub async fn wechat_send(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, WechatHost>,
    to_user_id: String,
    context_token: String,
    text: String,
) -> Result<(), String> {
    greywork_host::wechat::wechat_send(
        Arc::clone(&host_ctx),
        &host,
        to_user_id,
        context_token,
        text,
    )
    .await
}

#[tauri::command]
pub async fn wechat_send_typing(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, WechatHost>,
    to_user_id: String,
    typing: bool,
) -> Result<(), String> {
    greywork_host::wechat::wechat_send_typing(Arc::clone(&host_ctx), &host, to_user_id, typing)
        .await
}
