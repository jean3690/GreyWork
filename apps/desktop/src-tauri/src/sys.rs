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
    /// 宿主是否真的建出了系统托盘。设置页据此决定「关闭到托盘」能不能选 ——
    /// 没有托盘时该档位无效（宿主会把关闭行为钳回「关闭即退出」）。
    pub tray_available: bool,
    /// 物理内存总量（字节）。取不到为 None（渲染端回落 `navigator.deviceMemory`）。
    pub total_memory_bytes: Option<u64>,
    /// 逻辑核数。取不到为 0（渲染端回落 `navigator.hardwareConcurrency`）。
    pub cpu_count: usize,
}

/// 逻辑核数。`available_parallelism` 是标准库唯一的可移植入口；容器里被 cgroup 限核时
/// 它给的是**限额后的**核数，正是"这台机器能并行跑多少"想要的语义。
fn cpu_count() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0)
}

/// 物理内存总量（字节）。跨平台各读各的：Linux 走 /proc/meminfo，macOS 走 sysctl，
/// 其余平台返回 None 由渲染端兜底 —— 不为一个诊断字段引入 sysinfo 这类重依赖。
fn total_memory_bytes() -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        // MemTotal 单位 kB，形如 "MemTotal:       16316456 kB"。
        let text = std::fs::read_to_string("/proc/meminfo").ok()?;
        for line in text.lines() {
            if let Some(rest) = line.strip_prefix("MemTotal:") {
                let kib: u64 = rest.split_whitespace().next()?.parse().ok()?;
                return Some(kib.saturating_mul(1024));
            }
        }
        None
    }
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("sysctl")
            .args(["-n", "hw.memsize"])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        String::from_utf8(out.stdout).ok()?.trim().parse().ok()
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        None
    }
}

/// 系统信息快照。
#[tauri::command]
pub async fn sys_info(
    db: tauri::State<'_, crate::db::Db>,
    acp: tauri::State<'_, crate::acp_host::AcpHost>,
    tray: tauri::State<'_, crate::tray::TrayState>,
) -> Result<SysInfo, String> {
    Ok(SysInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        schema_version: db.schema_version()?,
        log_dir: crate::log::dir().map(|path| path.to_string_lossy().into_owned()),
        active_agents: acp.session_count().await,
        os: std::env::consts::OS.to_string(),
        tray_available: tray.available(),
        total_memory_bytes: total_memory_bytes(),
        cpu_count: cpu_count(),
    })
}

/// 在系统文件管理器中揭示已获授权的路径。
///
/// 与读写命令共用宿主授权面；渲染端不能利用 opener 探测或打开任意本机路径。
#[tauri::command]
pub fn reveal_path(
    access: tauri::State<'_, crate::workspace_fs::WorkspaceFsAccess>,
    path: String,
) -> Result<(), String> {
    let target = access.validate_existing(path.trim())?;
    tauri_plugin_opener::reveal_item_in_dir(&target).map_err(|e| format!("打开文件夹失败: {e}"))
}

/// 用系统默认程序打开已获授权的文件（预览面板「用系统应用打开」）。
///
/// 与 `reveal_path` 同一授权面：opener 的插件 scope 只在渲染端调用插件命令时才生效，
/// 这里走 Rust 自由函数，授权完全由 `validate_existing` 兜住。
#[tauri::command]
pub fn open_path(
    access: tauri::State<'_, crate::workspace_fs::WorkspaceFsAccess>,
    path: String,
) -> Result<(), String> {
    let target = access.validate_existing(path.trim())?;
    tauri_plugin_opener::open_path(&target, None::<&str>).map_err(|e| format!("打开文件失败: {e}"))
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
            tray_available: false,
            total_memory_bytes: Some(8 * 1024 * 1024 * 1024),
            cpu_count: 8,
        })
        .expect("serialize");
        let map = json.as_object().expect("object");
        assert!(
            map.contains_key("schemaVersion"),
            "camelCase: schemaVersion"
        );
        assert!(map.contains_key("logDir"));
        assert!(map.contains_key("activeAgents"));
        assert!(map.contains_key("trayAvailable"));
        assert!(map.contains_key("totalMemoryBytes"));
        assert!(map.contains_key("cpuCount"));
        assert_eq!(map["version"], "0.1.0");
    }

    #[test]
    fn cpu_count_is_positive() {
        // 任何真实运行环境都至少有一个可用核；0 只作为"取不到"的哨兵。
        assert!(cpu_count() >= 1);
    }
}
