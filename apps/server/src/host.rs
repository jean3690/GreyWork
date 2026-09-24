//! 服务端的 [`HostContext`] 实现：事件推广播通道（由 WS 下发给浏览器），通知变事件。
//!
//! 与桌面侧 `TauriHost`（`emit` → Tauri 全局事件、`notify` → 系统通知）对称。领域模块
//! 只认 `HostContext`，因此同一份逻辑在两侧跑起来行为一致。

use std::sync::Arc;

use greywork_host::host::{HostContext, HostPaths};
use serde_json::Value;

/// 一条要下发给浏览器的宿主事件。
///
/// 信封与 Tauri 的 `listen(name, event => event.payload)` 对应：前端按 `event` 过滤、
/// 取 `payload`。序列化后即 WS 文本帧。
#[derive(Clone, Debug, serde::Serialize)]
pub struct ServerEvent {
    pub event: String,
    pub payload: Value,
}

/// 进程内事件总线：`ServerHost` 发布，WS handler 订阅。
///
/// 用 `broadcast`（多消费者）而非 `mpsc`：多个浏览器标签页各连一条 WS，都要收到同一事件。
#[derive(Clone)]
pub struct EventBus {
    tx: tokio::sync::broadcast::Sender<ServerEvent>,
}

impl EventBus {
    /// `capacity` 为每订阅者的环形缓冲长度；慢消费者落后时收到 `Lagged` 并跳过旧事件
    /// （尽力而为，与 Tauri emit 同语义，不重放）。
    pub fn new(capacity: usize) -> Self {
        let (tx, _rx) = tokio::sync::broadcast::channel(capacity);
        Self { tx }
    }

    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<ServerEvent> {
        self.tx.subscribe()
    }

    /// 发布一条事件。无订阅者时 `send` 返回错误，与 Tauri 的 `let _ = app.emit(..)` 同语义
    /// —— 没人听不算失败。
    pub fn publish(&self, event: &str, payload: Value) {
        let _ = self.tx.send(ServerEvent {
            event: event.to_string(),
            payload,
        });
    }
}

/// 服务端宿主出口。
pub struct ServerHost {
    paths: HostPaths,
    bus: EventBus,
}

impl ServerHost {
    pub fn new(paths: HostPaths, bus: EventBus) -> Self {
        Self { paths, bus }
    }
}

impl HostContext for ServerHost {
    fn paths(&self) -> &HostPaths {
        &self.paths
    }

    fn emit(&self, event: &str, payload: Value) {
        self.bus.publish(event, payload);
    }

    fn notify(&self, title: &str, body: &str) {
        // 服务端没有系统通知面：变成一条 `host://notify` 事件，浏览器自行决定怎么呈现。
        self.bus.publish(
            "host://notify",
            serde_json::json!({ "title": title, "body": body }),
        );
    }
}

/// 把 `ServerHost` 包成 `EventSink`（供需要 sink 的领域模块用）。
pub fn event_sink(host: Arc<dyn HostContext>) -> greywork_host::host::EventSink {
    greywork_host::host::event_sink(host)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host_with_bus() -> (Arc<dyn HostContext>, EventBus) {
        let bus = EventBus::new(16);
        let paths = HostPaths::new("/tmp/home", "/tmp/data");
        let host: Arc<dyn HostContext> = Arc::new(ServerHost::new(paths, bus.clone()));
        (host, bus)
    }

    #[test]
    fn emit_reaches_subscribers() {
        let (host, bus) = host_with_bus();
        let mut rx = bus.subscribe();
        host.emit("acp://event", serde_json::json!({ "kind": "x" }));
        let event = rx.try_recv().expect("应收到事件");
        assert_eq!(event.event, "acp://event");
        assert_eq!(event.payload, serde_json::json!({ "kind": "x" }));
    }

    #[test]
    fn notify_becomes_host_notify_event() {
        let (host, bus) = host_with_bus();
        let mut rx = bus.subscribe();
        host.notify("标题", "正文");
        let event = rx.try_recv().expect("应收到通知事件");
        assert_eq!(event.event, "host://notify");
        assert_eq!(
            event.payload,
            serde_json::json!({ "title": "标题", "body": "正文" })
        );
    }

    #[test]
    fn publish_without_subscribers_is_not_an_error() {
        let (host, _bus) = host_with_bus();
        // 无订阅者时不应 panic。
        host.emit("automation://due", Value::Null);
    }
}
