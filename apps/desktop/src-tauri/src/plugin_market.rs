//! 插件市场的桌面命令入口；实现收在 `greywork_host::plugin_market`。
//!
//! 与 headless 服务端的差别只有一处：插件落盘目录来自宿主路径
//! （`HostPaths.app_data_dir/plugins`），所以这里收 `HostContext` 而不是 `AppHandle`。

use std::sync::Arc;

use greywork_host::host::HostContext;
use greywork_host::plugin_market::{
    MarketPluginManifest, PluginFetchRequest, PluginFetchResponse, PluginInstallReport,
    PluginPackage, PluginRegistry,
};
use tauri::State;

/// 拉取并校验插件市场 registry。
#[tauri::command]
pub async fn plugin_market_catalog(registry_url: String) -> Result<PluginRegistry, String> {
    greywork_host::plugin_market::plugin_market_catalog(registry_url).await
}

/// 安装前预览：下载 + 全量校验但不落盘。
#[tauri::command]
pub async fn plugin_market_preview(
    registry_url: String,
    plugin_id: String,
) -> Result<MarketPluginManifest, String> {
    greywork_host::plugin_market::plugin_market_preview(registry_url, plugin_id).await
}

/// 下载、校验并安装一个插件包。
#[tauri::command]
pub async fn plugin_market_install(
    host: State<'_, Arc<dyn HostContext>>,
    registry_url: String,
    plugin_id: String,
) -> Result<PluginInstallReport, String> {
    greywork_host::plugin_market::plugin_market_install(
        host.inner().as_ref(),
        registry_url,
        plugin_id,
    )
    .await
}

/// 列出已安装的插件。
#[tauri::command]
pub fn plugin_market_list_installed(
    host: State<'_, Arc<dyn HostContext>>,
) -> Result<Vec<PluginPackage>, String> {
    greywork_host::plugin_market::plugin_market_list_installed(host.inner().as_ref())
}

/// 卸载一个已安装的插件。
#[tauri::command]
pub fn plugin_market_uninstall(
    host: State<'_, Arc<dyn HostContext>>,
    plugin_id: String,
) -> Result<(), String> {
    greywork_host::plugin_market::plugin_market_uninstall(host.inner().as_ref(), plugin_id)
}

/// 前端 net.fetch 能力 broker 的宿主侧代理（按插件 manifest 的 hosts 白名单校验）。
#[tauri::command]
pub async fn plugin_net_fetch(request: PluginFetchRequest) -> Result<PluginFetchResponse, String> {
    greywork_host::plugin_market::plugin_net_fetch(request).await
}
