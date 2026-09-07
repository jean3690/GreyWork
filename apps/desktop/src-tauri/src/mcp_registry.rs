//! MCP 官方注册表（registry.modelcontextprotocol.io）只读代理。
//!
//! 仅浏览与归一化：条目在渲染端归一为 McpServerConfig 草稿后由用户
//! 确认登记，本模块不启动任何本地进程。stdio 型 server 的实际启动属未来
//! 运行时能力，届时必须经宿主白名单校验，不得信任此处透出的命令串。

use serde::Serialize;

use crate::http::{read_json, shared_client, RESPONSE_READ_TIMEOUT};

const REGISTRY_ORIGIN: &str = "https://registry.modelcontextprotocol.io";

#[derive(Debug, Clone, Serialize)]
pub struct McpRemoteEndpoint {
    pub transport: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpPackageInfo {
    pub registry_type: String,
    pub identifier: String,
    pub version: Option<String>,
    /// 声明的环境变量名清单（只透出名字，值由用户安装时自行提供）
    pub env_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpRegistryEntry {
    /// 注册表唯一名："ac.inference.sh/mcp"
    pub name: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub version: Option<String>,
    pub repository_url: Option<String>,
    /// 官方元数据状态（active/deleted）
    pub status: Option<String>,
    pub remotes: Vec<McpRemoteEndpoint>,
    pub packages: Vec<McpPackageInfo>,
}

fn str_field(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)?
        .as_str()
        .filter(|raw| !raw.is_empty())
        .map(str::to_string)
}

fn normalize_remote(value: &serde_json::Value) -> Option<McpRemoteEndpoint> {
    let transport = str_field(value, "type")?;
    let url = str_field(value, "url")?;
    Some(McpRemoteEndpoint { transport, url })
}

fn normalize_package(value: &serde_json::Value) -> Option<McpPackageInfo> {
    let registry_type = str_field(value, "registryType")?;
    let identifier = str_field(value, "identifier")?;
    let env_names = value
        .get("environmentVariables")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| str_field(item, "name"))
                .collect()
        })
        .unwrap_or_default();
    Some(McpPackageInfo {
        registry_type,
        identifier,
        version: str_field(value, "version"),
        env_names,
    })
}

/// 归一化 /v0/servers 响应。跳过缺 name 或非 active 的条目。
pub fn normalize_registry(body: &serde_json::Value) -> Vec<McpRegistryEntry> {
    body.get("servers")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let server = item.get("server")?;
                    let name = str_field(server, "name")?;
                    let meta_status = item
                        .get("_meta")
                        .and_then(|meta| meta.get("io.modelcontextprotocol.registry/official"))
                        .and_then(|official| official.get("status"))
                        .and_then(serde_json::Value::as_str);
                    // deleted 条目不进浏览列表
                    if meta_status.is_some_and(|status| status == "deleted") {
                        return None;
                    }
                    Some(McpRegistryEntry {
                        name,
                        title: str_field(server, "title"),
                        description: str_field(server, "description"),
                        version: str_field(server, "version"),
                        repository_url: server
                            .get("repository")
                            .and_then(|repo| repo.get("url"))
                            .and_then(serde_json::Value::as_str)
                            .filter(|raw| !raw.is_empty())
                            .map(str::to_string),
                        status: meta_status.map(str::to_string),
                        remotes: server
                            .get("remotes")
                            .and_then(serde_json::Value::as_array)
                            .map(|items| items.iter().filter_map(normalize_remote).collect())
                            .unwrap_or_default(),
                        packages: server
                            .get("packages")
                            .and_then(serde_json::Value::as_array)
                            .map(|items| items.iter().filter_map(normalize_package).collect())
                            .unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 搜索官方注册表；search 为空时返回前 N 条。
#[tauri::command]
pub async fn mcp_search(
    search: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<McpRegistryEntry>, String> {
    let limit = limit.unwrap_or(20).clamp(1, 100);
    let mut params: Vec<(String, String)> = vec![("limit".to_string(), limit.to_string())];
    if let Some(term) = search
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        params.push(("search".to_string(), term.to_string()));
    }
    let response = shared_client(10)?
        .get(format!("{REGISTRY_ORIGIN}/v0/servers"))
        .query(&params)
        .send()
        .await
        .map_err(|error| format!("registry request failed: {error}"))?;
    let body: serde_json::Value = read_json(response, RESPONSE_READ_TIMEOUT)
        .await
        .map_err(|error| format!("invalid registry response: {error}"))?;
    Ok(normalize_registry(&body))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn registry_normalizer_extracts_remotes_packages_and_meta_status() {
        let body = json!({
            "servers": [
                {
                    "server": {
                        "name": "ac.inference.sh/mcp",
                        "title": "inference.sh",
                        "description": "Run 150+ AI apps",
                        "version": "1.0.0",
                        "remotes": [{ "type": "streamable-http", "url": "https://api.inference.sh/mcp" }],
                    },
                    "_meta": { "io.modelcontextprotocol.registry/official": { "status": "active" } },
                },
                {
                    "server": {
                        "name": "x/npm-server",
                        "packages": [{
                            "registryType": "npm",
                            "identifier": "@scope/server",
                            "version": "2.1.0",
                            "environmentVariables": [{ "name": "API_TOKEN", "required": true }],
                        }],
                    },
                },
                {
                    "server": { "name": "gone/deleted" },
                    "_meta": { "io.modelcontextprotocol.registry/official": { "status": "deleted" } },
                },
                { "server": { "description": "无 name 丢弃" } },
            ],
        });
        let entries = normalize_registry(&body);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].remotes[0].transport, "streamable-http");
        assert_eq!(entries[0].status.as_deref(), Some("active"));
        assert_eq!(entries[1].packages[0].identifier, "@scope/server");
        assert_eq!(entries[1].packages[0].env_names, vec!["API_TOKEN"]);
        assert!(normalize_registry(&json!({})).is_empty());
    }
}
