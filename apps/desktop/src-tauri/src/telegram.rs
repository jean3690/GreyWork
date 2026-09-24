//! telegram 的桌面命令入口；实现收在 `greywork_host::telegram`（与 headless 服务端共用）。

use std::sync::Arc;
use tauri::State;

use greywork_host::host::HostContext;
pub use greywork_host::telegram::{
    PeerBook, PeerRecord, StoredCredentials, TelegramBotLinkDto, TelegramHost, TelegramInboundDto,
    TelegramStatusDto,
};

#[tauri::command]
pub async fn telegram_status(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, TelegramHost>,
) -> Result<TelegramStatusDto, String> {
    greywork_host::telegram::telegram_status(Arc::clone(&host_ctx), &host).await
}

#[tauri::command]
pub async fn telegram_save_credentials(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, TelegramHost>,
    token: String,
) -> Result<TelegramStatusDto, String> {
    greywork_host::telegram::telegram_save_credentials(Arc::clone(&host_ctx), &host, token).await
}

#[tauri::command]
pub async fn telegram_clear_credentials(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, TelegramHost>,
) -> Result<TelegramStatusDto, String> {
    greywork_host::telegram::telegram_clear_credentials(Arc::clone(&host_ctx), &host).await
}

#[tauri::command]
pub async fn telegram_connect(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, TelegramHost>,
    allow_other_senders: bool,
) -> Result<(), String> {
    greywork_host::telegram::telegram_connect(Arc::clone(&host_ctx), &host, allow_other_senders)
        .await
}

#[tauri::command]
pub async fn telegram_disconnect(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, TelegramHost>,
) -> Result<(), String> {
    greywork_host::telegram::telegram_disconnect(Arc::clone(&host_ctx), &host).await
}

#[tauri::command]
pub async fn telegram_send(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, TelegramHost>,
    peer_id: String,
    text: String,
) -> Result<(), String> {
    greywork_host::telegram::telegram_send(Arc::clone(&host_ctx), &host, peer_id, text).await
}

#[tauri::command]
pub async fn telegram_bot_link(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, TelegramHost>,
) -> Result<TelegramBotLinkDto, String> {
    greywork_host::telegram::telegram_bot_link(Arc::clone(&host_ctx), &host).await
}
