//! MCP 接入：把用户声明的 MCP 服务器交给 agent（`session/new` 的 `mcpServers`），
//! 外加一个探活命令供设置页「测试连接」用。
//!
//! 边界（与上一版实现的关键差别）：**连接由 agent 建立，不由宿主代理**。
//! 宿主只做两件事：把配置翻译成 ACP 的 `McpServer` 声明；在用户想验证配置时
//! 自己走一遍 `initialize` + `tools/list`。工具调用、结果回传、权限确认全部
//! 沿用 agent 既有通道，宿主不插手。
//!
//! 协议：探活的 stdio 帧是换行分隔的 JSON-RPC 2.0（非 LSP Content-Length）；
//! remote 是 Streamable HTTP（POST，响应可能是整段 JSON 或 SSE `data:` 行）。
//!
//! SSRF 决策：单用户桌面端，URL 由用户在设置页自己填，攻击者权限不高于本机
//! 用户，故不做内网过滤——localhost / 内网地址都是合法用法。

use std::collections::HashMap;
use std::time::{Duration, Instant};

use agent_client_protocol::schema::v1::{
    EnvVariable, HttpHeader, McpCapabilities, McpServer, McpServerHttp, McpServerSse,
    McpServerStdio,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// MCP stdio 探活允许的运行时入口（basename）。与 ACP agent 白名单同一安全模型：
/// 收敛可启动的程序面。注意这只约束**宿主探活**；agent 自己启动 stdio 服务器
/// 时用的是它自己的策略。
pub const ALLOWED_MCP_RUNTIMES: &[&str] = &["npx", "bunx", "uvx", "node"];

const PROTOCOL_VERSION: &str = "2025-06-18";
const DEFAULT_PROBE_TIMEOUT_SECS: u64 = 45;
const CLIENT_NAME: &str = "greywork";

/// HTTP 头（remote 传输的鉴权等）。
#[derive(Debug, Clone, Deserialize)]
pub struct McpHeader {
    pub name: String,
    pub value: String,
}

/// 前端声明的一台 MCP 服务器。`transport` 取 `http` / `sse` / `stdio`。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub name: String,
    pub transport: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub headers: Vec<McpHeader>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

/// 被跳过的服务器及原因；随 `session/new` 结果回给前端，避免静默丢配置。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct McpSkipped {
    pub name: String,
    pub reason: String,
}

/// 按 agent 能力把配置翻译成 ACP 声明。
///
/// 能力不匹配的直接跳过而不是硬塞：按协议，agent 只在 `mcpCapabilities` 里
/// 声明过的传输上接受服务器，塞进去会让整个 `session/new` 失败——一台配错的
/// 服务器不该拖垮整个会话。stdio 是所有 agent 都必须支持的，不受能力位约束。
pub fn plan_servers(
    configs: &[McpServerConfig],
    caps: &McpCapabilities,
) -> (Vec<McpServer>, Vec<McpSkipped>) {
    let mut servers = Vec::new();
    let mut skipped = Vec::new();

    for config in configs {
        let name = config.name.clone();
        match config.transport.as_str() {
            "http" => {
                if !caps.http {
                    skipped.push(McpSkipped {
                        name,
                        reason: "http_unsupported".into(),
                    });
                    continue;
                }
                let Some(url) = config.url.as_deref().filter(|url| !url.trim().is_empty()) else {
                    skipped.push(McpSkipped {
                        name,
                        reason: "missing_url".into(),
                    });
                    continue;
                };
                servers.push(McpServer::Http(
                    McpServerHttp::new(name, url).headers(http_headers(&config.headers)),
                ));
            }
            "sse" => {
                if !caps.sse {
                    skipped.push(McpSkipped {
                        name,
                        reason: "sse_unsupported".into(),
                    });
                    continue;
                }
                let Some(url) = config.url.as_deref().filter(|url| !url.trim().is_empty()) else {
                    skipped.push(McpSkipped {
                        name,
                        reason: "missing_url".into(),
                    });
                    continue;
                };
                servers.push(McpServer::Sse(
                    McpServerSse::new(name, url).headers(http_headers(&config.headers)),
                ));
            }
            "stdio" => {
                let Some(command) = config
                    .command
                    .as_deref()
                    .filter(|cmd| !cmd.trim().is_empty())
                else {
                    skipped.push(McpSkipped {
                        name,
                        reason: "missing_command".into(),
                    });
                    continue;
                };
                let env = config
                    .env
                    .iter()
                    .map(|(key, value)| EnvVariable::new(key.clone(), value.clone()))
                    .collect();
                servers.push(McpServer::Stdio(
                    McpServerStdio::new(name, command)
                        .args(config.args.clone())
                        .env(env),
                ));
            }
            other => skipped.push(McpSkipped {
                name,
                reason: format!("unknown_transport:{other}"),
            }),
        }
    }

    (servers, skipped)
}

