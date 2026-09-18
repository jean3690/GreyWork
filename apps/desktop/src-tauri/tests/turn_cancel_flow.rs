//! Turn 取消验证：复刻 acp_host.rs 中 acp_send/acp_stop 的回合取消路径——
//! prompt 进行中发 `$/cancel_request`，agent 应回 `stopReason: cancelled`，
//! 且连接/会话保持可用（可继续下一回合）。用 mock-acp-agent.mjs 驱动
//! （该桩在 prompt 后保留 300ms 取消窗口）。
use agent_client_protocol::schema::v1::{
    ContentBlock, InitializeRequest, NewSessionRequest, PromptRequest, SessionNotification,
    TextContent,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{AcpAgent, Agent as AgentRole, Client, ConnectionTo};
use std::path::PathBuf;
use std::str::FromStr;
use tokio::sync::mpsc;

#[tokio::test]
async fn mock_agent_turn_cancel_keeps_session_alive() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let agent_script = manifest_dir.join("tests/mock-acp-agent.mjs");
    // 路径统一正斜杠并加引号：`AcpAgent::from_str` 内部走 POSIX 规则的 `shell_words`，
    // Windows 的反斜杠会被当转义符吃掉（`C:\a\x.mjs` → `C:ax.mjs`），带空格的目录也会被拆开。
    let cmd = format!(
        "node \"{}\"",
        agent_script.display().to_string().replace('\\', "/")
    );

    let agent = AcpAgent::from_str(&cmd).expect("valid command");

    let (ready_tx, mut ready_rx) = mpsc::channel::<ConnectionTo<AgentRole>>(1);
    let event_loop = tokio::spawn(async move {
        let _ = Client
            .builder()
            .on_receive_notification(
                |_notification: SessionNotification, _conn: ConnectionTo<AgentRole>| async {
                    Ok::<(), agent_client_protocol::Error>(())
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
    let session_id = new_session.session_id.clone();

    // —— 复刻 acp_send 的回合登记（acp_host.rs）：send 后拿 SentRequest，
    //    记录 request id；这里不登记（测试直连），直接并发取消 ——
    let sent = conn.clone().send_request(PromptRequest::new(
        session_id.clone(),
        vec![ContentBlock::Text(TextContent::new("long running turn"))],
    ));
    let request_id = sent.id().clone();

    // 并发取消：立即发 $/cancel_request（mock 桩 300ms 窗口内响应）。
    conn.clone()
        .send_cancel_request(request_id)
        .expect("cancel request sent");

    let cancelled = tokio::time::timeout(std::time::Duration::from_secs(5), sent.block_task())
        .await
        .expect("cancel should complete promptly")
        .expect("cancel should not error at protocol level");

    assert!(
        format!("{:?}", cancelled.stop_reason).contains("Cancelled"),
        "expected Cancelled stop reason, got {:?}",
        cancelled.stop_reason
    );

    // —— 会话仍可用：取消后立即发起新回合，应正常 end_turn ——
    let second = conn
        .clone()
        .send_request(PromptRequest::new(
            session_id.clone(),
            vec![ContentBlock::Text(TextContent::new(
                "second turn after cancel",
            ))],
        ))
        .block_task()
        .await
        .expect("second prompt after cancel");
    assert!(
        format!("{:?}", second.stop_reason).contains("EndTurn"),
        "session should survive cancel, got {:?}",
        second.stop_reason
    );

    event_loop.abort();
}
