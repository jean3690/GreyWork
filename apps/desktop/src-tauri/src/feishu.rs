//! feishu 的桌面命令入口；实现收在 `greywork_host::feishu`（与 headless 服务端共用）。

use std::sync::Arc;
use tauri::State;

pub use greywork_host::feishu::{
    ClientConfig, EndpointData, EndpointResponse, EventBody, EventHeader, EventMessage,
    EventSender, FeishuHost, FeishuInboundDto, FeishuStatusDto, Frame, MessageEvent, PeerBook,
    PeerRecord, PollOutcome, RegisterPollDto, RegisterSession, RegisterStartDto, SenderId,
    StoredCredentials,
};
use greywork_host::host::HostContext;

#[tauri::command]
pub async fn feishu_status(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, FeishuHost>,
) -> Result<FeishuStatusDto, String> {
    greywork_host::feishu::feishu_status(Arc::clone(&host_ctx), &host).await
}

#[tauri::command]
pub async fn feishu_save_credentials(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, FeishuHost>,
    app_id: String,
    app_secret: Option<String>,
) -> Result<FeishuStatusDto, String> {
    greywork_host::feishu::feishu_save_credentials(Arc::clone(&host_ctx), &host, app_id, app_secret)
        .await
}

#[tauri::command]
pub async fn feishu_clear_credentials(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, FeishuHost>,
) -> Result<FeishuStatusDto, String> {
    greywork_host::feishu::feishu_clear_credentials(Arc::clone(&host_ctx), &host).await
}

#[tauri::command]
pub async fn feishu_register_begin(
    host: State<'_, FeishuHost>,
) -> Result<RegisterStartDto, String> {
    greywork_host::feishu::feishu_register_begin(&host).await
}

#[tauri::command]
pub async fn feishu_register_poll(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, FeishuHost>,
) -> Result<RegisterPollDto, String> {
    greywork_host::feishu::feishu_register_poll(Arc::clone(&host_ctx), &host).await
}

#[tauri::command]
pub async fn feishu_register_cancel(host: State<'_, FeishuHost>) -> Result<(), String> {
    greywork_host::feishu::feishu_register_cancel(&host).await
}

#[tauri::command]
pub async fn feishu_connect(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, FeishuHost>,
    allow_other_senders: bool,
) -> Result<(), String> {
    greywork_host::feishu::feishu_connect(Arc::clone(&host_ctx), &host, allow_other_senders).await
}

#[tauri::command]
pub async fn feishu_disconnect(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, FeishuHost>,
) -> Result<(), String> {
    greywork_host::feishu::feishu_disconnect(Arc::clone(&host_ctx), &host).await
}

#[tauri::command]
pub async fn feishu_send(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    host: State<'_, FeishuHost>,
    peer_id: String,
    text: String,
) -> Result<(), String> {
    greywork_host::feishu::feishu_send(Arc::clone(&host_ctx), &host, peer_id, text).await
}
