//! 真实第三方 agent 的权限链路验证：确认 opencode 的 ACP server 会发出
//! `session/request_permission` —— 也就是 GreyWork 的权限卡片到底能不能弹。
//!
//! **结论性前提**（2026-09 实测 opencode 1.18.31）：默认配置下它一条都不发。
//! opencode 对自己的 edit / bash / webfetch 默认是 `allow`，工具直接执行、不询问；
//! 而宿主的三档权限（只读 / 工作区 / 全权）是在「agent 来问」的那一刻才介入的，
//! 不问就等于三档全线失效。所以桌面端在 opencode 预设里注入了
//! `OPENCODE_CONFIG_CONTENT={"permission":{…:"ask"}}`（见 packages/shell/src/providers.ts），
//! 把裁决权拉回宿主。本测试复现的正是那条注入路径。
//!
//! 需要本机安装 opencode 且已配置模型凭据；未安装时跳过（保证 `cargo test` 在任何环境绿）。
use agent_client_protocol::schema::v1::{
    ContentBlock, InitializeRequest, NewSessionRequest, PermissionOptionKind, PromptRequest,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse, TextContent,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{AcpAgent, Agent as AgentRole, Client, ConnectionTo};
use std::str::FromStr;
use tokio::sync::mpsc;

/// opencode 启动环境变量名。opencode 会把它与用户自己的 `opencode.json` **合并**
/// 而非整体替换，所以注入权限不会连 provider / model 配置一起冲掉。
const OPENCODE_CONFIG_CONTENT: &str = "OPENCODE_CONFIG_CONTENT";

/// 与 `packages/shell/src/providers.ts` 的 opencode 预设逐字对应；改一边必须改另一边。
const OPENCODE_PERMISSION_CONFIG: &str =
    r#"{"permission":{"edit":"ask","bash":"ask","webfetch":"ask","websearch":"ask"}}"#;

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

    let event_loop = tokio::spawn(async move {
        let _ = Client
            .builder()
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

    let prompt = conn.clone().send_request(PromptRequest::new(
        new_session.session_id.clone(),
        vec![ContentBlock::Text(TextContent::new(
            "Run this exact shell command with the bash tool, then stop: echo hello-from-greywork",
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

    // 权限请求在回合中途到达，要等的是它而不是回合结束——所以两边赛跑：
    // 回合先结束且是模型故障 → 跳过；否则说明这条链路上根本没发权限请求。
    let permission = tokio::select! {
        request = requests_rx.recv() => request,
        outcome = done_rx.recv() => {
            event_loop.abort();
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
            panic!("agent turn ended without any session/request_permission: {detail}");
        }
    };
    event_loop.abort();

    let permission = permission.expect("permission channel closed mid-turn");
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