/// 取出一台已声明服务器的名字，用于回报「实际声明了哪些」。
/// `McpServer` 是 non_exhaustive：新变体走兜底空名，不阻断会话建立。
pub fn server_name(server: &McpServer) -> String {
    match server {
        McpServer::Http(http) => http.name.clone(),
        McpServer::Sse(sse) => sse.name.clone(),
        McpServer::Stdio(stdio) => stdio.name.clone(),
        _ => String::new(),
    }
}

fn http_headers(headers: &[McpHeader]) -> Vec<HttpHeader> {
    headers
        .iter()
        .map(|header| HttpHeader::new(header.name.clone(), header.value.clone()))
        .collect()
}

// ---------- 探活 ----------

#[derive(Debug, Serialize)]
pub struct McpToolInfo {
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
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

/// notification 帧（无 id 字段）。
fn rpc_notification(method: &str) -> String {
    json!({ "jsonrpc": "2.0", "method": method }).to_string() + "\n"
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

/// 从响应块提取所有 `data:` 行的 JSON（Streamable HTTP 可能以 SSE 回包）。
fn parse_sse_data(chunk: &str) -> Vec<Value> {
    chunk
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(str::trim)
        .filter(|data| !data.is_empty())
        .filter_map(|data| serde_json::from_str::<Value>(data).ok())
        .collect()
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

fn init_params() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {},
        "clientInfo": { "name": CLIENT_NAME, "version": env!("CARGO_PKG_VERSION") },
    })
}

/// 探活一台 MCP 服务器：`initialize` + `tools/list`，返回服务器信息与工具清单。
///
/// `transport` 为 `http` 走 Streamable HTTP；`stdio` 就地 spawn 一次并回收。
/// `sse` 不支持探活（需要 GET 长连接 + endpoint 事件的另一套流程）——声明给
/// agent 仍然可用，只是这里不代验。
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
    match transport.as_str() {
        "http" => {
            let url = url.ok_or_else(|| "http transport requires url".to_string())?;
            probe_http(url, headers.unwrap_or_default(), timeout_secs).await
        }
        "stdio" => {
            let command = command.ok_or_else(|| "stdio transport requires command".to_string())?;
            probe_stdio(command, args.unwrap_or_default(), env, timeout_secs).await
        }
        "sse" => Err("sse transport cannot be probed; declare it and let the agent connect".into()),
        other => Err(format!("unknown mcp transport: {other}")),
    }
}

/// 把用户声明的请求头转成 reqwest HeaderMap；非法头名/值直接报错（fail-closed），
/// 避免静默丢掉鉴权头导致探活结果与真实会话不一致。
fn build_header_map(headers: &[McpHeader]) -> Result<reqwest::header::HeaderMap, String> {
    let mut map = reqwest::header::HeaderMap::new();
    for header in headers {
        let name = header.name.trim();
        let value = header.value.trim();
        if name.is_empty() || value.is_empty() {
            continue;
        }
        let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|error| format!("invalid header name {name:?}: {error}"))?;
        let value = reqwest::header::HeaderValue::from_str(value)
            .map_err(|error| format!("invalid header value for {name}: {error}"))?;
        map.insert(name, value);
    }
    Ok(map)
}

