//! acp_host 的桌面命令入口；实现收在 `greywork_host::acp_host`（与 headless 服务端共用）。

use std::sync::Arc;
use tauri::State;

pub use greywork_host::acp_host::{AcpHost, AgentProgramProbe, PromptUnit};
use greywork_host::host::HostContext;

#[tauri::command]
pub async fn acp_permission_respond(
    state: State<'_, Arc<AcpHost>>,
    request_id: u64,
    option_id: Option<String>,
) -> Result<(), String> {
    greywork_host::acp_host::acp_permission_respond(&state, request_id, option_id).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn acp_start(
    host: State<'_, Arc<dyn HostContext>>,
    state: State<'_, Arc<AcpHost>>,
    db: State<'_, greywork_host::db::Db>,
    access: State<'_, greywork_host::workspace_fs::WorkspaceFsAccess>,
    agent_cmd: String,
    tier: Option<String>,
    sandbox: Option<String>,
    workspace: Option<String>,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<u64, String> {
    // 桌面语义：用户在目录里启用的自配后端同样放行（服务端则用冻结配置，不读 DB）。
    let extra_programs = db.enabled_agent_programs();
    greywork_host::acp_host::acp_start(
        Arc::clone(&host),
        &state,
        &extra_programs,
        &*access,
        agent_cmd,
        tier,
        sandbox,
        workspace,
        env,
    )
    .await
}

#[tauri::command]
pub async fn acp_new_session(
    host: State<'_, Arc<dyn HostContext>>,
    state: State<'_, Arc<AcpHost>>,
    handle: u64,
    cwd: String,
    mcp_servers: Option<Vec<greywork_host::mcp::McpServerConfig>>,
) -> Result<serde_json::Value, String> {
    greywork_host::acp_host::acp_new_session(Arc::clone(&host), &state, handle, cwd, mcp_servers)
        .await
}

#[tauri::command]
pub async fn acp_load_session(
    host: State<'_, Arc<dyn HostContext>>,
    state: State<'_, Arc<AcpHost>>,
    handle: u64,
    cwd: String,
    session_id: String,
    mcp_servers: Option<Vec<greywork_host::mcp::McpServerConfig>>,
) -> Result<serde_json::Value, String> {
    greywork_host::acp_host::acp_load_session(
        Arc::clone(&host),
        &state,
        handle,
        cwd,
        session_id,
        mcp_servers,
    )
    .await
}

#[tauri::command]
pub async fn acp_send(
    host: State<'_, Arc<dyn HostContext>>,
    state: State<'_, Arc<AcpHost>>,
    handle: u64,
    text: String,
    units: Option<Vec<PromptUnit>>,
) -> Result<serde_json::Value, String> {
    greywork_host::acp_host::acp_send(Arc::clone(&host), &state, handle, text, units).await
}

#[tauri::command]
pub async fn acp_set_config(
    state: State<'_, Arc<AcpHost>>,
    handle: u64,
    config_id: String,
    value: serde_json::Value,
) -> Result<serde_json::Value, String> {
    greywork_host::acp_host::acp_set_config(&state, handle, config_id, value).await
}

#[tauri::command]
pub async fn acp_stop(
    host: State<'_, Arc<dyn HostContext>>,
    state: State<'_, Arc<AcpHost>>,
    handle: u64,
    turn_id: Option<u64>,
) -> Result<(), String> {
    greywork_host::acp_host::acp_stop(Arc::clone(&host), &state, handle, turn_id).await
}

#[tauri::command]
pub async fn acp_set_permission_tier(
    state: State<'_, Arc<AcpHost>>,
    handle: u64,
    tier: String,
) -> Result<(), String> {
    greywork_host::acp_host::acp_set_permission_tier(&state, handle, tier).await
}

#[tauri::command]
pub async fn acp_list(state: State<'_, Arc<AcpHost>>) -> Result<Vec<serde_json::Value>, String> {
    greywork_host::acp_host::acp_list(&state).await
}

#[tauri::command]
pub fn acp_detect_programs(programs: Vec<String>) -> Vec<AgentProgramProbe> {
    greywork_host::acp_host::acp_detect_programs(programs)
}
