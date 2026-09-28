//! 调度器的桌面启动入口；tick 循环实现收在 `greywork_host::scheduler`。

use std::path::PathBuf;
use std::sync::Arc;

use greywork_host::host::HostContext;

/// 启动周期 tick 循环（Tauri `setup` 阶段调用）。
///
/// 必须用 `tauri::async_runtime::spawn` 而不是 `tokio::spawn`：`setup` 不在 tokio
/// runtime 上下文里，裸 spawn 会 panic（共享 crate 因此只提供循环、不负责起它）。
///
/// 阈值固定为 [`DEFAULT_STALE_AFTER_MS`]：桌面端渲染端与宿主同机，渲染端 30s 轮询才是
/// 主执行者，宿主只在该窗口过后补位。桌面**不做**主执行者模式 —— 「得一直开着自己的电脑」
/// 正是用户要摆脱的形态，无人值守跑在服务端（见服务端的 `GREYWORK_AUTOMATION_HOST_PRIMARY`）。
pub fn spawn_ticker(host: Arc<dyn HostContext>, db_path: PathBuf) {
    tauri::async_runtime::spawn(greywork_host::scheduler::run_ticker(
        host,
        db_path,
        greywork_host::host_exec::DEFAULT_STALE_AFTER_MS,
    ));
}