/// 远程探活：POST initialize（Accept 含 text/event-stream）→ 取 `Mcp-Session-Id`
/// → POST initialized 通知 → POST tools/list。
async fn probe_http(
    url: String,
    headers: Vec<McpHeader>,
    timeout_secs: Option<u64>,
) -> Result<McpProbeReport, String> {
    let lower = url.to_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err(format!("mcp url must be http(s), got: {url}"));
    }

    let started = Instant::now();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(
            timeout_secs.unwrap_or(DEFAULT_PROBE_TIMEOUT_SECS),
        ))
        .build()
        .map_err(|error| format!("failed to build http client: {error}"))?;
    let auth = build_header_map(&headers)?;

    let init = client
        .post(&url)
        .header("Accept", "application/json, text/event-stream")
        .headers(auth.clone())
        .json(
            &json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": init_params() }),
        )
        .send()
        .await
        .map_err(|error| format!("initialize request failed: {error}"))?;
    if !init.status().is_success() {
        return Err(format!("initialize returned HTTP {}", init.status()));
    }

    // 存在则后续请求都带上（Streamable HTTP 的会话粘性；deepwiki 这类无状态服务不发）。
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

    let with_session = |builder: reqwest::RequestBuilder| match &session_id {
        Some(session) => builder.header("Mcp-Session-Id", session),
        None => builder,
    };

    let _ = with_session(
        client
            .post(&url)
            .header("Accept", "application/json, text/event-stream")
            .headers(auth.clone()),
    )
    .body(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }).to_string())
    .send()
    .await;

    let list = with_session(
        client
            .post(&url)
            .header("Accept", "application/json, text/event-stream")
            .headers(auth),
    )
    .json(&json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }))
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
        transport: "http".to_string(),
        server_name,
        server_version,
        tools: extract_tools(&list_result),
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

