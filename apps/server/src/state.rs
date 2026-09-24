//! 跨请求共享的应用状态。

use std::sync::Arc;

use greywork_host::commands::CommandContext;

use crate::auth::{LoginThrottle, SessionStore};
use crate::config::ServerConfig;
use crate::host::EventBus;

/// 服务端共享状态。全部字段是 `Arc`/`Clone`，可廉价克隆进每个请求。
#[derive(Clone)]
pub struct AppState {
    /// 命令上下文（`dispatch` 的入参）：启动期建一次，跨请求复用。
    pub ctx: Arc<CommandContext>,
    /// 事件总线：WS handler 订阅，`ServerHost` 发布。
    pub bus: EventBus,
    /// 会话表 + 密码校验。
    pub sessions: Arc<SessionStore>,
    /// 登录限流。
    pub throttle: Arc<LoginThrottle>,
    /// 服务端配置（安全策略真源）。
    pub config: Arc<ServerConfig>,
}
