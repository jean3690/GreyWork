//! 宿主出口：领域逻辑与具体宿主（Tauri 桌面壳 / headless 服务端）之间的唯一接口。
//!
//! 本 crate 里的模块需要三类「宿主能力」：事件广播、系统通知、以及应用数据/家目录的
//! 位置。它们都由 [`HostContext`] 提供，由两侧各自实现：
//!
//! - 桌面：`TauriHost` 包一个 `AppHandle`，`emit` 走 Tauri 的全局事件，`notify` 走系统通知；
//! - 服务端：`ServerHost` 把事件推进广播通道，由 WebSocket 下发给浏览器，`notify` 变成
//!   一条 `host://notify` 事件。
//!
//! 这样领域模块不必知道自己在谁的进程里跑 —— 这也是它们能从桌面壳搬进本 crate 的前提。
//!
//! **注意**：`HostContext` 只承载「出口」，不承载「入参」。需要读配置、查数据库的地方仍然
//! 直接依赖对应的模块（`db::Db` 等），不要把它们塞进这个 trait —— 那会把 trait 变成
//! 上帝对象，两侧实现都要跟着长。

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;

/// 事件出口：把 (事件名, 载荷) 交给宿主广播。
///
/// 与 Tauri 的 `emit` 同形（事件名 + 任意 JSON），这样桌面侧的实现几乎零成本，
/// 而服务端只要把它序列化到 WebSocket 上。通道模块此前就按这个签名存 `EventSink`，
/// 因此它们不需要改存储形状。
pub type EventSink = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// 宿主提供的固定路径。
///
/// 只有这两个：`home_dir` 用于定位 agent 的配置目录（沙盒要只读挂载），
/// `app_data_dir` 用于落凭据、日志、授权账本与 SQLite。
///
/// 用普通结构体而不是 trait 方法逐个取：这些值在进程启动后就固定了，没必要每次问一次
/// 宿主，也没必要让两侧实现各写一遍 `fn home_dir()`。
#[derive(Clone, Debug)]
pub struct HostPaths {
    pub home_dir: PathBuf,
    pub app_data_dir: PathBuf,
}

impl HostPaths {
    pub fn new(home_dir: impl Into<PathBuf>, app_data_dir: impl Into<PathBuf>) -> Self {
        Self {
            home_dir: home_dir.into(),
            app_data_dir: app_data_dir.into(),
        }
    }
}

/// 宿主能力出口。领域模块只依赖它，不依赖 tauri。
pub trait HostContext: Send + Sync + 'static {
    /// 进程启动时固定的路径集合。
    fn paths(&self) -> &HostPaths;

    /// 广播一条事件（等价 Tauri 的全局 `emit`）。
    fn emit(&self, event: &str, payload: Value);

    /// 发一条面向用户的通知。桌面 = 系统通知；服务端 = 推 `host://notify` 事件
    /// （浏览器侧自行决定怎么呈现，或干脆不呈现）。
    fn notify(&self, title: &str, body: &str);
}

/// 把 `HostContext` 包成 [`EventSink`]。
///
/// 刻意做成自由函数而不是 `HostContext` 的方法：`fn event_sink(self: Arc<Self>)` 会让
/// trait 失去 dyn 兼容性，而我们要的就是 `Arc<dyn HostContext>`。
pub fn event_sink(host: Arc<dyn HostContext>) -> EventSink {
    Arc::new(move |event, payload| host.emit(event, payload))
}

/// 发一条事件，载荷是任意可序列化值。
///
/// 存在的意义是把「`serde_json::to_value` + 失败怎么办」收一处：调用点的载荷大多是
/// 一个 `#[derive(Serialize)]` 结构体，逐个写 `to_value(..).unwrap_or_default()` 既啰嗦，
/// 又会把序列化失败静默成 `null` 载荷 —— 前端拿到 `null` 只会莫名其妙地什么都不做。
/// 这里失败就记日志并**不发**（宁可少一条事件，也不发一条空壳）。
pub fn emit_json<T: serde::Serialize>(host: &dyn HostContext, event: &str, payload: T) {
    match serde_json::to_value(payload) {
        Ok(value) => host.emit(event, value),
        Err(error) => crate::log::error(
            "host",
            format!("事件 {event} 载荷序列化失败，已丢弃: {error}"),
        ),
    }
}

/// 通道数据目录：`<应用数据>/<channel>`，建好返回（凭据、游标、联系人凭据都落这里）。
pub fn ensure_channel_dir(host: &dyn HostContext, channel: &str) -> Result<PathBuf, String> {
    let dir = host.paths().app_data_dir.join(channel);
    std::fs::create_dir_all(&dir).map_err(|error| format!("创建通道目录失败: {error}"))?;
    Ok(dir)
}
