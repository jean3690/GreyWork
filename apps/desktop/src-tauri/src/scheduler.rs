//! 调度器的桌面启动入口；tick 循环实现收在 `greywork_host::scheduler`。

use std::path::PathBuf;
use std::sync::Arc;

use greywork_host::host::HostContext;

/// 启动周期 tick 循环（Tauri `setup` 阶段调用）。
///
/// 必须用 `tauri::async_runtime::spawn` 而不是 `tokio::spawn`：`setup` 不在 tokio
/// runtime 上下文里，裸 spawn 会 panic（共享 crate 因此只提供循环、不负责起它）。
pub fn spawn_ticker(host: Arc<dyn HostContext>, db_path: PathBuf) {
    tauri::async_runtime::spawn(greywork_host::scheduler::run_ticker(host, db_path));
}
