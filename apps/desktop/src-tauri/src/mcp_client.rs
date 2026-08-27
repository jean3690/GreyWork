//! MCP 运行时连接探活：stdio spawn / 远程 endpoint 直连，完成
//! `initialize` + `tools/list` 握手，返回 server 信息与工具清单。
//!
//! 边界：仅探活。不做工具调用执行、不接聊天管线。
//!
//! 协议：MCP stdio 帧为换行分隔 JSON-RPC 2.0（非 LSP Content-Length），
//! 手写协议层、零新依赖；remote 为 Streamable HTTP（POST + SSE/JSON 响应）。
//!
//! SSRF 决策：本应用是单用户桌面端，探活 URL 来自用户在 UI 中主动搜索并
//! 点击的注册表条目，攻击者权限不高于本机用户，故不做 SSRF 过滤，
//! localhost / 内网地址均合法。

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};

/// MCP stdio 允许的运行时入口（basename）。与 ACP 白名单同一安全模型：
/// 收敛可启动的程序面，而非完全消除该面。
pub const ALLOWED_MCP_RUNTIMES: &[&str] = &["npx", "bunx", "uvx", "node"];

const PROTOCOL_VERSION: &str = "2025-06-18";
const DEFAULT_PROBE_TIMEOUT_SECS: u64 = 45;
const CLIENT_NAME: &str = "greywork";

#[derive(Debug, Serialize)]
pub struct McpToolInfo {
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct McpProbeReport {
    pub transport: String,
    pub server_name: Option<String>,
    pub server_version: Option<String>,
    pub tools: Vec<McpToolInfo>,
    pub duration_ms: u64,
}

/// 序列化一条 JSON-RPC 2.0 请求帧（含换行结尾）。
fn rpc_request(id: u64, method: &str, params: Value) -> String {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    })
    .to_string()
        + "\n"
}

/// 把一块 stdout 文本按 `\n` 切分并逐行解析为 JSON；残行保留在 buf。
fn push_line(buf: &mut String, chunk: &str) -> Vec<Value> {
    buf.push_str(chunk);
    let mut parsed = Vec::new();
    while let Some(pos) = buf.find('\n') {
        let line: String = buf.drain(..=pos).collect();
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            parsed.push(value);
        }
    }
    parsed
}

/// 在已解析的响应行里找匹配 id 且带 `result` 的那条（忽略 notification）。
fn response_for(lines: &[Value], id: u64) -> Option<&Value> {
    lines.iter().find(|line| {
        line.get("id").and_then(Value::as_u64) == Some(id) && line.get("result").is_some()
    })
}

