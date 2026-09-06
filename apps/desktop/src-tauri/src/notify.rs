//! 系统通知（tauri-plugin-notification 薄封装）。
//!
//! 目标场景：**窗口不可见时仍需兜住的事件**——宿主兜底执行完自动化、ACP 权限
//! 待裁决（超时即取消，错过不可恢复）。窗口可见的事件走前端 toast，不在此列。
//!
//! 设计：
//! - **失败即降级**：无通知守护进程（Linux 无 daemon）、macOS 首次未授权、
//!   Windows 未注册 AppID 等情况只记日志——通知是旁路上报，绝不能反过来影响
//!   自动化执行或权限等待这些主流程。
//! - Rust 端直调插件 API，不经 ACL（ACL 只拦渲染端命令）；capability 里的
//!   `notification:default` 是给将来渲染端直发通知预留的。

use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

/// 发一条系统通知；失败只记日志。
pub fn send(app: &AppHandle, title: &str, body: &str) {
    match app.notification().builder().title(title).body(body).show() {
        Ok(()) => crate::log::info("notify", format!("已发送: {title}")),
        Err(error) => crate::log::warn("notify", format!("发送失败（{title}）: {error}")),
    }
}
