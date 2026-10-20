//! 通道媒体出口 trait 与注册表。

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use crate::host::HostContext;

use super::types::OutboundMedia;

/// 单条通道的媒体出口。
///
/// 「按通道上传」是宿主专有的一步（桌面从 Tauri state 取 host，服务端从 `CommandContext`
/// 取 host 字段）。把它收成 trait，各通道模块为自己的 host 实现，分发（[`send_media_via`]）
/// 就只写一遍；两端各自只负责把 host 摆进 [`ChannelRegistry`]。
pub trait ChannelHost: Send + Sync {
    /// 把已准备好的出站媒体交给本通道上传。
    ///
    /// `context_token` 仅微信使用（被动回复的上下文令牌）；其余通道忽略。
    fn send_media<'a>(
        &'a self,
        host_ctx: &'a Arc<dyn HostContext>,
        peer_id: &'a str,
        context_token: Option<&'a str>,
        media: OutboundMedia,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>>;
}

/// 通道名 → 媒体出口 的注册表。各宿主壳按自己的状态来源装配（桌面 `app.state`、
/// 服务端 `CommandContext` 字段），之后交给 [`send_media_via`] 统一分发。
pub struct ChannelRegistry<'a> {
    hosts: Vec<(&'static str, &'a dyn ChannelHost)>,
}

impl<'a> ChannelRegistry<'a> {
    pub fn new() -> Self {
        Self { hosts: Vec::new() }
    }

    /// 注册一条通道的媒体出口（链式）。
    pub fn register(mut self, channel: &'static str, host: &'a dyn ChannelHost) -> Self {
        self.hosts.push((channel, host));
        self
    }

    /// 取通道的媒体出口；未注册返回 None。
    pub fn get(&self, channel: &str) -> Option<&'a dyn ChannelHost> {
        self.hosts
            .iter()
            .find(|(name, _)| *name == channel)
            .map(|(_, host)| *host)
    }
}

impl Default for ChannelRegistry<'_> {
    fn default() -> Self {
        Self::new()
    }
}
