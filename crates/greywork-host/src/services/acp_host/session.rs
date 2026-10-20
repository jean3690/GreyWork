//! 会话生命周期：新建 / 恢复 / 配置 / 改档位 / 列出。

use std::sync::Arc;

use agent_client_protocol::schema::v1::{
    CloseSessionRequest, LoadSessionRequest, NewSessionRequest, ResumeSessionRequest,
    SessionConfigOptionValue, SessionId, SessionModeId, SessionModeState,
    SetSessionConfigOptionRequest, SetSessionModeRequest,
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
/// 返回 `{ sessionId, configOptions, modes, mcpServers, skippedMcpServers }`：
/// configOptions 为 agent 暴露的会话级选择器（模型 / 推理力度 / 模式等），
/// modes 为旧版 `session/new.modes`（部分 agent 仍只用这套，见 `acp_set_mode`），
/// 不支持时分别为空数组 / null；mcpServers 是真正声明出去的名字，skippedMcpServers 带原因，
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
    let modes = response.modes;
    let config_options = serde_json::to_value(response.config_options.unwrap_or_default())
        .unwrap_or_else(|error| {
            crate::log::warn(
                "acp",
                format!("session/new 的 configOptions 序列化失败，回填空数组：{error}"),
            );
            serde_json::Value::Array(Vec::new())
        });
    session.session_id = Some(session_id);
    session.modes = modes.clone();
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
        "modes": modes,
        "mcpServers": declared,
        "skippedMcpServers": skipped,
        "imagePrompts": session.image_prompts,
    }))
}

/// 恢复一条已存在的 ACP 会话，把既有上下文接回来——实现「重启不丢会话」。
///
/// 恢复顺序按「对用户最省事」排：
/// 1. agent 声明了 `sessionCapabilities.resume` → 先发 `session/resume`。它**不重放历史**，
///    前端不必开回放抑制窗口，切回旧对话时也更快；
/// 2. resume 不可用或本次失败 → 回落 `session/load`（会重放历史，前端用回放抑制窗口兜住）；
/// 3. 两者都不支持 → 直接 `Err`，不发请求、不改 `session.session_id`，让前端静默回落
///    `acp_new_session`（无副作用）。
///
/// **仅请求成功时**才回写 `session.session_id` 并 emit `session-load`；失败不改任何状态，
/// 前端可原样回落 new。返回外形与 `acp_new_session` 对齐，另带 `restored` / `resumed`。
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
    if !session.load_session && !session.resume_session {
        return Err("agent does not support session/load or session/resume".to_string());
    }

    let (servers, skipped) =
        crate::mcp::plan_servers(&mcp_servers.unwrap_or_default(), &session.mcp_capabilities);
    let declared: Vec<String> = servers.iter().map(crate::mcp::server_name).collect();

    // 第一优先：resume。失败只记日志并继续尝试 load——旧 agent 可能声明了 resume 但
    // 该会话并未持久化（例如上次进程被强杀），此时 load 仍可能接回上下文。
    let mut resume_error: Option<String> = None;
    if session.resume_session {
        match session
            .conn
            .clone()
            .send_request(
                ResumeSessionRequest::new(SessionId::from(session_id.clone()), cwd.clone())
                    .mcp_servers(servers.clone()),
            )
            .block_task()
            .await
        {
            Ok(response) => {
                let modes = response.modes;
                let config_options =
                    serde_json::to_value(response.config_options.unwrap_or_default())
                        .unwrap_or_else(|error| {
                            crate::log::warn(
                                "acp",
                                format!("session/resume configOptions 序列化失败：{error}"),
                            );
                            serde_json::Value::Array(Vec::new())
                        });
                return Ok(adopt_restored_session(
                    host.as_ref(),
                    session,
                    handle,
                    session_id,
                    cwd,
                    config_options,
                    modes,
                    declared,
                    skipped,
                    true,
                ));
            }
            Err(error) => {
                resume_error = Some(error.to_string());
                crate::log::warn(
                    "acp",
                    format!("session/resume 失败，回落 session/load：{error}"),
                );
            }
        }
    }

    if !session.load_session {
        return Err(format!(
            "session/resume failed: {}",
            resume_error.unwrap_or_else(|| "agent does not support session/load".to_string())
        ));
    }

    let response = session
        .conn
        .clone()
        .send_request(
            LoadSessionRequest::new(SessionId::from(session_id.clone()), &cwd).mcp_servers(servers),
        )
        .block_task()
        .await
        .map_err(|error| format!("session/load failed: {error}"))?;
    let modes = response.modes;
    let config_options = serde_json::to_value(response.config_options.unwrap_or_default())
        .unwrap_or_else(|error| {
            crate::log::warn(
                "acp",
                format!("session/load configOptions 序列化失败：{error}"),
            );
            serde_json::Value::Array(Vec::new())
        });
    Ok(adopt_restored_session(
        host.as_ref(),
        session,
        handle,
        session_id,
        cwd,
        config_options,
        modes,
        declared,
        skipped,
        false,
    ))
}

