//! MCP 官方注册表搜索的桌面命令入口；实现收在 `greywork_host::mcp_registry`。

use greywork_host::mcp_registry::McpRegistryEntry;

/// 搜索官方注册表；`search` 为空时返回前 `limit` 条。
#[tauri::command]
pub async fn mcp_search(
    search: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<McpRegistryEntry>, String> {
    greywork_host::mcp_registry::mcp_search(search, limit).await
}
