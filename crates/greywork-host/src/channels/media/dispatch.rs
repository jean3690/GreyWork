//! 按通道分发上传 + 能力矩阵命令。

use std::collections::BTreeMap;
use std::sync::Arc;

use crate::host::HostContext;

use super::capability::{capability_of, ChannelMediaCapability, CHANNELS};
use super::host::ChannelRegistry;
use super::types::OutboundMedia;

/// 按通道名把媒体交给注册表里的对应出口上传。
///
/// 未注册的通道报「未知通道: x」——与各宿主壳旧的 `match` 兜底分支文案一致。
pub async fn send_media_via(
    registry: &ChannelRegistry<'_>,
    host_ctx: &Arc<dyn HostContext>,
    channel: &str,
    peer_id: &str,
    context_token: Option<&str>,
    media: OutboundMedia,
) -> Result<(), String> {
    let host = registry
        .get(channel)
        .ok_or_else(|| format!("未知通道: {channel}"))?;
    host.send_media(host_ctx, peer_id, context_token, media)
        .await
}

/// 各通道的媒体能力矩阵；渲染端启动时拉一次，据此提示「这条通道能发什么」。
pub fn channel_media_capabilities() -> BTreeMap<String, ChannelMediaCapability> {
    CHANNELS
        .iter()
        .map(|channel| ((*channel).to_string(), capability_of(channel)))
        .collect()
}