/// stdio 探活：spawn → initialize → notifications/initialized → tools/list。
/// 子进程在守卫 drop 时 kill；整体受 timeout 约束。
async fn probe_stdio(
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

    // Windows 上 npx/bunx 是 .cmd 垫片，CreateProcess 起不来：改由 cmd.exe 承载
    // （解析到的绝对路径由 batch_program 给出，其余平台恒为 None）。
    let mut spawn = match crate::process_guard::batch_program(command) {
        Some(path) => {
            let mut cmd = tokio::process::Command::new("cmd");
            cmd.arg("/C").arg(path);
            cmd
        }
        None => tokio::process::Command::new(command),
    };
    // 自成进程组组长：kill_process_tree 靠进程组整组回收，不设的话它找不到同名组
    // （ESRCH）而静默失效 —— npx → node 的孙子进程会残留。见 process_guard 的契约。
    crate::process_guard::isolate_process_group(&mut spawn);
    let child = spawn
        .args(args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .envs(env.unwrap_or_default())
        .spawn()
        .map_err(|error| format!("failed to spawn mcp server: {error}"))?;

    // 守卫：无论哪条路径返回都回收整棵进程树（Windows `taskkill /T`、Unix `killpg`；
    // 后者依赖上面设的独立进程组）。`start_kill` 是兜底，防止进程组已不存在时漏掉直接子进程。
    struct KillGuard(tokio::process::Child);
    impl Drop for KillGuard {
        fn drop(&mut self) {
            if let Some(pid) = self.0.id() {
                crate::process_guard::kill_process_tree(pid);
            }
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

    stdin
        .write_all(rpc_request(1, "initialize", init_params()).as_bytes())
        .await
        .map_err(|error| format!("failed to write to mcp server: {error}"))?;
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
    stdin
        .write_all(rpc_notification("notifications/initialized").as_bytes())
        .await
        .map_err(|error| format!("failed to write to mcp server: {error}"))?;
    stdin
        .write_all(rpc_request(2, "tools/list", json!({})).as_bytes())
        .await
        .map_err(|error| format!("failed to write to mcp server: {error}"))?;
    let list_result = wait_for_response(&mut reader, &mut buf, 2).await?;
    let tools = extract_tools(&list_result);

    let _ = guard.0.kill().await;
    Ok((server_name, server_version, tools))
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
        let text = String::from_utf8_lossy(&chunk[..read]).into_owned();
        for line in push_line(buf, &text) {
            if let Some(response) = response_for(std::slice::from_ref(&line), id) {
                return Ok(response["result"].clone());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps(http: bool, sse: bool) -> McpCapabilities {
        let mut caps = McpCapabilities::default();
        caps.http = http;
        caps.sse = sse;
        caps
    }

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

    #[test]
    fn http_server_serializes_with_tagged_type_and_headers() {
        let mut deepwiki = config("deepwiki", "http");
        deepwiki.url = Some("https://mcp.deepwiki.com/mcp".to_string());
        deepwiki.headers = vec![McpHeader {
            name: "Authorization".to_string(),
            value: "Bearer t".to_string(),
        }];

        let (servers, skipped) = plan_servers(&[deepwiki], &caps(true, false));
        assert!(skipped.is_empty());
        let wire = serde_json::to_value(&servers[0]).unwrap();
        assert_eq!(wire["type"], "http");
        assert_eq!(wire["name"], "deepwiki");
        assert_eq!(wire["url"], "https://mcp.deepwiki.com/mcp");
        assert_eq!(wire["headers"][0]["name"], "Authorization");
        assert_eq!(wire["headers"][0]["value"], "Bearer t");
    }

    #[test]
    fn stdio_server_needs_no_capability_and_carries_args_env() {
        let mut local = config("local", "stdio");
        local.command = Some("/usr/bin/mcp".to_string());
        local.args = vec!["--flag".to_string()];
        local.env = HashMap::from([("TOKEN".to_string(), "x".to_string())]);

        let (servers, skipped) = plan_servers(&[local], &caps(false, false));
        assert!(skipped.is_empty());
        let wire = serde_json::to_value(&servers[0]).unwrap();
        // stdio 是 untagged 变体：没有 type 字段
        assert!(wire.get("type").is_none());
        assert_eq!(wire["command"], "/usr/bin/mcp");
        assert_eq!(wire["args"][0], "--flag");
        assert_eq!(wire["env"][0]["name"], "TOKEN");
    }

    #[test]
    fn capability_gate_skips_instead_of_failing_the_session() {
        let mut http = config("remote-http", "http");
        http.url = Some("https://example.com/mcp".to_string());
        let mut sse = config("remote-sse", "sse");
        sse.url = Some("https://example.com/sse".to_string());

        let (servers, skipped) = plan_servers(&[http.clone(), sse.clone()], &caps(false, false));
        assert!(servers.is_empty());
        assert_eq!(
            skipped,
            vec![
                McpSkipped {
                    name: "remote-http".into(),
                    reason: "http_unsupported".into()
                },
                McpSkipped {
                    name: "remote-sse".into(),
                    reason: "sse_unsupported".into()
                },
            ]
        );

        let (servers, skipped) = plan_servers(&[http, sse], &caps(true, true));
        assert_eq!(servers.len(), 2);
        assert!(skipped.is_empty());
    }

    #[test]
    fn incomplete_or_unknown_configs_are_reported_not_silently_dropped() {
        let (servers, skipped) = plan_servers(
            &[
                config("no-url", "http"),
                config("no-command", "stdio"),
                config("weird", "carrier-pigeon"),
            ],
            &caps(true, true),
        );
        assert!(servers.is_empty());
        assert_eq!(
            skipped,
            vec![
                McpSkipped {
                    name: "no-url".into(),
                    reason: "missing_url".into()
                },
                McpSkipped {
                    name: "no-command".into(),
                    reason: "missing_command".into()
                },
                McpSkipped {
                    name: "weird".into(),
                    reason: "unknown_transport:carrier-pigeon".into()
                },
            ]
        );
    }

    #[test]
    fn parse_body_result_accepts_plain_json_and_sse() {
        let plain = r#"{"jsonrpc":"2.0","id":1,"result":{"ok":true}}"#;
        assert_eq!(parse_body_result(plain, 1).unwrap()["ok"], true);

        let sse =
            "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[]}}\n";
        assert!(parse_body_result(sse, 2).unwrap()["tools"].is_array());

        let error = r#"{"jsonrpc":"2.0","id":1,"error":{"code":-1,"message":"nope"}}"#;
        assert!(parse_body_result(error, 1).is_err());
        assert!(parse_body_result("garbage", 1).is_err());
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
    fn push_line_handles_partial_and_multi_lines() {
        let mut buf = String::new();
        let parsed = push_line(&mut buf, "{\"a\":1}\n{\"b\":");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0]["a"], 1);
        let parsed = push_line(&mut buf, "2}\nresidue");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0]["b"], 2);
        assert_eq!(buf, "residue");
    }

    #[test]
    fn header_map_carries_auth_and_rejects_invalid_names() {
        use reqwest::header::HeaderValue;

        let map = build_header_map(&[
            McpHeader {
                name: "Authorization".into(),
                value: "Bearer tok".into(),
            },
            McpHeader {
                name: "X-Env".into(),
                value: "prod".into(),
            },
            // 空 name/value 对跳过而非报错（表单遗留空行）
            McpHeader {
                name: "  ".into(),
                value: "x".into(),
            },
            McpHeader {
                name: "X-Empty".into(),
                value: "".into(),
            },
        ])
        .expect("valid headers build");
        assert_eq!(map.len(), 2);
        assert_eq!(
            map.get("authorization"),
            Some(&HeaderValue::from_static("Bearer tok"))
        );
        assert_eq!(map.get("x-env"), Some(&HeaderValue::from_static("prod")));

        // fail-closed：非法头名整体报错，不静默丢弃
        assert!(build_header_map(&[McpHeader {
            name: "bad header name".into(),
            value: "x".into(),
        }])
        .is_err());
        assert!(build_header_map(&[McpHeader {
            name: "X-Value".into(),
            value: "bad\nvalue".into(),
        }])
        .is_err());
    }

    /// 真实网络：对 DeepWiki 官方 MCP 端点跑一遍探活。
    /// 默认跳过（CI 无外网）；手动验证用
    /// `cargo test --lib mcp::tests::live_deepwiki_probe -- --ignored --nocapture`。
    #[tokio::test]
    #[ignore = "requires network access to mcp.deepwiki.com"]
    async fn live_deepwiki_probe() {
        let report = probe_http(
            "https://mcp.deepwiki.com/mcp".to_string(),
            Vec::new(),
            Some(30),
        )
        .await
        .expect("deepwiki probe");
        eprintln!(
            "deepwiki: {:?} v{:?} in {}ms",
            report.server_name, report.server_version, report.duration_ms
        );
        for tool in &report.tools {
            eprintln!("  - {} :: {:?}", tool.name, tool.description);
        }
        assert_eq!(report.server_name.as_deref(), Some("DeepWiki"));
        let names: Vec<&str> = report.tools.iter().map(|tool| tool.name.as_str()).collect();
        assert!(names.contains(&"ask_question"), "tools: {names:?}");
        assert!(names.contains(&"read_wiki_structure"), "tools: {names:?}");
    }
}