/// 恢复请求成功后的统一状态改写 + 事件 + 返回载荷。
///
/// 只有走到这里才会改 `session_id` / `workspace_root`：失败路径必须保持原样——
/// 锚定若提前换成新 cwd，回落 new 前旧会话的越界拦截会按错误基准判定。
#[allow(clippy::too_many_arguments)]
fn adopt_restored_session(
    host: &dyn HostContext,
    session: &mut super::state::AcpSession,
    handle: u64,
    session_id: String,
    cwd: std::path::PathBuf,
    config_options: serde_json::Value,
    modes: Option<SessionModeState>,
    declared: Vec<String>,
    skipped: Vec<crate::mcp::McpSkipped>,
    resumed: bool,
) -> serde_json::Value {
    session.session_id = Some(SessionId::from(session_id.clone()));
    session.workspace_root = Some(cwd);
    session.modes = modes.clone();
    emit(
        host,
        "session-load",
        serde_json::json!({
            "handle": handle,
            "sessionId": session_id,
            "resumed": resumed,
            "modes": modes.clone(),
            "mcpServers": declared,
            "skippedMcpServers": skipped,
            "imagePrompts": session.image_prompts,
        }),
    );
    serde_json::json!({
        "sessionId": session_id,
        "restored": true,
        "resumed": resumed,
        "configOptions": config_options,
        "modes": modes,
        "mcpServers": declared,
        "skippedMcpServers": skipped,
        "imagePrompts": session.image_prompts,
    })
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

    Ok(serde_json::to_value(&response).unwrap_or_else(|error| {
        crate::log::warn(
            "acp",
            format!("session/set_config_option 响应序列化失败，回填 null：{error}"),
        );
        serde_json::Value::Null
    }))
}

/// 切换旧版会话模式（`session/set_mode`）。
///
/// 旧版 `modes` 只在 `session/new` / `session/load` / `session/resume` 的回包里出现；
/// agent 未声明可用模式时直接拒绝，避免向不支持的后端发无谓请求。切换成功后同步内存
/// 快照并广播 `mode` 事件——agent 也可能自行发 `current_mode_update`，前端按最新值覆盖。
pub async fn acp_set_mode(
    host: Arc<dyn HostContext>,
    state: &Arc<AcpHost>,
    handle: u64,
    mode_id: String,
) -> Result<serde_json::Value, String> {
    let (session_id, mode_id) = {
        let mut sessions = state.sessions.lock().await;
        let session = sessions
            .get_mut(&handle)
            .ok_or_else(|| format!("unknown handle {handle}"))?;
        let session_id = session
            .session_id
            .clone()
            .ok_or_else(|| "session not created; call acp_new_session first".to_string())?;
        let modes = session
            .modes
            .as_ref()
            .ok_or_else(|| "agent does not support session modes".to_string())?;
        if !modes
            .available_modes
            .iter()
            .any(|mode| mode.id.to_string() == mode_id)
        {
            return Err(format!("unknown session mode {mode_id}"));
        }

        session
            .conn
            .clone()
            .send_request(SetSessionModeRequest::new(
                session_id.clone(),
                SessionModeId::new(mode_id.clone()),
            ))
            .block_task()
            .await
            .map_err(|error| format!("session/set_mode failed: {error}"))?;

        if let Some(modes) = session.modes.as_mut() {
            modes.current_mode_id = SessionModeId::new(mode_id.clone());
        }
        (session_id, mode_id)
    };

    emit(
        host.as_ref(),
        "mode",
        serde_json::json!({
            "handle": handle,
            "sessionId": session_id.to_string(),
            "currentModeId": mode_id,
        }),
    );
    Ok(serde_json::json!({ "modeId": mode_id }))
}

/// 关闭当前 ACP 会话（`session/close`），但**保留 agent 进程**供下一条会话复用。
///
/// 用途：用户切到另一条对话时，旧会话不必再占着 agent 的内存 / 子进程（MCP 连接、
/// 索引缓存等），又没必要为了换会话重启整个 CLI。agent 未声明 `close` 能力时
/// 返回 `Ok(false)` 而不是报错——这是可选的资源回收，不该阻断换会话。
///
/// 成功后清掉 `session_id` / `workspace_root`：该 handle 回到「已启动但未建会话」，
/// 下一次 `session/new` 或 `session/load` 才能重新建立锚定。待决权限一并取消，
/// 否则被关闭会话的权限卡会挂到超时。
pub async fn acp_close_session(
    host: Arc<dyn HostContext>,
    state: &Arc<AcpHost>,
    handle: u64,
    expected_session_id: Option<String>,
) -> Result<bool, String> {
    let (session_id, closed) = {
        let mut sessions = state.sessions.lock().await;
        let session = sessions
            .get_mut(&handle)
            .ok_or_else(|| format!("unknown handle {handle}"))?;
        let Some(session_id) = session.session_id.clone() else {
            return Ok(false);
        };
        // 调用方带 sessionId 时必须是当前会话：避免前端状态滞后，把刚建好的新会话关掉。
        if expected_session_id.is_some_and(|expected| expected != session_id.to_string()) {
            return Ok(false);
        }
        if !session.close_session {
            return Ok(false);
        }
        session
            .conn
            .clone()
            .send_request(CloseSessionRequest::new(session_id.clone()))
            .block_task()
            .await
            .map_err(|error| format!("session/close failed: {error}"))?;
        session.session_id = None;
        session.workspace_root = None;
        session.modes = None;
        // 会话都关了，在途回合的取消句柄也不再有效；留着只会让后续 stop 打到旧请求。
        session.turns.clear();
        (session_id, true)
    };

    super::permission::release_pending_permissions(state, handle).await;
    emit(
        host.as_ref(),
        "session-closed",
        serde_json::json!({
            "handle": handle,
            "sessionId": session_id.to_string(),
            "closed": closed,
        }),
    );
    Ok(closed)
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
