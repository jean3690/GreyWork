//! 系统诊断面（对比 AionUi 后端 `/api/system/info` 的进程内形态）。
//! 设置页「关于」卡消费：版本 / DB schema / 日志目录 / 活跃 ACP 进程。

use serde::Serialize;

/// 系统诊断快照。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SysInfo {
    /// 应用版本（Cargo.toml package.version）。
    pub version: String,
    /// 数据库 schema 版本（migration 链深度）。
    pub schema_version: i64,
    /// 日志文件目录（log::init 后存在）。
    pub log_dir: Option<String>,
    /// 活跃 ACP 后端进程数。
    pub active_agents: usize,
    /// 宿主 OS 名。
    pub os: String,
}

/// 系统信息快照。
#[tauri::command]
pub async fn sys_info(
    db: tauri::State<'_, crate::db::Db>,
    acp: tauri::State<'_, crate::acp_host::AcpHost>,
) -> Result<SysInfo, String> {
    Ok(SysInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        schema_version: db.schema_version()?,
        log_dir: crate::log::dir().map(|path| path.to_string_lossy().into_owned()),
        active_agents: acp.session_count().await,
        os: std::env::consts::OS.to_string(),
    })
}

/// 校验待揭示的路径：非空、绝对、真实存在。
///
/// 抽成纯函数便于单测；`reveal_path` 只负责把校验过的路径交给 opener 插件。
/// 目录与文件都合法（目录 → 打开目录本身，文件 → 在其所在目录中选中）。
fn validate_reveal_path(raw: &str) -> Result<std::path::PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("路径为空".into());
    }
    let path = std::path::PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err("只接受绝对路径".into());
    }
    if !path.exists() {
        return Err(format!("路径不存在: {trimmed}"));
    }
    Ok(path)
}

/// 在系统文件管理器中揭示某路径（交付物卡片「在文件夹中打开」）。
///
/// 走已在依赖里的 opener 插件（capability `opener:default` 已含
/// `allow-reveal-item-in-dir`），不自造平台分支。
#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    let target = validate_reveal_path(&path)?;
    tauri_plugin_opener::reveal_item_in_dir(&target).map_err(|e| format!("打开文件夹失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sys_info_shape_is_camel_cased() {
        let json = serde_json::to_value(SysInfo {
            version: "0.1.0".into(),
            schema_version: 5,
            log_dir: Some("/tmp/logs".into()),
            active_agents: 2,
            os: "linux".into(),
        })
        .expect("serialize");
        let map = json.as_object().expect("object");
        assert!(
            map.contains_key("schemaVersion"),
            "camelCase: schemaVersion"
        );
        assert!(map.contains_key("logDir"));
        assert!(map.contains_key("activeAgents"));
        assert_eq!(map["version"], "0.1.0");
    }

    #[test]
    fn reveal_path_rejects_empty_relative_and_missing() {
        assert!(validate_reveal_path("   ").is_err());
        assert!(validate_reveal_path("relative/dir").is_err());
        assert!(validate_reveal_path("/definitely/not/here/gw-missing").is_err());
        // 存在的绝对路径（目录）通过
        let tmp = std::env::temp_dir();
        assert_eq!(validate_reveal_path(&tmp.to_string_lossy()).unwrap(), tmp);
    }
}
