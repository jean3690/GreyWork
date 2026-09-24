//! 桌面侧的 [`HostContext`] 实现：把 Tauri 的 `AppHandle` 包成宿主出口。
//!
//! 领域逻辑（`crates/greywork-host`）不认识 Tauri，只认 `HostContext`。桌面壳是它的
//! 实现方之一：`emit` 走 Tauri 的全局事件（渲染端 `listen` 收），`notify` 走系统通知。
//!
//! 服务端侧将来有对称的 `ServerHost`（事件推 WebSocket、通知变事件）——两侧实现同一个
//! trait，领域模块因此完全不必知道自己跑在谁的进程里。

use std::sync::Arc;

use greywork_host::host::{HostContext, HostPaths};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

pub struct TauriHost {
    app: AppHandle,
    paths: HostPaths,
}

impl TauriHost {
    /// 从 `AppHandle` 取一次路径快照。
    ///
    /// 失败即报错而不是退回空路径：`home_dir` 为空会让沙盒挂载错目录、`app_data_dir`
    /// 为空会把凭据写到当前工作目录 —— 都是静默的安全问题，不如在启动期就炸掉。
    pub fn new(app: AppHandle) -> Result<Self, String> {
        let paths = HostPaths::new(
            app.path()
                .home_dir()
                .map_err(|error| format!("home_dir 不可用: {error}"))?,
            app.path()
                .app_data_dir()
                .map_err(|error| format!("app_data_dir 不可用: {error}"))?,
        );
        Ok(Self { app, paths })
    }

    pub fn into_arc(self) -> Arc<dyn HostContext> {
        Arc::new(self)
    }
}

impl HostContext for TauriHost {
    fn paths(&self) -> &HostPaths {
        &self.paths
    }

    fn emit(&self, event: &str, payload: Value) {
        // 与既有各处 `let _ = app.emit(..)` 同语义：没有监听者不算错误。
        let _ = self.app.emit(event, payload);
    }

    fn notify(&self, title: &str, body: &str) {
        crate::notify::send(&self.app, title, body);
    }
}
