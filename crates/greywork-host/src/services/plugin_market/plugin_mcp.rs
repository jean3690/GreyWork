//! 前端 mcp.connect 能力的宿主侧门面：**白名单复核 + 配额 + 连接参数不出宿主**。
//!
//! 与 [`crate::services::mcp::mcp_call`] 的分工：
//! - 连接参数（url / command / env / headers）由渲染端 broker 从**用户设置**里取出后传入，
//!   插件 manifest 里只有服务器名与工具名 —— 插件既不能指定要连哪台机器，也碰不到凭据；
//! - 本模块只做「第二道门」：复核插件 id、工具是否在声明白名单内、入参体积，并把超时
//!   收紧到插件档位（默认 30s、封顶 60s），然后复用既有 mcp_call。
//!
//! 为什么宿主还要复核一次：前端授权存在 localStorage 里、可被页面脚本改写；命令是同一台
//! 机器上的另一条通道（服务端 / 命令行客户端也能发），不能假设调用方已经校验过。
//!
//! 不支持的传输：sse 只做声明、由 agent 自己连接（见 mcp.rs 的既有边界），插件这条代理
//! 通道只走 http / stdio，遇到 sse 直接报错而不是静默降级。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::validate::validate_key;
use crate::services::mcp::{mcp_call, CallArgs, McpHeader};

/// 单次 arguments 序列化后的字节上限：插件传的是工具参数，不是文件内容。
pub const MAX_PLUGIN_MCP_ARGUMENT_BYTES: usize = 16 * 1024;
/// 允许声明的工具条数上界（与 manifest 校验口径一致）。
const MAX_ALLOWED_TOOLS: usize = 16;
/// 工具名长度上界。
const MAX_TOOL_CHARS: usize = 128;
/// 服务器名长度上界。
const MAX_SERVER_NAME_CHARS: usize = 64;
/// 插件档位的超时缺省 / 上限：比设置页手动「测试连接」更紧，避免 worker 长期挂住。
const DEFAULT_TIMEOUT_SECS: u64 = 30;
const MAX_TIMEOUT_SECS: u64 = 60;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginMcpCallRequest {
    /// 发起调用的插件 id（前端 broker 传入，宿主仍按 validate_key 复核）。
    pub plugin_id: String,
    /// 服务器名（仅用于错误信息与审计；连接参数在下面的字段里）。
    pub server: String,
    pub transport: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Option<Vec<String>>,
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
    #[serde(default)]
    pub headers: Option<Vec<McpHeader>>,
    pub tool: String,
    #[serde(default)]
    pub arguments: Option<Value>,
    /// manifest 里该服务器的工具白名单（安装期已校验 1-16 条）。
    pub allowed_tools: Vec<String>,
    #[serde(default)]
    pub timeout_secs: Option<u64>,
}

/// 回给插件的调用结果：**只给正文**，不回 content（图片 / base64 会把 worker 撑爆）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginMcpCallResponse {
    pub transport: String,
    pub is_error: bool,
    pub text: String,
    pub duration_ms: u64,
}

