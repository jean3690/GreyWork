//! wecom 的桌面命令入口；实现收在 `greywork_host::wecom`（与 headless 服务端共用）。

use std::sync::Arc;
use tauri::State;

use greywork_host::host::HostContext;
pub use greywork_host::wecom::{
    ChatScope, PeerBook, PeerRecord, StoredCredentials, WecomHost, WecomInboundDto, WecomStatusDto,
};

#[tauri::command]
pub async fn wecom_status(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, WecomHost>,
) -> Result<WecomStatusDto, String> {
    greywork_host::wecom::wecom_status(Arc::clone(&host_ctx), &host).await
}

#[tauri::command]
pub async fn wecom_save_credentials(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, WecomHost>,
    bot_id: String,
    secret: Option<String>,
) -> Result<WecomStatusDto, String> {
    greywork_host::wecom::wecom_save_credentials(Arc::clone(&host_ctx), &host, bot_id, secret).await
}

#[tauri::command]
pub async fn wecom_clear_credentials(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, WecomHost>,
) -> Result<WecomStatusDto, String> {
    greywork_host::wecom::wecom_clear_credentials(Arc::clone(&host_ctx), &host).await
}

#[tauri::command]
pub async fn wecom_connect(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, WecomHost>,
    allow_other_senders: bool,
) -> Result<(), String> {
    greywork_host::wecom::wecom_connect(Arc::clone(&host_ctx), &host, allow_other_senders).await
}

#[tauri::command]
pub async fn wecom_disconnect(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, WecomHost>,
) -> Result<(), String> {
    greywork_host::wecom::wecom_disconnect(Arc::clone(&host_ctx), &host).await
}

#[tauri::command]
pub async fn wecom_send(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, WecomHost>,
    peer_id: String,
    text: String,
) -> Result<(), String> {
    greywork_host::wecom::wecom_send(Arc::clone(&host_ctx), &host, peer_id, text).await
}
