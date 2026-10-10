//! 会话生命周期：新建 / 恢复 / 配置 / 改档位 / 列出。

use std::sync::Arc;

use agent_client_protocol::schema::v1::{
    LoadSessionRequest, NewSessionRequest, SessionConfigOptionValue, SessionId,
    SetSessionConfigOptionRequest,
};

use crate::host::HostContext;

use super::policy::{validate_cwd, PermissionTier};
use super::state::{emit, AcpHost};

/// 在已启动的 agent 上创建 ACP 会话（session/new）。cwd 由宿主校验。
///
/// `mcp_servers` 是用户在设置页声明的 MCP 服务器：按 agent 的 `mcpCapabilities`
/// 过滤后随 `session/new` 一起交给 agent，由 **agent** 去连接并把工具并入它的
/// 工具面。宿主不代理工具调用。
///
/// 返回 `{ sessionId, configOptions, mcpServers, skippedMcpServers }`：
/// configOptions 为 agent 暴露的会话级选择器（模型 / 推理力度 / 模式等），
/// 不支持时为空数组；mcpServers 是真正声明出去的名字，skippedMcpServers 带原因，
/// 让前端能明确告诉用户「这台被跳过了，因为该后端不支持 http」。
pub async fn acp_new_session(
    host: Arc<dyn HostContext>,
    state: &Arc<AcpHost>,
    handle: u64,
    cwd: String,
    mcp_servers: Option<Vec<crate::mcp::McpServerConfig>>,
) -> Result<serde_json::Value, String> {
    let cwd = validate_cwd(&cwd)?;
    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(&handle)
        .ok_or_else(|| format!("unknown handle {handle}"))?;
    // 更新本 handle 的文件系统锚定基准：本会话的工作区根。
    session.workspace_root = Some(cwd.clone());

    let (servers, skipped) =
        crate::mcp::plan_servers(&mcp_servers.unwrap_or_default(), &session.mcp_capabilities);
    let declared: Vec<String> = servers.iter().map(crate::mcp::server_name).collect();

    let response = session
        .conn
        .clone()
        .send_request(NewSessionRequest::new(cwd).mcp_servers(servers))
        .block_task()
        .await
        .map_err(|error| format!("session/new failed: {error}"))?;
    let session_id = response.session_id.clone();
    let id_str = session_id.to_string();
    let config_options = serde_json::to_value(response.config_options.unwrap_or_default())
        .unwrap_or_else(|_| serde_json::Value::Array(Vec::new()));
    session.session_id = Some(session_id);
    emit(
        host.as_ref(),
        "session-new",
        serde_json::json!({
            "handle": handle,
            "sessionId": id_str,
            "mcpServers": declared,
            "skippedMcpServers": skipped,
            "imagePrompts": session.image_prompts,
        }),
    );
    Ok(serde_json::json!({
        "sessionId": id_str,
        "configOptions": config_options,
        "mcpServers": declared,
        "skippedMcpServers": skipped,
        "imagePrompts": session.image_prompts,
    }))
}

