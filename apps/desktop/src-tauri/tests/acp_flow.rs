//! Phase 1 集成验证：不经 Tauri 壳，直接以 crate API 复现 acp_host 的
//! start→initialize→new_session→prompt→stop 全链路（与命令层同一 API 面）。

use agent_client_protocol::schema::v1::{
    ContentBlock, InitializeRequest, NewSessionRequest, PromptRequest, SessionConfigId,
    SessionConfigKind, SessionConfigOptionValue, SessionNotification,
    SetSessionConfigOptionRequest, TextContent,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{AcpAgent, Agent as AgentRole, Client, ConnectionTo};
use std::path::PathBuf;
use std::str::FromStr;
use tokio::sync::mpsc;

#[tokio::test]
async fn mock_agent_full_flow() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let agent_script = manifest_dir.join("tests/mock-acp-agent.mjs");
    let cmd = format!("node {}", agent_script.display());

    let agent = AcpAgent::from_str(&cmd)
        .expect("valid command")
        .with_debug(|line, direction| eprintln!("[acp {direction:?}] {line}"));

    let (updates_tx, mut updates_rx) = mpsc::unbounded_channel::<SessionNotification>();
    let (ready_tx, mut ready_rx) = mpsc::channel::<ConnectionTo<AgentRole>>(1);
    let (done_tx, _done_rx) = mpsc::channel::<String>(1);

    let event_loop = tokio::spawn(async move {
        let result = Client
            .builder()
            .on_receive_notification(
                move |notification: SessionNotification, _conn: ConnectionTo<AgentRole>| {
                    let tx = updates_tx.clone();
                    async move {
                        let _ = tx.send(notification);
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
        let message = match result {
            Ok(()) => "event-loop ended cleanly".to_string(),
            Err(error) => format!("event-loop error: {error}"),
        };
        let _ = done_tx.send(message).await;
    });

    let conn = tokio::time::timeout(std::time::Duration::from_secs(15), ready_rx.recv())
        .await
        .expect("handshake timeout")
        .expect("connection ready");

    conn.clone()
        .send_request(InitializeRequest::new(ProtocolVersion::V1))
        .block_task()
        .await
        .expect("initialize");

    let new_session = conn
        .clone()
        .send_request(NewSessionRequest::new(manifest_dir.clone()))
        .block_task()
        .await
        .expect("session/new");

    assert!(
        new_session
            .config_options
            .as_ref()
            .is_some_and(|options| !options.is_empty()),
        "mock agent should advertise session config options"
    );

    let set_config = conn
        .clone()
        .send_request(SetSessionConfigOptionRequest::new(
            new_session.session_id.clone(),
            "model",
            SessionConfigOptionValue::value_id("mock/slow"),
        ))
        .block_task()
        .await
        .expect("session/set_config_option");

    let model = set_config
        .config_options
        .iter()
        .find(|option| option.id == SessionConfigId::from("model"))
        .expect("model option present in set response");
    match &model.kind {
        SessionConfigKind::Select(select) => assert_eq!(
            select.current_value,
            agent_client_protocol::schema::v1::SessionConfigValueId::from("mock/slow"),
            "set_config_option should update the model current value"
        ),
        _ => panic!("model option should be a select"),
    }

    let prompt = conn
        .clone()
        .send_request(PromptRequest::new(
            new_session.session_id.clone(),
            vec![ContentBlock::Text(TextContent::new("hello mock"))],
        ))
        .block_task()
        .await
        .expect("session/prompt");

    event_loop.abort();

    let mut chunks = 0usize;
    while let Ok(notification) = updates_rx.try_recv() {
        let _ = notification;
        chunks += 1;
    }

    let stop = format!("{:?}", prompt.stop_reason);
    assert!(stop.contains("EndTurn"), "expected EndTurn, got {stop}");
    assert!(!new_session.session_id.to_string().is_empty());
    eprintln!("chunks received: {chunks}");
}
