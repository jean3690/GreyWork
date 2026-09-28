//! 真实第三方 agent 的权限链路验证：确认 opencode 的 ACP server 会发出
//! `session/request_permission` —— 也就是 GreyWork 的权限卡片到底能不能弹。
//!
//! **结论性前提**（2026-09 实测 opencode 1.18.31 / 2.0.18）：默认配置下它一条都不发。
//! opencode 对自己的 edit / shell / webfetch 默认是 `allow`，工具直接执行、不询问；
//! 而宿主的三档权限（只读 / 工作区 / 全权）是在「agent 来问」的那一刻才介入的，
//! 不问就等于三档全线失效。所以桌面端在 opencode 预设里注入了
//! `OPENCODE_CONFIG_CONTENT={…}`（见 packages/shell/src/providers.ts），
//! 把裁决权拉回宿主。本测试复现的正是那条注入路径。
//! 注意 v2 改了权限配置形状（permission 对象+bash → permissions 数组+shell），
//! 注入必须同时带两种形状，只写一边就有版本静默退回全放行。
//!
//! 需要本机安装 opencode 且已配置模型凭据；未安装时跳过（保证 `cargo test` 在任何环境绿）。
use agent_client_protocol::schema::v1::{
    ContentBlock, InitializeRequest, NewSessionRequest, PermissionOptionKind, PromptRequest,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    SessionNotification, SessionUpdate, TextContent,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{AcpAgent, Agent as AgentRole, Client, ConnectionTo};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;

/// opencode 启动环境变量名。opencode 会把它与用户自己的 `opencode.json` **合并**
/// 而非整体替换，所以注入权限不会连 provider / model 配置一起冲掉。
const OPENCODE_CONFIG_CONTENT: &str = "OPENCODE_CONFIG_CONTENT";

/// 与 `packages/shell/src/providers.ts` 的 opencode 预设逐字对应；改一边必须改另一边。
/// 同时带 v1（permission 对象 + bash）与 v2（permissions 数组 + shell）两种形状。
const OPENCODE_PERMISSION_CONFIG: &str = r#"{"permission":{"edit":"ask","bash":"ask","webfetch":"ask","websearch":"ask"},"permissions":[{"action":"edit","resource":"*","effect":"ask"},{"action":"shell","resource":"*","effect":"ask"},{"action":"webfetch","resource":"*","effect":"ask"},{"action":"websearch","resource":"*","effect":"ask"}]}"#;

fn opencode_available() -> bool {
    std::process::Command::new("opencode")
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

/// 模型层故障（凭据失效 / 限流 / 模型被禁用）会让回合走不到工具调用，
/// 此时「没有权限请求」不代表权限链路坏了——降级为跳过语义。
fn looks_like_model_failure(detail: &str) -> bool {
    [
        "Model is disabled",
        "APIError",
        "rate limit",
        "not authenticated",
        // 传输层故障同样让回合走不到工具调用，但报的是 certificate / connection 这类字样。
        // 不补的话，受限网络（企业代理自签证书、CA 过期、断网、瞬时抖动）会把本该「跳过」
        // 的情况变成硬失败 —— 而本测试要验的是权限链路，不是网络可达性。
        "certificate",
        "connection refused",
        "timed out",
        "dns error",
    ]
    .iter()
    .any(|needle| detail.contains(needle))
}

#[tokio::test]
async fn opencode_acp_raises_permission_request() {
    if !opencode_available() {
        println!("opencode not installed; skipping real-agent permission flow");
        return;
    }

    // 独立临时 cwd：这一回合要 agent 去执行命令，别落到仓库里。
    let workdir = std::env::temp_dir().join(format!("gw-opencode-perm-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&workdir);
    std::fs::create_dir_all(&workdir).expect("create temp workspace");

    let agent = AcpAgent::new(
        AcpAgent::from_str("opencode acp")
            .expect("valid command")
            .into_config()
            .envs(vec![(
                OPENCODE_CONFIG_CONTENT.to_string(),
                OPENCODE_PERMISSION_CONFIG.to_string(),
            )]),
    );

    let (requests_tx, mut requests_rx) = mpsc::unbounded_channel::<RequestPermissionRequest>();
    let (ready_tx, mut ready_rx) = mpsc::channel::<ConnectionTo<AgentRole>>(1);
    // 会话通知里出现 ToolCall（任意阶段）而权限请求没到 = 真回归（工具被放行、
    // 根本没来问宿主）；模型没调工具则不会有 ToolCall，属行为噪音，可重试。
    let tool_call_seen = Arc::new(AtomicBool::new(false));
    let tool_call_in_loop = Arc::clone(&tool_call_seen);

    let event_loop = tokio::spawn(async move {
        let _ = Client
            .builder()
            .on_receive_notification(
                {
                    let tool_call_in_loop = Arc::clone(&tool_call_in_loop);
                    async move |notification: SessionNotification,
                                _conn: ConnectionTo<AgentRole>| {
                        if matches!(notification.update, SessionUpdate::ToolCall(_)) {
                            tool_call_in_loop.store(true, Ordering::SeqCst);
                        }
                        Ok::<(), agent_client_protocol::Error>(())
                    }
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .on_receive_request(
                move |request: RequestPermissionRequest,
                      responder: agent_client_protocol::Responder<RequestPermissionResponse>,
                      _conn: ConnectionTo<AgentRole>| {
                    let tx = requests_tx.clone();
                    async move {
                        let _ = tx.send(request);
                        // 一律取消：本测试只验证「请求能上来」，绝不让 agent 真的执行命令。
                        responder.respond(RequestPermissionResponse::new(
                            RequestPermissionOutcome::Cancelled,
                        ))
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .connect_with(agent, |conn: ConnectionTo<AgentRole>| async move {
                let _ = ready_tx.send(conn).await;
                let never: Result<(), agent_client_protocol::Error> = std::future::pending().await;
                never
            })
            .await;
    });

    let conn = tokio::time::timeout(std::time::Duration::from_secs(30), ready_rx.recv())
        .await
        .expect("handshake timeout")
        .expect("connection ready");

    conn.clone()
        .send_request(InitializeRequest::new(ProtocolVersion::V1))
        .block_task()
        .await
        .expect("initialize with real opencode agent");

    let new_session = conn
        .clone()
        .send_request(NewSessionRequest::new(workdir.clone()))
        .block_task()
        .await
        .expect("session/new with real opencode agent");

    // 权限请求在回合中途到达，要等的是它而不是回合结束——所以两边赛跑。
    // 回合先结束有三种可能：模型故障或模型始终不调工具 → 跳过（链路没被
    // 触达，无从验证）；工具跑了却没来问（ToolCall 通知在、权限请求缺席）
    // → 链路回归，立即硬失败；其余重试，最多 5 次。
    let mut permission = None;
    for attempt in 1..=5 {
        let prompt = conn.clone().send_request(PromptRequest::new(
            new_session.session_id.clone(),
            vec![ContentBlock::Text(TextContent::new(
                // 别点名工具名（v1 叫 bash、v2 改叫 shell）：点名旧名会让模型
                // 找不到工具而直接文本作答，权限链路根本没机会走。
                "Run this exact shell command, then stop: echo hello-from-greywork",
            ))],
        ));
        let (done_tx, mut done_rx) = mpsc::channel::<Result<(), String>>(1);
        tokio::spawn(async move {
            let result = prompt
                .block_task()
                .await
                .map(|_| ())
                .map_err(|error| error.to_string());
            let _ = done_tx.send(result).await;
        });

        tokio::select! {
            request = requests_rx.recv() => {
                permission = Some(request.expect("permission channel closed mid-turn"));
                break;
            }
            outcome = done_rx.recv() => {
                let detail = match outcome {
                    Some(Ok(())) => "turn ended cleanly without requesting any tool".to_string(),
                    Some(Err(error)) => error,
                    None => "prompt task dropped".to_string(),
                };
                if looks_like_model_failure(&detail) {
                    println!("model service unavailable ({detail}); permission assertion skipped");
                    let _ = std::fs::remove_dir_all(&workdir);
                    return;
                }
                // 通知分发与回合结束响应在 crate 内是并发任务，ToolCall 标记可能
                // 比 done 晚一小步：留 250ms 宽限再下结论。
                if !tool_call_seen.load(Ordering::SeqCst) {
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                }
                if tool_call_seen.load(Ordering::SeqCst) {
                    // 工具确实跑了却没有任何权限请求：链路回归，立即硬失败
                    //（测试客户端对权限请求一律回取消，工具能跑只可能是被放行）。
                    event_loop.abort();
                    let _ = std::fs::remove_dir_all(&workdir);
                    panic!("tool call ran without any session/request_permission: {detail}");
                }
                if attempt < 5 {
                    println!("attempt {attempt}: no permission request ({detail}); retrying");
                } else {
                    // 五次尝试模型都没调任何工具：权限链路根本没被触达，这是模型
                    // 行为噪音（与链路无关），同模型故障降级为跳过。真回归不会
                    // 走到这里——工具被放行必然产生 ToolCall 通知，被上面拦下。
                    event_loop.abort();
                    println!(
                        "model never invoked a tool in {attempt} attempts ({detail}); permission assertion skipped"
                    );
                    let _ = std::fs::remove_dir_all(&workdir);
                    return;
                }
            }
        }
    }
    event_loop.abort();
    let permission = permission.expect("retry loop exited without permission or panic");
    let options = &permission.options;
    println!(
        "opencode permission request: kind={:?} title={:?} locations={} options={}",
        permission.tool_call.fields.kind,
        permission.tool_call.fields.title,
        permission
            .tool_call
            .fields
            .locations
            .as_deref()
            .unwrap_or_default()
            .len(),
        options.len(),
    );

    // 卡片的三块数据源：选项（按钮）、类别（图标+文案）、rawInput（命令正文）。
    assert!(
        options
            .iter()
            .any(|option| matches!(option.kind, PermissionOptionKind::AllowOnce)),
        "权限请求必须给出 AllowOnce 选项，否则卡片连「允许一次」都渲染不出来"
    );
    assert!(
        permission.tool_call.fields.kind.is_some(),
        "工具类别为空会让卡片无法选图标与文案"
    );
    assert!(
        permission.tool_call.fields.raw_input.is_some(),
        "rawInput 是卡片展示命令正文的来源"
    );
    assert!(
        !new_session.session_id.to_string().is_empty(),
        "real session id expected"
    );

    let _ = std::fs::remove_dir_all(&workdir);
}