/// 恢复一条已存在的 ACP 会话（session/load），把既有上下文接回来——实现「重启不丢会话」。
///
/// 与 `acp_new_session` 共享门禁与 MCP 过滤逻辑；不同点：
/// - 能力预检：agent 未声明 `load_session` 直接 `Err`，不发请求、不改 `session.session_id`，
///   让前端静默回落 `acp_new_session`（无副作用）。
/// - **仅请求成功时**才回写 `session.session_id` 并 emit `session-load`；失败不改任何状态，
///   前端可原样回落 new。
/// - `LoadSessionResponse` 不含 sessionId（用传入的那个），返回外形与 `acp_new_session` 对齐。
pub async fn acp_load_session(
    host: Arc<dyn HostContext>,
    state: &Arc<AcpHost>,
    handle: u64,
    cwd: String,
    session_id: String,
    mcp_servers: Option<Vec<crate::mcp::McpServerConfig>>,
) -> Result<serde_json::Value, String> {
    let cwd = validate_cwd(&cwd)?;
    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(&handle)
        .ok_or_else(|| format!("unknown handle {handle}"))?;
    if !session.load_session {
        return Err("agent does not support session/load".to_string());
    }

    let (servers, skipped) =
        crate::mcp::plan_servers(&mcp_servers.unwrap_or_default(), &session.mcp_capabilities);
    let declared: Vec<String> = servers.iter().map(crate::mcp::server_name).collect();

    let response = session
        .conn
        .clone()
        .send_request(
            LoadSessionRequest::new(SessionId::from(session_id.clone()), &cwd).mcp_servers(servers),
        )
        .block_task()
        .await
        .map_err(|error| format!("session/load failed: {error}"))?;
    let id_str = session_id;
    let config_options = serde_json::to_value(response.config_options.unwrap_or_default())
        .unwrap_or_else(|_| serde_json::Value::Array(Vec::new()));
    // 仅请求成功后才有状态改写：session_id 回写 + 工作区锚定基准更新。
    // 失败路径必须保持原样——锚定若提前换成新 cwd，回落 new 前旧会话的
    // 越界拦截会按错误基准判定。
    session.session_id = Some(SessionId::from(id_str.clone()));
    session.workspace_root = Some(cwd);
    emit(
        host.as_ref(),
        "session-load",
        serde_json::json!({
            "handle": handle,
            "sessionId": id_str,
            "mcpServers": declared,
            "skippedMcpServers": skipped,
            "imagePrompts": session.image_prompts,
        }),
    );
    Ok(serde_json::json!({
        "sessionId": id_str,
        "restored": true,
        "configOptions": config_options,
        "mcpServers": declared,
        "skippedMcpServers": skipped,
        "imagePrompts": session.image_prompts,
    }))
}

/// 设置会话配置选项（session/set_config_option）：模型 / 推理力度 / 会话模式等。
/// select 选项传字符串值，boolean 选项传布尔值；返回全量最新配置选项。
pub async fn acp_set_config(
    state: &Arc<AcpHost>,
    handle: u64,
    config_id: String,
    value: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let option_value = match value {
        serde_json::Value::String(raw) => SessionConfigOptionValue::value_id(raw),
        serde_json::Value::Bool(flag) => SessionConfigOptionValue::boolean(flag),
        other => {
            return Err(format!(
                "unsupported config value {other}; expected string or bool"
            ))
        }
    };
    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(&handle)
        .ok_or_else(|| format!("unknown handle {handle}"))?;
    let session_id = session
        .session_id
        .clone()
        .ok_or_else(|| "session not created; call acp_new_session first".to_string())?;

    let response = session
        .conn
        .clone()
        .send_request(SetSessionConfigOptionRequest::new(
            session_id,
            config_id,
            option_value,
        ))
        .block_task()
        .await
        .map_err(|error| format!("session/set_config_option failed: {error}"))?;

    Ok(serde_json::to_value(&response).unwrap_or(serde_json::Value::Null))
}

/// 改写在途会话的权限档位（前端「临时只读」开关；未知档位串 fail-closed 到 ReadOnly）。
pub async fn acp_set_permission_tier(
    state: &Arc<AcpHost>,
    handle: u64,
    tier: String,
) -> Result<(), String> {
    state
        .set_tier(handle, PermissionTier::parse(Some(&tier)))
        .await
}

/// 当前存活句柄清单（诊断用）。
pub async fn acp_list(state: &Arc<AcpHost>) -> Result<Vec<serde_json::Value>, String> {
    let sessions = state.sessions.lock().await;
    Ok(sessions
        .iter()
        .map(|(id, session)| {
            serde_json::json!({
                "handle": id,
                "command": session.command,
                "hasSession": session.session_id.is_some(),
            })
        })
        .collect())
}
