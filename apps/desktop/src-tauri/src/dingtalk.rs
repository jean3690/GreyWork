//! dingtalk 的桌面命令入口；实现收在 `greywork_host::dingtalk`（与 headless 服务端共用）。

use std::sync::Arc;
use tauri::State;

pub use greywork_host::dingtalk::{
    ChatbotMessage, DingTalkHost, DingTalkInboundDto, DingTalkStatusDto, FrameHeaders, MessageText,
    PeerBook, PeerRecord, PollOutcome, RegisterPollDto, RegisterSession, RegisterStartDto,
    StoredCredentials, StreamConnection, StreamFrame,
};
use greywork_host::host::HostContext;

#[tauri::command]
pub async fn dingtalk_status(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, DingTalkHost>,
) -> Result<DingTalkStatusDto, String> {
    greywork_host::dingtalk::dingtalk_status(Arc::clone(&host_ctx), &host).await
}

#[tauri::command]
pub async fn dingtalk_save_credentials(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, DingTalkHost>,
    client_id: String,
    client_secret: Option<String>,
) -> Result<DingTalkStatusDto, String> {
    greywork_host::dingtalk::dingtalk_save_credentials(
        Arc::clone(&host_ctx),
        &host,
        client_id,
        client_secret,
    )
    .await
}

#[tauri::command]
pub async fn dingtalk_clear_credentials(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, DingTalkHost>,
) -> Result<DingTalkStatusDto, String> {
    greywork_host::dingtalk::dingtalk_clear_credentials(Arc::clone(&host_ctx), &host).await
}

#[tauri::command]
pub async fn dingtalk_register_begin(
    host: State<'_, DingTalkHost>,
) -> Result<RegisterStartDto, String> {
    greywork_host::dingtalk::dingtalk_register_begin(&host).await
}

#[tauri::command]
pub async fn dingtalk_register_poll(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, DingTalkHost>,
) -> Result<RegisterPollDto, String> {
    greywork_host::dingtalk::dingtalk_register_poll(Arc::clone(&host_ctx), &host).await
}

#[tauri::command]
pub async fn dingtalk_register_cancel(host: State<'_, DingTalkHost>) -> Result<(), String> {
    greywork_host::dingtalk::dingtalk_register_cancel(&host).await
}

#[tauri::command]
pub async fn dingtalk_connect(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, DingTalkHost>,
    allow_other_senders: bool,
) -> Result<(), String> {
    greywork_host::dingtalk::dingtalk_connect(Arc::clone(&host_ctx), &host, allow_other_senders)
        .await
}

#[tauri::command]
pub async fn dingtalk_disconnect(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, DingTalkHost>,
) -> Result<(), String> {
    greywork_host::dingtalk::dingtalk_disconnect(Arc::clone(&host_ctx), &host).await
}

#[tauri::command]
pub async fn dingtalk_send(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, DingTalkHost>,
    peer_id: String,
    text: String,
) -> Result<(), String> {
    greywork_host::dingtalk::dingtalk_send(Arc::clone(&host_ctx), &host, peer_id, text).await
}
