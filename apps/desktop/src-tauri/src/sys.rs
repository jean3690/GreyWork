//! 系统诊断面的桌面命令入口 + 用系统程序揭示 / 打开已授权路径。
//!
//! 「系统信息」的实现收在 `greywork_host::sys`（与 headless 服务端共用）：本壳注入
//! 宿主侧事实 —— 应用版本、托盘有无，以及钉住的沙箱/档位（桌面没有配置覆盖，恒
//! false/None）。同一实现服务端也能经命令表调到（`sys_info` 已非桌面专属）。
//! 「揭示 / 打开」是纯宿主能力（`tauri_plugin_opener`），留在桌面壳。

use tauri::State;

/// 系统信息快照。实现收在 `greywork_host::sys`。
#[tauri::command]
pub async fn sys_info(
    db: State<'_, greywork_host::db::Db>,
    acp: State<'_, std::sync::Arc<crate::acp_host::AcpHost>>,
    tray: State<'_, crate::tray::TrayState>,
) -> Result<greywork_host::sys::SysInfo, String> {
    let facts = greywork_host::sys::HostFacts {
        version: env!("CARGO_PKG_VERSION").to_string(),
        tray_available: tray.available(),
        // 桌面端没有服务端那种配置覆盖：沙箱/档位始终由客户端请求决定。
        pinned_sandbox: false,
        pinned_tier: None,
    };
    greywork_host::sys::sys_info(&db, &acp, &facts).await
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
