//! 对外命令：catalog / preview / install / list / uninstall。

use crate::host::HostContext;

use super::dto::{MarketPluginManifest, PluginInstallReport, PluginPackage, PluginRegistry};
use super::http::fetch_json;
use super::install::{
    fetch_and_validate_package, install_package_at, list_installed_at, plugins_root,
};
use super::registry::validate_registry;
use super::validate::validate_dir_key;
use super::MAX_REGISTRY_BYTES;

pub async fn plugin_market_catalog(registry_url: String) -> Result<PluginRegistry, String> {
    let bytes = fetch_json(&registry_url, MAX_REGISTRY_BYTES).await?;
    let registry: PluginRegistry = serde_json::from_slice(&bytes)
        .map_err(|error| format!("invalid plugin registry JSON: {error}"))?;
    validate_registry(&registry, &registry_url)?;
    Ok(registry)
}

pub async fn plugin_market_preview(
    registry_url: String,
    plugin_id: String,
) -> Result<MarketPluginManifest, String> {
    // 安装前预览：下载 + 全量校验（SHA-256 / schema / hosts 白名单）但不落盘。
    // 返回 manifest 让用户在授权时刻看到精确的能力语义。
    let package = fetch_and_validate_package(&registry_url, &plugin_id).await?;
    Ok(package.manifest)
}

pub async fn plugin_market_install(
    host: &dyn HostContext,
    registry_url: String,
    plugin_id: String,
) -> Result<PluginInstallReport, String> {
    let package = fetch_and_validate_package(&registry_url, &plugin_id).await?;
    let path = install_package_at(&plugins_root(host), &package)?;
    Ok(PluginInstallReport {
        id: package.manifest.id,
        version: package.manifest.version,
        path: path.to_string_lossy().into_owned(),
    })
}

pub fn plugin_market_list_installed(host: &dyn HostContext) -> Result<Vec<PluginPackage>, String> {
    list_installed_at(&plugins_root(host))
}

pub fn plugin_market_uninstall(host: &dyn HostContext, plugin_id: String) -> Result<(), String> {
    validate_dir_key(&plugin_id, "plugin id")?;
    let target = plugins_root(host).join(&plugin_id);
    if !target.exists() {
        return Err(format!("plugin not installed: {plugin_id}"));
    }
    std::fs::remove_dir_all(&target).map_err(|error| format!("remove plugin failed: {error}"))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogArgs {
    pub registry_url: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewArgs {
    pub registry_url: String,
    pub plugin_id: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallArgs {
    pub registry_url: String,
    pub plugin_id: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallArgs {
    pub plugin_id: String,
}
