//! 「有未保存改动时别退出」的宿主侧守卫。
//!
//! **为什么宿主还要管这件事**：点窗口 X 走渲染端的
//! `getCurrentWindow().onCloseRequested()`（JS 就地拦下、先保存再关），但另两条
//! 「退出」路径渲染端拿不到机会 ——
//! - 托盘菜单的「退出应用」：`app.exit(0)`，代码里已注明它绕过 CloseRequested（tray.rs）；
//! - macOS 的 Cmd+Q / 系统注销：走 `RunEvent::ExitRequested`。
//!
//! 所以宿主侧需要一份「当前有没有未保存改动」的标志，在 `ExitRequested` 里拦一次，
//! 再请渲染端走它的保存 / 确认流程。标志由渲染端推 —— 只有它知道编辑器里脏不脏，
//! 宿主不猜。
//!
//! **优先级**：`CloseRequested` 分支不动（见 lib.rs）。「关闭到托盘」为真时点 X 只是隐藏，
//! 不丢数据也不该弹窗，那条路径优先。

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{Emitter, Manager};

use crate::tray::MAIN_WINDOW;

/// 渲染端订阅的事件名（`lib/close-guard.ts` 里同名 —— 改一边必须改另一边）。
pub const EVENT_EXIT_REQUESTED: &str = "close-guard:exit-requested";

/// 退出守卫状态。只有渲染端推来的一个标志。
#[derive(Default)]
pub struct CloseGuard {
    unsaved: AtomicBool,
}

impl CloseGuard {
    pub fn has_unsaved(&self) -> bool {
        self.unsaved.load(Ordering::Relaxed)
    }

    /// 清标志。`confirm_exit` 用；也用于「弹不出确认」时的兜底放行。
    pub fn clear(&self) {
        self.unsaved.store(false, Ordering::Relaxed);
    }
}

/// 退出请求该不该拦。
///
/// 两条缺一不可：**有未保存改动**，且**主窗口还在** —— 窗口已销毁就弹不出确认弹层，
/// 拦下来只会把应用卡在既退不掉、又没法问的死局里。
pub fn exit_should_block(unsaved: bool, has_main_window: bool) -> bool {
    unsaved && has_main_window
}

/// 渲染端同步「是否有未保存改动」。
#[tauri::command]
pub fn set_unsaved_changes(state: tauri::State<'_, CloseGuard>, unsaved: bool) {
    state.unsaved.store(unsaved, Ordering::Relaxed);
}

/// 渲染端确认「可以退出」：先清标志再退。
///
/// **清标志必须在 `app.exit` 之前**：`app.exit` 会再触发一次 `ExitRequested`（带
/// `code: Some(0)`），标志若还在就会被自己拦下 —— 变成永远退不出去。
#[tauri::command]
pub fn confirm_exit(app: tauri::AppHandle) {
    if let Some(state) = app.try_state::<CloseGuard>() {
        state.clear();
    }
    app.exit(0);
}

/// `RunEvent::ExitRequested` 的处理：该拦就拦，并请渲染端处理。返回 true = 已拦截。
///
/// **不在这里清标志**：渲染端接下来可能保存成功、也可能被用户取消退出。
/// 取消时标志必须留着，否则下一次退出就漏了守卫；清只在 [`confirm_exit`] 里做。
pub fn handle_exit_requested(app: &tauri::AppHandle) -> bool {
    let Some(state) = app.try_state::<CloseGuard>() else {
        return false;
    };
    let has_window = app.get_webview_window(MAIN_WINDOW).is_some();
    if !exit_should_block(state.has_unsaved(), has_window) {
        return false;
    }
    let _ = app.emit(EVENT_EXIT_REQUESTED, ());
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_only_when_unsaved_and_window_alive() {
        assert!(exit_should_block(true, true));
        // 弹不出确认弹层，宁可放行 —— 不能把应用卡死。
        assert!(!exit_should_block(true, false));
        assert!(!exit_should_block(false, true));
        assert!(!exit_should_block(false, false));
    }

    #[test]
    fn default_is_clean_and_clear_resets() {
        let guard = CloseGuard::default();
        assert!(!guard.has_unsaved());
        guard.unsaved.store(true, Ordering::Relaxed);
        assert!(guard.has_unsaved());
        guard.clear();
        assert!(!guard.has_unsaved());
    }
}
