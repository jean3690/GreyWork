//! MCP 接入集成验证：agent 能力读取 → 配置翻译 → `session/new` 真实携带
//! `mcpServers` 抵达 agent。
//!
//! 与单测的差别：这里走真实 JSON-RPC 往返（tagged 枚举、camelCase、headers 数组
//! 的线上形状只有在这一层才会被验证），mock agent 把收到的 mcpServers 原样回灌到
//! `_meta.receivedMcpServers` 供断言。

use agent_client_protocol::schema::v1::{InitializeRequest, NewSessionRequest};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{AcpAgent, Agent as AgentRole, Client, ConnectionTo};
use greywork_lib::mcp::{plan_servers, McpHeader, McpServerConfig};
use std::collections::HashMap;
use std::path::PathBuf;
use std::str::FromStr;
use tokio::sync::mpsc;

fn config(name: &str, transport: &str) -> McpServerConfig {
    McpServerConfig {
        name: name.to_string(),
        transport: transport.to_string(),
        url: None,
        headers: Vec::new(),
        command: None,
        args: Vec::new(),
        env: HashMap::new(),
    }
}

#[tokio::test]
async fn declared_mcp_servers_reach_the_agent() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let agent_script = manifest_dir.join("tests/mock-acp-agent.mjs");
    let cmd = format!("node {}", agent_script.display());

    let agent = AcpAgent::from_str(&cmd).expect("valid command");
    let (ready_tx, mut ready_rx) = mpsc::channel::<ConnectionTo<AgentRole>>(1);

    let event_loop = tokio::spawn(async move {
        let _ = Client
            .builder()
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

    let initialize = conn
        .clone()
        .send_request(InitializeRequest::new(ProtocolVersion::V1))
        .block_task()
        .await
        .expect("initialize");
    let caps = initialize.agent_capabilities.mcp_capabilities.clone();
    assert!(caps.http, "mock agent should advertise http mcp support");
    assert!(caps.sse, "mock agent should advertise sse mcp support");

    let mut deepwiki = config("deepwiki", "http");
    deepwiki.url = Some("https://mcp.deepwiki.com/mcp".to_string());
    deepwiki.headers = vec![McpHeader {
        name: "X-Client".to_string(),
        value: "greywork".to_string(),
    }];
    let mut local = config("local-notes", "stdio");
    local.command = Some("/usr/bin/notes-mcp".to_string());
    local.args = vec!["--verbose".to_string()];
    let mut blocked = config("no-url", "http");
    blocked.url = None;

    let (servers, skipped) = plan_servers(&[deepwiki, local, blocked], &caps);
    assert_eq!(servers.len(), 2, "http + stdio declared");
    assert_eq!(skipped.len(), 1, "url 缺失的那台被跳过而不是拖垮会话");

    let response = conn
        .clone()
        .send_request(NewSessionRequest::new(manifest_dir.clone()).mcp_servers(servers))
        .block_task()
        .await
        .expect("session/new");

    event_loop.abort();

    let meta = response.meta.expect("mock agent echoes _meta");
    let received = meta
        .get("receivedMcpServers")
        .and_then(|value| value.as_array())
        .expect("receivedMcpServers array");
    assert_eq!(received.len(), 2, "agent 侧实收两台: {received:?}");

    let http = &received[0];
    assert_eq!(http["type"], "http");
    assert_eq!(http["name"], "deepwiki");
    assert_eq!(http["url"], "https://mcp.deepwiki.com/mcp");
    assert_eq!(http["headers"][0]["name"], "X-Client");
    assert_eq!(http["headers"][0]["value"], "greywork");

    let stdio = &received[1];
    // stdio 是 untagged 变体：线上没有 type 字段，靠 command 识别
    assert!(
        stdio.get("type").is_none(),
        "stdio 变体不带 type: {stdio:?}"
    );
    assert_eq!(stdio["name"], "local-notes");
    assert_eq!(stdio["command"], "/usr/bin/notes-mcp");
    assert_eq!(stdio["args"][0], "--verbose");
}
