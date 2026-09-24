//! MCP 探活的桌面命令入口；实现收在 `greywork_host::mcp`（与 headless 服务端共用）。

use std::collections::HashMap;

use greywork_host::mcp::{McpHeader, McpProbeReport};

/// 探活一台 MCP 服务器：`initialize` + `tools/list`，返回服务器信息与工具清单。
#[tauri::command]
pub async fn mcp_probe(
    transport: String,
    url: Option<String>,
    command: Option<String>,
    args: Option<Vec<String>>,
    env: Option<HashMap<String, String>>,
    headers: Option<Vec<McpHeader>>,
    timeout_secs: Option<u64>,
) -> Result<McpProbeReport, String> {
    greywork_host::mcp::mcp_probe(transport, url, command, args, env, headers, timeout_secs).await
}
