//! qq 的桌面命令入口；实现收在 `greywork_host::qq`（与 headless 服务端共用）。

use std::sync::Arc;
use tauri::State;

use greywork_host::host::HostContext;
pub use greywork_host::qq::{
    ChatScope, PeerBook, PeerRecord, PollOutcome, QqHost, QqInboundDto, QqStatusDto,
    RegisterPollDto, RegisterSession, RegisterStartDto, StoredCredentials,
};

#[tauri::command]
pub async fn qq_status(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, QqHost>,
) -> Result<QqStatusDto, String> {
    greywork_host::qq::qq_status(Arc::clone(&host_ctx), &host).await
}

#[tauri::command]
pub async fn qq_save_credentials(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, QqHost>,
    app_id: String,
    app_secret: Option<String>,
) -> Result<QqStatusDto, String> {
    greywork_host::qq::qq_save_credentials(Arc::clone(&host_ctx), &host, app_id, app_secret).await
}

#[tauri::command]
pub async fn qq_register_begin(host: State<'_, QqHost>) -> Result<RegisterStartDto, String> {
    greywork_host::qq::qq_register_begin(&host).await
}

#[tauri::command]
pub async fn qq_register_poll(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, QqHost>,
) -> Result<RegisterPollDto, String> {
    greywork_host::qq::qq_register_poll(Arc::clone(&host_ctx), &host).await
}

#[tauri::command]
pub async fn qq_register_cancel(host: State<'_, QqHost>) -> Result<(), String> {
    greywork_host::qq::qq_register_cancel(&host).await
}

#[tauri::command]
pub async fn qq_clear_credentials(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, QqHost>,
) -> Result<QqStatusDto, String> {
    greywork_host::qq::qq_clear_credentials(Arc::clone(&host_ctx), &host).await
}

#[tauri::command]
pub async fn qq_connect(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, QqHost>,
    allow_other_senders: bool,
) -> Result<(), String> {
    greywork_host::qq::qq_connect(Arc::clone(&host_ctx), &host, allow_other_senders).await
}

#[tauri::command]
pub async fn qq_disconnect(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, QqHost>,
) -> Result<(), String> {
    greywork_host::qq::qq_disconnect(Arc::clone(&host_ctx), &host).await
}

#[tauri::command]
pub async fn qq_send(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, QqHost>,
    peer_id: String,
    text: String,
) -> Result<(), String> {
    greywork_host::qq::qq_send(Arc::clone(&host_ctx), &host, peer_id, text).await
}
