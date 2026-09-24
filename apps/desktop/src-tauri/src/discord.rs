//! discord 的桌面命令入口；实现收在 `greywork_host::discord`（与 headless 服务端共用）。

use std::sync::Arc;
use tauri::State;

pub use greywork_host::discord::{
    CloseAction, DiscordHost, DiscordInboundDto, DiscordStatusDto, PeerBook, PeerRecord,
    StoredCredentials,
};
use greywork_host::host::HostContext;

#[tauri::command]
pub async fn discord_status(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, DiscordHost>,
) -> Result<DiscordStatusDto, String> {
    greywork_host::discord::discord_status(Arc::clone(&host_ctx), &host).await
}

#[tauri::command]
pub async fn discord_save_credentials(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, DiscordHost>,
    token: String,
) -> Result<DiscordStatusDto, String> {
    greywork_host::discord::discord_save_credentials(Arc::clone(&host_ctx), &host, token).await
}

#[tauri::command]
pub async fn discord_clear_credentials(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, DiscordHost>,
) -> Result<DiscordStatusDto, String> {
    greywork_host::discord::discord_clear_credentials(Arc::clone(&host_ctx), &host).await
}

#[tauri::command]
pub async fn discord_connect(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, DiscordHost>,
    allow_other_senders: bool,
) -> Result<(), String> {
    greywork_host::discord::discord_connect(Arc::clone(&host_ctx), &host, allow_other_senders).await
}

#[tauri::command]
pub async fn discord_disconnect(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, DiscordHost>,
) -> Result<(), String> {
    greywork_host::discord::discord_disconnect(Arc::clone(&host_ctx), &host).await
}

#[tauri::command]
pub async fn discord_send(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, DiscordHost>,
    peer_id: String,
    text: String,
) -> Result<(), String> {
    greywork_host::discord::discord_send(Arc::clone(&host_ctx), &host, peer_id, text).await
}