/// 从 tools/list 的 result 提取工具清单；缺字段容忍。
fn extract_tools(result: &Value) -> Vec<McpToolInfo> {
    result
        .get("tools")
        .and_then(Value::as_array)
        .map(|tools| {
            tools
                .iter()
                .filter_map(|tool| {
                    let name = tool.get("name")?.as_str()?.to_string();
                    Some(McpToolInfo {
                        name,
                        description: tool
                            .get("description")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 从 remote 响应块提取所有 `data:` 行的 JSON（Streamable HTTP 可能以 SSE 回包）。
fn parse_sse_data(chunk: &str) -> Vec<Value> {
    chunk
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(str::trim)
        .filter(|data| !data.is_empty())
        .filter_map(|data| serde_json::from_str::<Value>(data).ok())
        .collect()
}

/// stdio 探活：spawn → initialize 握手 → notifications/initialized →
/// tools/list → 组装报告。子进程在守卫 drop 时 kill。
///
/// 整体受 timeout 约束；超时错误信息含已耗时。
#[tauri::command]
pub async fn mcp_probe_stdio(
    command: String,
    args: Vec<String>,
    env: Option<HashMap<String, String>>,
    timeout_secs: Option<u64>,
) -> Result<McpProbeReport, String> {
    let command = crate::process_guard::validate_spawn_command(&command, ALLOWED_MCP_RUNTIMES)?;
    if let Some(bad) = args.iter().find(|arg| {
        arg.chars()
            .any(|c| crate::process_guard::SHELL_META_CHARS.contains(&c))
    }) {
        return Err(format!("mcp arg contains forbidden character: {bad:?}"));
    }

    let started = Instant::now();
    let deadline = Duration::from_secs(timeout_secs.unwrap_or(DEFAULT_PROBE_TIMEOUT_SECS));

    let probe = probe_stdio_inner(&command, &args, env);
    tokio::pin!(probe);

    match tokio::time::timeout(deadline, probe).await {
        Ok(result) => result.map(|(server_name, server_version, tools)| McpProbeReport {
            transport: "stdio".to_string(),
            server_name,
            server_version,
            tools,
            duration_ms: started.elapsed().as_millis() as u64,
        }),
        Err(_) => Err(format!(
            "mcp stdio probe timed out after {}ms (limit {}s)",
            started.elapsed().as_millis(),
            deadline.as_secs()
        )),
    }
}

async fn probe_stdio_inner(
    command: &str,
    args: &[String],
    env: Option<HashMap<String, String>>,
) -> Result<(Option<String>, Option<String>, Vec<McpToolInfo>), String> {
    use tokio::io::{AsyncWriteExt, BufReader};

    let child = tokio::process::Command::new(command)
        .args(args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .envs(env.unwrap_or_default())
        .spawn()
        .map_err(|error| format!("failed to spawn mcp server: {error}"))?;

    // 守卫：无论哪条路径返回都回收子进程。
    struct KillGuard(tokio::process::Child);
    impl Drop for KillGuard {
        fn drop(&mut self) {
            let _ = self.0.start_kill();
        }
    }
    let mut guard = KillGuard(child);

    let mut stdin = guard
        .0
        .stdin
        .take()
        .ok_or_else(|| "mcp server stdin unavailable".to_string())?;
    let stdout = guard
        .0
        .stdout
        .take()
        .ok_or_else(|| "mcp server stdout unavailable".to_string())?;
    let mut reader = BufReader::new(stdout);
    let mut buf = String::new();

    let write_frame = async |stdin: &mut tokio::process::ChildStdin, frame: &str| {
        stdin
            .write_all(frame.as_bytes())
            .await
            .map_err(|error| format!("failed to write to mcp server: {error}"))
    };

    write_frame(
        &mut stdin,
        &rpc_request(
            1,
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": CLIENT_NAME, "version": env!("CARGO_PKG_VERSION") },
            }),
        ),
    )
    .await?;

    let init_result = wait_for_response(&mut reader, &mut buf, 1).await?;
    let server_name = init_result
        .pointer("/serverInfo/name")
        .and_then(Value::as_str)
        .map(str::to_string);
    let server_version = init_result
        .pointer("/serverInfo/version")
        .and_then(Value::as_str)
        .map(str::to_string);

    // initialized 是 notification：无 id，无需等回包。
    write_frame(&mut stdin, &rpc_request_raw("notifications/initialized")).await?;
    write_frame(&mut stdin, &rpc_request(2, "tools/list", json!({}))).await?;
    let list_result = wait_for_response(&mut reader, &mut buf, 2).await?;
    let tools = extract_tools(&list_result);

    let _ = guard.0.kill().await;
    Ok((server_name, server_version, tools))
}

/// notification 帧（无 id 字段）。
fn rpc_request_raw(method: &str) -> String {
    json!({ "jsonrpc": "2.0", "method": method }).to_string() + "\n"
}

async fn wait_for_response(
    reader: &mut tokio::io::BufReader<tokio::process::ChildStdout>,
    buf: &mut String,
    id: u64,
) -> Result<Value, String> {
    use tokio::io::AsyncReadExt;

    loop {
        let mut chunk = [0u8; 4096];
        let read = reader
            .read(&mut chunk)
            .await
            .map_err(|error| format!("failed to read from mcp server: {error}"))?;
        if read == 0 {
            return Err(format!(
                "mcp server closed stdout before responding to request id {id}"
            ));
        }
        let lost = String::from_utf8_lossy(&chunk[..read]).into_owned();
        for line in push_line(buf, &lost) {
            if let Some(response) = response_for(std::slice::from_ref(&line), id) {
                return Ok(response["result"].clone());
            }
        }
    }
}

/// 远程探活：POST initialize（Accept 含 text/event-stream）→ 取
/// `Mcp-Session-Id` → POST initialized 通知 → POST tools/list。
/// 响应体先按 JSON 解析，失败走 SSE `data:` 行提取。
#[tauri::command]
pub async fn mcp_probe_remote(
    url: String,
    timeout_secs: Option<u64>,
) -> Result<McpProbeReport, String> {
    let lower = url.to_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err(format!("mcp remote url must be http(s), got: {url}"));
    }

    let started = Instant::now();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(
            timeout_secs.unwrap_or(DEFAULT_PROBE_TIMEOUT_SECS),
        ))
        .build()
        .map_err(|error| format!("failed to build http client: {error}"))?;

    let init = client
        .post(&url)
        .header("Accept", "application/json, text/event-stream")
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": CLIENT_NAME, "version": env!("CARGO_PKG_VERSION") },
            },
        }))
        .send()
        .await
        .map_err(|error| format!("initialize request failed: {error}"))?;
    if !init.status().is_success() {
        return Err(format!("initialize returned HTTP {}", init.status()));
    }

    // 存在则后续请求都带上（Streamable HTTP 会话粘性）。
    let session_id = init
        .headers()
        .get("Mcp-Session-Id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    let body = init
        .text()
        .await
        .map_err(|error| format!("failed to read body: {error}"))?;
    let init_result = parse_body_result(&body, 1)?;
    let server_name = init_result
        .pointer("/serverInfo/name")
        .and_then(Value::as_str)
        .map(str::to_string);
    let server_version = init_result
        .pointer("/serverInfo/version")
        .and_then(Value::as_str)
        .map(str::to_string);

    let mut post = client
        .post(&url)
        .header("Accept", "application/json, text/event-stream");
    if let Some(session) = &session_id {
        post = post.header("Mcp-Session-Id", session);
    }
    let _ = post
        .body(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }).to_string())
        .send()
        .await;

    let mut post = client
        .post(&url)
        .header("Accept", "application/json, text/event-stream");
    if let Some(session) = &session_id {
        post = post.header("Mcp-Session-Id", session);
    }
    let list = post
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list",
            "params": {},
        }))
        .send()
        .await
        .map_err(|error| format!("tools/list request failed: {error}"))?;
    if !list.status().is_success() {
        return Err(format!("tools/list returned HTTP {}", list.status()));
    }
    let body = list
        .text()
        .await
        .map_err(|error| format!("failed to read body: {error}"))?;
    let list_result = parse_body_result(&body, 2)?;

    Ok(McpProbeReport {
        transport: "remote".to_string(),
        server_name,
        server_version,
        tools: extract_tools(&list_result),
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

/// 响应体先按整段 JSON 试，失败则按 SSE `data:` 行提取后找匹配 id 的 result。
fn parse_body_result(body: &str, id: u64) -> Result<Value, String> {
    if let Ok(envelope) = serde_json::from_str::<Value>(body.trim()) {
        if let Some(result) = envelope.get("result") {
            return Ok(result.clone());
        }
        if let Some(error) = envelope.get("error") {
            return Err(format!("mcp server error: {error}"));
        }
    }
    for value in parse_sse_data(body) {
        if response_for(std::slice::from_ref(&value), id).is_some() {
            return Ok(value["result"].clone());
        }
        if let Some(error) = value.get("error") {
            return Err(format!("mcp server error: {error}"));
        }
    }
    Err("no matching JSON-RPC response in remote reply".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rpc_request_has_envelope_shape() {
        let frame = rpc_request(7, "tools/list", json!({}));
        assert!(frame.ends_with('\n'));
        let value: Value = serde_json::from_str(frame.trim()).unwrap();
        assert_eq!(value["jsonrpc"], "2.0");
        assert_eq!(value["id"], 7);
        assert_eq!(value["method"], "tools/list");
        assert_eq!(value["params"], json!({}));
    }

    #[test]
    fn push_line_handles_partial_and_multi_lines() {
        let mut buf = String::new();
        let parsed = push_line(&mut buf, "{\"a\":1}\n{\"b\":");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0]["a"], 1);
        let parsed = push_line(&mut buf, "2}\nresidue");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0]["b"], 2);
        // 残行保留
        assert_eq!(buf, "residue");
        // 空行与非 JSON 行跳过
        let parsed = push_line(&mut buf, "\nnot-json\n{\"c\":3}\n");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0]["c"], 3);
    }

    #[test]
    fn response_for_matches_id_and_ignores_notifications() {
        let lines = vec![
            json!({"jsonrpc":"2.0","method":"some/notification"}),
            json!({"jsonrpc":"2.0","id":2,"result":{"x":1}}),
            json!({"jsonrpc":"2.0","id":9,"error":{"code":-1,"message":"no"}}),
        ];
        assert_eq!(response_for(&lines, 2).unwrap()["result"]["x"], 1);
        assert!(response_for(&lines, 3).is_none());
    }

    #[test]
    fn extract_tools_tolerates_missing_fields() {
        assert!(extract_tools(&json!({})).is_empty());
        assert!(extract_tools(&json!({"tools":[{}]})).is_empty());
        let tools = extract_tools(&json!({
            "tools": [
                {"name": "echo"},
                {"name": "now", "description": "current time"},
                {"description": "no name"},
            ],
        }));
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0].name, "echo");
        assert!(tools[0].description.is_none());
        assert_eq!(tools[1].description.as_deref(), Some("current time"));
    }

    #[test]
    fn parse_sse_data_extracts_all_data_lines() {
        let chunk = "event: message\ndata: {\"id\":1}\ndata:{\"id\":2}\n\ndata: not-json\n";
        let values = parse_sse_data(chunk);
        assert_eq!(values.len(), 2);
        assert_eq!(values[0]["id"], 1);
        assert_eq!(values[1]["id"], 2);
    }
}
