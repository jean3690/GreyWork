//! `acp_start`：spawn 外部 ACP agent 并完成 initialize 握手。

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    InitializeRequest, RequestPermissionRequest, SessionNotification,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{
    AcpAgent, Agent as AgentRole, Client, ConnectionTo, Error as AcpError,
};

use crate::host::HostContext;
use crate::process_guard;

use super::env::{handshake_timeout_secs, sanitize_env, stderr_hint, ALLOWED_AGENT_PROGRAMS};
use super::events::classify_notification;
use super::permission::resolve_permission;
use super::policy::{validate_cwd, PermissionTier};
use super::state::{emit, AcpHost, AcpSession};

/// 启动外部 ACP agent 子进程并完成 initialize 握手，返回主机句柄 id。
///
/// `sandbox` 取沙盒策略（"auto" | "off" | "fs" | "full"）：未知值拒绝；auto
/// 在 bwrap 可用时启用 fs，不可用时记录明确告警后直启。
/// `env` 是该后端的启动环境变量（设置里配的 API key 之类），净化后注入子进程；
/// 沙盒开启时同样生效（bwrap 不清空环境，只覆盖 HOME）。
///
/// `extra_programs` 是「在 [`ALLOWED_AGENT_PROGRAMS`] 之外额外放行」的程序名，由**调用方**
/// 决定来源：桌面端传 `db.enabled_agent_programs()`（用户自配后端目录），服务端传配置里
/// 冻结的列表（不读 DB —— DB 可被客户端经 `db_agents_sync` 改写，是 RCE 面）。
/// 放在入参而非在本函数内查库，正是为了让两侧各自决定信任来源。
// Tauri 将每个 IPC 字段与宿主 State 分别注入；合并为 DTO 会无收益地改写稳定命令协议。
#[allow(clippy::too_many_arguments)]
pub async fn acp_start(
    host: Arc<dyn HostContext>,
    state: &Arc<AcpHost>,
    extra_programs: &[String],
    access: &dyn crate::core::ports::WorkspaceFs,
    agent_cmd: String,
    tier: Option<String>,
    sandbox: Option<String>,
    workspace: Option<String>,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<u64, String> {
    // 但仅限「用户已在目录里启用」的程序（目录真源归 Rust，渲染端不可自封）。
    // shell 元字符拒绝不受影响，仍是配置注入的最后防线。
    let mut allowed: Vec<&str> = ALLOWED_AGENT_PROGRAMS.to_vec();
    allowed.extend(extra_programs.iter().map(String::as_str));
    let command = process_guard::validate_spawn_command(&agent_cmd, &allowed)?;
    // 冷启动窗口按「用户原始命令」判断：npx 型后端首次运行要下载包，需放宽到 120s。
    // 之后的包装会把首 token 换掉（沙盒是 bwrap、Windows 是 cmd），拿包装后的串判断会失准。
    let handshake_secs = handshake_timeout_secs(&command);
    let tier = PermissionTier::parse(tier.as_deref());

    let requested_mode = crate::sandbox::SandboxMode::parse(sandbox.as_deref())?;
    let sandbox_available = crate::sandbox::sandbox_available();
    let (mode, degraded) = requested_mode.resolve(sandbox_available);
    if degraded {
        // 不可用的两种情形：非 Linux（bwrap 只有 Linux 有），或 Linux 上 bwrap 装了却
        // 建不出沙盒（容器里缺命名空间权限，见 sandbox::bwrap_functional 的告警）。
        // 无论哪种都不能让 agent 起不来 —— 设置可能是从别的机器同步过来的。降级但留痕。
        crate::log::warn(
            "sandbox",
            format!(
                "沙盒档位 {requested_mode:?} 在本机不可用：降级为 off，\
                 ACP agent 将以无 OS 隔离状态启动（权限档位仍然生效）"
            ),
        );
    }
    let cwd = workspace
        .as_deref()
        .map(|raw| {
            access
                .validate_existing(raw)
                .and_then(|path| validate_cwd(&path.to_string_lossy()))
        })
        .transpose()?;
    let command = if mode == crate::sandbox::SandboxMode::Off {
        command
    } else {
        // mode != Off 只可能来自 resolve 的「bwrap 可用」分支，无需再查可用性。
        let cwd = cwd
            .as_deref()
            .ok_or_else(|| "sandbox: workspace is required when sandbox is enabled".to_string())?;
        // home_dir 取自 HostPaths（桌面侧由 Tauri 的 `home_dir()` 在启动期填好）。
        // 不用裸 `HOME`：Windows 上对应的是 `USERPROFILE`，只读 `HOME` 会拿不到值，
        // agent 的配置目录就静默不挂载。路径在进程启动时已解析，这里必然有效。
        crate::sandbox::wrap_command(mode, cwd, Some(&host.paths().home_dir), &command)?
    };

    let handle_id = state.next_id.fetch_add(1, Ordering::SeqCst);
    let mut env_vars = sanitize_env(env)?;
    // 只改探测不够：agent 自己也要按 PATH 找 `npx`/`node`。用户没显式指定 PATH 时注入
    // 解析到的登录 shell PATH（见 process_guard::init_login_path；Windows 恒为 None）。
    if !env_vars.iter().any(|(name, _)| name == "PATH") {
        if let Some(pair) = process_guard::path_env() {
            env_vars.push(pair);
        }
    }
    // Windows 上 npx/npm 等是 .cmd 垫片，CreateProcess 起不来：这里归一成 `cmd /C ...`。
    // 其他平台恒等返回（见 process_guard::shell_command）。
    let spawn_command = process_guard::shell_command(&command);
    let agent = AcpAgent::from_str(&spawn_command)
        .map_err(|error| format!("invalid agent command: {error}"))?;
    let agent = if env_vars.is_empty() {
        agent
    } else {
        AcpAgent::new(agent.into_config().envs(env_vars))
    };

    // 自己 spawn，而不是让 crate 的 `AcpAgent::connect_to` 代劳：进程所有权留在宿主手里，
    // 停止时才能按**进程树**回收 —— Windows 上直接子进程是 cmd.exe（`.cmd` 垫片包装），
    // 真正干活的 agent 是它的孙子，crate 的 ChildGuard 只 TerminateProcess 直接子进程。
    let (child_stdin, child_stdout, child_stderr, child) = agent
        .spawn_process()
        .map_err(|error| format!("failed to start agent '{command}': {error}"))?;
    // 只取 pid：drop 掉 Child 不会杀进程（async-process 的全局 reaper 负责收尸），
    // 回收交给传输层的进程树守卫。
    let pid = child.id();
    drop(child);
    // stderr 必须排空，否则管道写满会卡死 agent；尾部留作失败诊断。
    let stderr_tail = crate::acp_process::drain_stderr(child_stderr);
    let transport = crate::acp_process::AgentStdio::new(child_stdin, child_stdout, pid);

    let (ready_tx, mut ready_rx) = tokio::sync::mpsc::channel::<ConnectionTo<AgentRole>>(1);
    // 连接任务活到 acp_stop，期间要发事件、读权限档位：两者都得是 owned Arc
    // （`&dyn HostContext` / `&AcpHost` 借不进 'static 的 spawn）。
    let host_task = Arc::clone(&host);
    let acp_task = Arc::clone(state);

    let task = tokio::spawn(async move {
        let _ = Client
            .builder()
            .on_receive_notification(
                {
                    let host = Arc::clone(&host_task);
                    async move |notification: SessionNotification,
                                _conn: ConnectionTo<AgentRole>| {
                        classify_notification(host.as_ref(), notification);
                        Ok::<(), AcpError>(())
                    }
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .on_receive_request(
                {
                    let host = Arc::clone(&host_task);
                    let acp = Arc::clone(&acp_task);
                    async move |request: RequestPermissionRequest,
                                responder,
                                _conn: ConnectionTo<AgentRole>| {
                        let response =
                            resolve_permission(host.as_ref(), acp.as_ref(), handle_id, request)
                                .await;
                        responder.respond(response)
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .connect_with(transport, |conn: ConnectionTo<AgentRole>| async move {
                let _ = ready_tx.send(conn).await;
                // 保持连接事件循环存活直至 acp_stop abort；闭包契约要求返回 Result
                let never: Result<(), AcpError> = std::future::pending().await;
                never
            })
            .await;
    });

    let ready = tokio::time::timeout(Duration::from_secs(handshake_secs), ready_rx.recv())
        .await
        .map_err(|_| {
            // 超时回收：npx 冷启动可能仍在下游拉包，不 abort 会留孤儿进程
            // （abort → 传输层 future drop → 进程树守卫回收）。
            let hint = stderr_hint(&stderr_tail);
            task.abort();
            format!(
                "agent handshake timeout after {handshake_secs}s: '{command}' did not become \
                 ready (npx/npm 首次运行需下载，可再试一次){hint}"
            )
        })?
        .ok_or_else(|| {
            let hint = stderr_hint(&stderr_tail);
            task.abort();
            format!("agent connection closed before ready{hint}")
        })?;
    let conn = ready;

    // initialize 回包里带 agent 的 MCP 传输能力：留着给 acp_new_session 做声明过滤，
    // 免得把 http 服务器塞给只支持 stdio 的 agent 而让整个 session/new 失败。
    let initialize = conn
        .clone()
        .send_request(InitializeRequest::new(ProtocolVersion::V1))
        .block_task()
        .await
        .map_err(|error| {
            let hint = stderr_hint(&stderr_tail);
            task.abort();
            format!("initialize failed: {error}{hint}")
        })?;
    let mcp_capabilities = initialize.agent_capabilities.mcp_capabilities.clone();
    // 顺手记下是否支持 session/load：恢复会话时据此决定是否走 load 而非 new，
    // 避免对不支持的 agent 发无谓请求（协议只在声明过的会话上才返回 load_session）。
    let load_session = initialize.agent_capabilities.load_session;
    let image_prompts = initialize.agent_capabilities.prompt_capabilities.image;

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
            load_session,
            image_prompts,
        },
    );
    emit(
        host.as_ref(),
        "started",
        serde_json::json!({ "handle": handle_id }),
    );
    Ok(handle_id)
}