pub async fn plugin_mcp_call(
    request: PluginMcpCallRequest,
) -> Result<PluginMcpCallResponse, String> {
    validate_key(&request.plugin_id, "plugin id")?;
    let server = request.server.trim();
    if server.is_empty() {
        return Err("mcp.connect requires a server name".to_string());
    }
    if server.chars().count() > MAX_SERVER_NAME_CHARS {
        return Err(format!(
            "mcp.connect server name exceeds {MAX_SERVER_NAME_CHARS} characters"
        ));
    }
    if server.chars().any(char::is_control) {
        return Err("mcp.connect server name must not contain control characters".to_string());
    }
    if request.allowed_tools.is_empty() || request.allowed_tools.len() > MAX_ALLOWED_TOOLS {
        return Err(format!(
            "mcp.connect requires an allowlist of 1-{MAX_ALLOWED_TOOLS} tools"
        ));
    }
    let tool = request.tool.trim();
    if tool.is_empty() {
        return Err("mcp.connect requires a non-empty tool name".to_string());
    }
    if tool.chars().count() > MAX_TOOL_CHARS {
        return Err(format!(
            "mcp.connect tool name exceeds {MAX_TOOL_CHARS} characters"
        ));
    }
    if !request
        .allowed_tools
        .iter()
        .any(|allowed| allowed.trim() == tool)
    {
        return Err(format!(
            "mcp.connect tool not allowed by the manifest: {tool} (server {server})"
        ));
    }
    if let Some(value) = &request.arguments {
        if !value.is_null() && !value.is_object() {
            return Err("mcp.connect arguments must be a JSON object".to_string());
        }
        let bytes =
            serde_json::to_vec(value).map_err(|error| format!("invalid arguments: {error}"))?;
        if bytes.len() > MAX_PLUGIN_MCP_ARGUMENT_BYTES {
            return Err(format!(
                "mcp.connect arguments exceed {MAX_PLUGIN_MCP_ARGUMENT_BYTES} bytes (server {server})"
            ));
        }
    }
    match request.transport.as_str() {
        "http" | "stdio" => {}
        "sse" => {
            return Err(
                "mcp.connect cannot proxy sse servers; declare them for the agent instead"
                    .to_string(),
            )
        }
        other => return Err(format!("unknown mcp transport: {other}")),
    }

    let report = mcp_call(CallArgs {
        transport: request.transport,
        url: request.url,
        command: request.command,
        args: request.args,
        env: request.env,
        headers: request.headers,
        tool: tool.to_string(),
        arguments: request.arguments,
        timeout_secs: Some(
            request
                .timeout_secs
                .unwrap_or(DEFAULT_TIMEOUT_SECS)
                .clamp(1, MAX_TIMEOUT_SECS),
        ),
    })
    .await?;

    Ok(PluginMcpCallResponse {
        transport: report.transport,
        is_error: report.is_error,
        text: report.text,
        duration_ms: report.duration_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(tool: &str, allowed: &[&str]) -> PluginMcpCallRequest {
        PluginMcpCallRequest {
            plugin_id: "demo.mcp".to_string(),
            server: "fs".to_string(),
            transport: "http".to_string(),
            url: Some("http://127.0.0.1:9/mcp".to_string()),
            command: None,
            args: None,
            env: None,
            headers: None,
            tool: tool.to_string(),
            arguments: Some(serde_json::json!({ "path": "README.md" })),
            allowed_tools: allowed.iter().map(|name| name.to_string()).collect(),
            timeout_secs: None,
        }
    }

    /// 白名单外的工具必须在连服务器之前就被拒：错误里点名工具与服务器，便于用户改授权。
    #[tokio::test]
    async fn rejects_tool_outside_allowlist() {
        let error = plugin_mcp_call(request("write_file", &["read_file"]))
            .await
            .unwrap_err();
        assert!(error.contains("not allowed"), "{error}");
        assert!(error.contains("write_file"), "{error}");
    }

    /// manifest 没声明工具（空清单）等于不授权：不能被当成「全部允许」。
    #[tokio::test]
    async fn rejects_empty_allowlist() {
        let error = plugin_mcp_call(request("read_file", &[]))
            .await
            .unwrap_err();
        assert!(error.contains("allowlist"), "{error}");
    }

    /// 入参必须是 JSON 对象且体积有界。
    #[tokio::test]
    async fn rejects_non_object_and_oversized_arguments() {
        let mut bad = request("read_file", &["read_file"]);
        bad.arguments = Some(serde_json::json!(["not", "an", "object"]));
        let error = plugin_mcp_call(bad).await.unwrap_err();
        assert!(error.contains("JSON object"), "{error}");

        let mut huge = request("read_file", &["read_file"]);
        huge.arguments =
            Some(serde_json::json!({ "blob": "x".repeat(MAX_PLUGIN_MCP_ARGUMENT_BYTES) }));
        let error = plugin_mcp_call(huge).await.unwrap_err();
        assert!(error.contains("exceed"), "{error}");
    }

    /// sse 只做声明、由 agent 连接：插件代理通道明确拒绝，不静默降级。
    #[tokio::test]
    async fn rejects_sse_transport() {
        let mut sse = request("read_file", &["read_file"]);
        sse.transport = "sse".to_string();
        let error = plugin_mcp_call(sse).await.unwrap_err();
        assert!(error.contains("sse"), "{error}");
    }

    /// 插件 id / 服务器名走同一套标识校验，避免被当成路径或日志注入。
    #[tokio::test]
    async fn rejects_unsafe_plugin_id_and_server_name() {
        let mut bad_id = request("read_file", &["read_file"]);
        bad_id.plugin_id = "../evil".to_string();
        assert!(plugin_mcp_call(bad_id).await.is_err());

        let mut bad_server = request("read_file", &["read_file"]);
        bad_server.server = "bad\nname".to_string();
        assert!(plugin_mcp_call(bad_server).await.is_err());
    }
}
