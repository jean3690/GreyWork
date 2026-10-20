//! 安装 / 列举 / 拉取校验。

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::host::HostContext;

use super::commands::plugin_market_catalog;
use super::dto::PluginPackage;
use super::http::fetch_json;
use super::package::validate_package;
use super::validate::validate_key;
use super::{MAX_CODE_BYTES, MAX_PACKAGE_BYTES};

pub(super) fn plugins_root(host: &dyn HostContext) -> PathBuf {
    host.paths().app_data_dir.join("plugins")
}

pub(super) fn install_package_at(root: &Path, package: &PluginPackage) -> Result<PathBuf, String> {
    validate_package(package)?;
    let target = root.join(&package.manifest.id);
    std::fs::create_dir_all(&target)
        .map_err(|error| format!("create plugin directory failed: {error}"))?;
    let final_path = target.join("plugin.json");
    let temp_path = target.join("plugin.json.tmp");
    let bytes = serde_json::to_vec_pretty(package)
        .map_err(|error| format!("serialize plugin failed: {error}"))?;
    std::fs::write(&temp_path, bytes).map_err(|error| format!("write plugin failed: {error}"))?;
    // 直接 rename 覆盖：Windows 上 `std::fs::rename` 走 MoveFileEx(REPLACE_EXISTING)，
    // 本来就能替换；先 remove_file 只是多一个会失败的步骤。
    std::fs::rename(&temp_path, &final_path)
        .map_err(|error| format!("commit plugin failed: {error}"))?;
    Ok(final_path)
}

pub(super) fn list_installed_at(root: &Path) -> Result<Vec<PluginPackage>, String> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut packages = Vec::new();
    let entries = std::fs::read_dir(root)
        .map_err(|error| format!("read plugin directory failed: {error}"))?;
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let path = entry.path().join("plugin.json");
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        if bytes.len() > MAX_PACKAGE_BYTES + MAX_CODE_BYTES {
            continue;
        }
        let Ok(package) = serde_json::from_slice::<PluginPackage>(&bytes) else {
            continue;
        };
        if validate_package(&package).is_ok()
            && entry.file_name().to_string_lossy() == package.manifest.id
        {
            packages.push(package);
        }
    }
    packages.sort_by(|left, right| left.manifest.id.cmp(&right.manifest.id));
    Ok(packages)
}

/// 校验后的安装候选：manifest + 可选 worker 代码（已过 SHA-256 与 UTF-8 校验）。
pub(super) async fn fetch_and_validate_package(
    registry_url: &str,
    plugin_id: &str,
) -> Result<PluginPackage, String> {
    validate_key(plugin_id, "plugin id")?;
    let registry = plugin_market_catalog(registry_url.to_string()).await?;
    let entry = registry
        .plugins
        .iter()
        .find(|candidate| candidate.id == plugin_id)
        .ok_or_else(|| format!("plugin not found in registry: {plugin_id}"))?;
    let bytes = fetch_json(&entry.download_url, MAX_PACKAGE_BYTES).await?;
    let actual_hash = format!("{:x}", Sha256::digest(&bytes));
    if actual_hash != entry.sha256 {
        return Err(format!(
            "plugin checksum mismatch: expected {}, got {actual_hash}",
            entry.sha256
        ));
    }
    let mut package: PluginPackage = serde_json::from_slice(&bytes)
        .map_err(|error| format!("invalid plugin package JSON: {error}"))?;
    validate_package(&package)?;
    if package.manifest.id != entry.id || package.manifest.version != entry.version {
        return Err("plugin package identity does not match registry entry".to_string());
    }
    if let Some(runtime) = &package.manifest.runtime {
        let code_bytes = fetch_json(&runtime.entry, MAX_CODE_BYTES).await?;
        let actual_hash = format!("{:x}", Sha256::digest(&code_bytes));
        if actual_hash != runtime.sha256 {
            return Err(format!(
                "plugin code checksum mismatch: expected {}, got {actual_hash}",
                runtime.sha256
            ));
        }
        package.code = Some(
            String::from_utf8(code_bytes)
                .map_err(|_| "plugin code must be valid UTF-8 JavaScript".to_string())?,
        );
    }
    Ok(package)
}
