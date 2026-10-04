//! 系统诊断面（进程内形态）。设置页「关于」卡消费：版本 / DB schema / 日志目录 /
//! 活跃 ACP 进程 / 内存 / 核数。
//!
//! 放在共享 crate 的依据：除「宿主侧事实」外，其余字段都是纯进程信息，与宿主无关。
//! 那些事实（应用版本、是否真有托盘、配置钉住的沙箱/档位）由调用方打包进
//! [`HostFacts`] 注入 —— 桌面壳传自身 `CARGO_PKG_VERSION` 与 `TrayState::available()`，
//! headless 服务端传自身版本、`false` 与配置钉住情况（见 apps/server）。
//!
//! **留桌面**的是「在文件管理器里揭示 / 打开已授权路径」—— 那是纯宿主能力
//! （`tauri_plugin_opener`），headless 没有对应物。

use serde::Serialize;

use crate::acp_host::AcpHost;
use crate::db::Db;

/// 宿主侧事实：实现本身无法得知、由宿主注入的输入。
///
/// 刻意是**一个结构**而不是一串参数：桌面与服务端各填各的，加字段时两侧的注入点
/// 一眼可见（漂移靠编译器 —— 漏填任何一项都编不过）。
#[derive(Clone, Debug)]
pub struct HostFacts {
    /// 应用版本（通常是其 crate 的 `CARGO_PKG_VERSION`）。
    pub version: String,
    /// 宿主是否真的建出了系统托盘。headless 恒 `false`。
    pub tray_available: bool,
    /// 宿主是否钉死了 agent 沙箱（服务端配置了 `GREYWORK_SANDBOX` 时为真，
    /// 与 `policy::overlay_args` 的覆盖条件同源）。桌面壳没有配置覆盖，恒 `false`。
    pub pinned_sandbox: bool,
    /// 宿主钉死的权限档位（服务端配置了 `GREYWORK_TIER` 时有值）。桌面恒 `None`。
    pub pinned_tier: Option<String>,
}

/// 系统诊断快照。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SysInfo {
    /// 应用版本（由调用方传入，通常是其 crate 的 `CARGO_PKG_VERSION`）。
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
    /// 宿主是否钉死了 agent 沙箱。设置页据此把沙盒卡置灰并说明。
    pub pinned_sandbox: bool,
    /// 宿主钉死的权限档位。设置页据此把档位卡置灰并说明。
    pub pinned_tier: Option<String>,
}

/// 逻辑核数。`available_parallelism` 是标准库唯一的可移植入口；容器里被 cgroup 限核时
/// 它给的是**限额后的**核数，正是"这台机器能并行跑多少"想要的语义。
pub fn cpu_count() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(0)
}

/// 低端设备判据（纯函数，便于单测）：物理内存 ≤ 4 GiB 或逻辑核数 ≤ 2。
///
/// 阈值与渲染端 `lib/device-tier.ts` 保持一致 —— 两侧对"低端"的定义必须同源，否则会出现
/// 宿主按低端关了 GPU 渲染、渲染端却按标准档跑动效的分裂状态。
/// 内存取不到（None）时不据此判低端，只留核数这一条，避免在拿不到信息的平台上误伤。
pub fn is_low_end(memory: Option<u64>, cores: usize) -> bool {
    const LOW_MEMORY_BYTES: u64 = 4 * 1024 * 1024 * 1024;
    if let Some(bytes) = memory {
        if bytes > 0 && bytes <= LOW_MEMORY_BYTES {
            return true;
        }
    }
    cores > 0 && cores <= 2
}

/// 本机是否低端设备。桌面壳只有 Linux 的 WebKitGTK 兜底会消费它（见其 lib.rs）。
pub fn is_low_end_device() -> bool {
    is_low_end(total_memory_bytes(), cpu_count())
}

/// 物理内存总量（字节）。跨平台各读各的：Linux 走 /proc/meminfo，macOS 走 sysctl，
/// 其余平台返回 None 由渲染端兜底 —— 不为一个诊断字段引入 sysinfo 这类重依赖。
pub fn total_memory_bytes() -> Option<u64> {
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

/// 系统信息快照。宿主侧事实见 [`HostFacts`]。
pub async fn sys_info(db: &Db, acp: &AcpHost, facts: &HostFacts) -> Result<SysInfo, String> {
    Ok(SysInfo {
        version: facts.version.clone(),
        schema_version: db.schema_version()?,
        log_dir: crate::log::dir().map(|path| path.to_string_lossy().into_owned()),
        active_agents: acp.session_count().await,
        os: std::env::consts::OS.to_string(),
        tray_available: facts.tray_available,
        total_memory_bytes: total_memory_bytes(),
        cpu_count: cpu_count(),
        pinned_sandbox: facts.pinned_sandbox,
        pinned_tier: facts.pinned_tier.clone(),
    })
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
            pinned_sandbox: true,
            pinned_tier: Some("read-only".into()),
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
        assert!(map.contains_key("pinnedSandbox"));
        assert!(map.contains_key("pinnedTier"));
        assert_eq!(map["version"], "0.1.0");
    }

    #[tokio::test]
    async fn host_facts_flow_into_sys_info() {
        let db = Db::open_in_memory().expect("db");
        let acp = AcpHost::default();
        let facts = HostFacts {
            version: "9.9.9-test".into(),
            tray_available: true,
            pinned_sandbox: true,
            pinned_tier: Some("read-only".into()),
        };
        let info = sys_info(&db, &acp, &facts).await.expect("sys_info");
        assert_eq!(info.version, "9.9.9-test");
        assert!(info.tray_available);
        assert!(info.pinned_sandbox);
        assert_eq!(info.pinned_tier.as_deref(), Some("read-only"));
    }

    #[test]
    fn cpu_count_is_positive() {
        // 任何真实运行环境都至少有一个可用核；0 只作为"取不到"的哨兵。
        assert!(cpu_count() >= 1);
    }

    #[test]
    fn low_end_thresholds_match_renderer() {
        let gib = |n: u64| n * 1024 * 1024 * 1024;
        // 内存 ≤ 4GiB 判低端（对齐 lib/device-tier.ts 的 LOW_MEMORY_GIB）
        assert!(is_low_end(Some(gib(4)), 8));
        assert!(is_low_end(Some(gib(1)), 8));
        assert!(!is_low_end(Some(gib(8)), 8));
        // 核数 ≤ 2 判低端
        assert!(is_low_end(Some(gib(16)), 2));
        assert!(!is_low_end(Some(gib(16)), 4));
        // 内存取不到时只看核数，不误判
        assert!(!is_low_end(None, 8));
        assert!(is_low_end(None, 2));
        // 两项都取不到（0）时按标准档走，不无端降级
        assert!(!is_low_end(None, 0));
    }
}
