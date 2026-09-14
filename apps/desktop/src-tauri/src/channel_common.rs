//! 消息通道共用的宿主工具。
//!
//! 每个通道各有一套协议（微信 iLink / 钉钉 Stream / 飞书长连接），但落到宿主侧的动作
//! 是同一批：把事件广播出去、把凭证与状态写成私有文件、在任务代际变化时可中断地等待。
//! 这些放在这里，通道模块只写自己的协议与状态机。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};

/// 事件出口：把 (事件名, 载荷) 交给宿主广播。
pub type EventSink = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;

/// 通道数据目录：`<应用数据>/<channel>`（凭证、游标、联系人凭据都落这里）。
pub fn channel_dir(app: &AppHandle, channel: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("应用数据目录不可用: {error}"))?
        .join(channel);
    std::fs::create_dir_all(&dir).map_err(|error| format!("创建通道目录失败: {error}"))?;
    Ok(dir)
}

/// 写私有文件：内容敏感（bot token / 会话 webhook），unix 下收紧到 0600。
pub fn write_private(path: &Path, contents: &[u8]) -> Result<(), String> {
    std::fs::write(path, contents)
        .map_err(|error| format!("写 {} 失败: {error}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// 读 JSON 文件；缺失 / 损坏 / 形状不符一律当作「没有」（调用方回落到默认状态）。
pub fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0)
}

/// 可中断休眠：每 500ms 检查一次任务代际，重连 / 断开能立刻结束等待。
/// 返回 false 表示本任务已被取代，应退出。
pub async fn sleep_or_stop(epochs: &AtomicU64, epoch: u64, total: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + total;
    loop {
        if epochs.load(Ordering::SeqCst) != epoch {
            return false;
        }
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return true;
        }
        tokio::time::sleep(std::cmp::min(deadline - now, Duration::from_millis(500))).await;
    }
}

/// 把 AppHandle 包成事件出口。
pub fn app_sink(app: &AppHandle) -> EventSink {
    let emitter = app.clone();
    Arc::new(move |event, payload| {
        let _ = emitter.emit(event, payload);
    })
}
