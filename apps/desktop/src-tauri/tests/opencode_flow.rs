//! 真实第三方 agent 对接验证：spawn `opencode acp`（OpenCode 1.18+ 的 ACP server 模式），
//! 走 initialize → session/new → set_config_option(模型) → prompt 全链路。需要本机安装 opencode 且已配置模型凭据；
//! 未安装时跳过（保证 `cargo test` 在任何环境绿）。
use agent_client_protocol::schema::v1::{
    ContentBlock, InitializeRequest, NewSessionRequest, PromptRequest, SessionConfigId,
    SessionConfigKind, SessionConfigOptionValue, SessionConfigSelectOptions, SessionNotification,
    SetSessionConfigOptionRequest, TextContent,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{AcpAgent, Agent as AgentRole, Client, ConnectionTo};
use std::path::PathBuf;
use std::str::FromStr;
use tokio::sync::mpsc;

fn opencode_available() -> bool {
    std::process::Command::new("opencode")
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[tokio::test]
async fn opencode_acp_handshake_and_prompt() {
    if !opencode_available() {
        println!("opencode not installed; skipping real-agent flow");
        return;
    }

    let project_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|path| path.parent())
        .map(|path| path.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));

    let agent = AcpAgent::from_str("opencode acp").expect("valid command");

    let (chunks_tx, mut chunks_rx) = mpsc::unbounded_channel::<String>();
    let (ready_tx, mut ready_rx) = mpsc::channel::<ConnectionTo<AgentRole>>(1);

    let event_loop = tokio::spawn(async move {
        let _ = Client
            .builder()
            .on_receive_notification(
                move |notification: SessionNotification, _conn: ConnectionTo<AgentRole>| {
                    let tx = chunks_tx.clone();
                    async move {
                        if let agent_client_protocol::schema::v1::SessionUpdate::AgentMessageChunk(
                            content,
                        ) = notification.update
                        {
                            if let agent_client_protocol::schema::v1::ContentBlock::Text(text) =
                                content.content
                            {
                                let _ = tx.send(text.text);
                            }
                        }
                        Ok::<(), agent_client_protocol::Error>(())
                    }
                },
                agent_client_protocol::on_receive_notification!(),
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
        .send_request(NewSessionRequest::new(project_root.clone()))
        .block_task()
        .await
        .expect("session/new with real opencode agent");

    // 桌面端模型选择锚点：session/new 必须暴露 select 型 configOptions，
    // 且 set_config_option 切换后在响应中回读新值（协议契约硬断言）。
    let initial_options = new_session.config_options.clone().unwrap_or_default();
    assert!(
        initial_options
            .iter()
            .any(|option| matches!(option.kind, SessionConfigKind::Select(_))),
        "real opencode agent should expose select session config options"
    );
    if let Some(model) = initial_options
        .iter()
        .find(|option| option.id == SessionConfigId::from("model"))
    {
        if let SessionConfigKind::Select(select) = &model.kind {
            let current = select.current_value.to_string();
            let candidate_values: Vec<String> = match &select.options {
                SessionConfigSelectOptions::Ungrouped(options) => options
                    .iter()
                    .map(|choice| choice.value.to_string())
                    .collect(),
                SessionConfigSelectOptions::Grouped(groups) => groups
                    .iter()
                    .flat_map(|group| group.options.iter().map(|choice| choice.value.to_string()))
                    .collect(),
                _ => Vec::new(),
            };
            if let Some(alternative) = candidate_values
                .into_iter()
                .find(|value| *value != current && value.starts_with("opencode/"))
            {
                let updated = conn
                    .clone()
                    .send_request(SetSessionConfigOptionRequest::new(
                        new_session.session_id.clone(),
                        "model",
                        SessionConfigOptionValue::value_id(alternative.clone()),
                    ))
                    .block_task()
                    .await
                    .expect("session/set_config_option with real opencode agent");
                let switched = updated
                    .config_options
                    .iter()
                    .find(|option| option.id == SessionConfigId::from("model"))
                    .and_then(|option| match &option.kind {
                        SessionConfigKind::Select(select) => Some(select.current_value.to_string()),
                        _ => None,
                    })
                    .expect("model option in set_config_option response");
                assert_eq!(switched, alternative, "model switch should be reflected");
                println!("model switched: {current} -> {switched}");
                // 切回原模型再做 prompt 回合，避免落在账号不可用的模型上。
                let _ = conn
                    .clone()
                    .send_request(SetSessionConfigOptionRequest::new(
                        new_session.session_id.clone(),
                        "model",
                        SessionConfigOptionValue::value_id(current),
                    ))
                    .block_task()
                    .await;
            }
        }
    }

    let prompt_result = tokio::time::timeout(
        std::time::Duration::from_secs(180),
        conn.clone()
            .send_request(PromptRequest::new(
                new_session.session_id.clone(),
                vec![ContentBlock::Text(TextContent::new(
                    "Reply with exactly one word: pong",
                ))],
            ))
            .block_task(),
    )
    .await;

    event_loop.abort();

    // 协议契约（spawn→initialize→session/new）是本测试的硬断言；
    // prompt 依赖 opencode 侧模型服务可用性——模型层故障（限流/禁用/超时）降级为跳过语义。
    let prompt = match prompt_result {
        Ok(Ok(prompt)) => Some(prompt),
        Ok(Err(error)) => {
            let message = error.to_string();
            if message.contains("Model is disabled")
                || message.contains("APIError")
                || message.contains("rate limit")
            {
                println!(
                    "model service unavailable ({}); prompt assertion skipped",
                    message
                );
                None
            } else {
                panic!("session/prompt protocol failure: {error}");
            }
        }
        Err(_) => panic!("prompt timeout (180s)"),
    };

    let mut reply = String::new();
    while let Ok(chunk) = chunks_rx.try_recv() {
        reply.push_str(&chunk);
    }
    if let Some(prompt) = prompt.as_ref() {
        println!("opencode reply: {reply:?}");
        println!("stop reason: {:?}", prompt.stop_reason);
    }

    assert!(
        !new_session.session_id.to_string().is_empty(),
        "real session id expected"
    );
    if prompt.is_some() {
        assert!(!reply.trim().is_empty(), "expected non-empty agent reply");
    }
}
