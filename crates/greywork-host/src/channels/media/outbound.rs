//! 出站授权校验、读取与降级改写。

use crate::core::ports::WorkspaceFs;
use crate::log;

use super::capability::{capability_of, effective_kind, ChannelMediaCapability};
use super::naming::resolve_media_kind_named;
use super::types::{MediaKind, OutboundMedia};
use super::MAX_MEDIA_BYTES;

/// 读一条要发出去的本地文件：先过授权面，再卡大小，最后读字节并判类。
///
/// `path` 必须落在已授权路径内（与 `fs_read_binary` 同一授权面）：渲染端选过的文件、
/// `~/.greyWork` 下的附件都在其中，不新开授权面。显式 kind 由调用方在拿到 `bytes` 后
/// 用 `resolve_media_kind_named(Some(kind), &media.name, &media.bytes)` 覆盖。
pub fn load_outbound_media(access: &dyn WorkspaceFs, path: &str) -> Result<OutboundMedia, String> {
    let real = access.resolve_existing(path)?;
    let metadata =
        std::fs::metadata(&real).map_err(|error| format!("读取文件元数据失败: {error}"))?;
    if !metadata.is_file() {
        return Err("只能发送文件".into());
    }
    if metadata.len() > MAX_MEDIA_BYTES {
        return Err(format!(
            "文件超过 {} MB 上限",
            MAX_MEDIA_BYTES / (1024 * 1024)
        ));
    }
    let bytes = std::fs::read(&real).map_err(|error| format!("读取文件失败: {error}"))?;
    let name = real
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "attachment".into());
    let kind = resolve_media_kind_named(None, &name, &bytes);
    Ok(OutboundMedia { bytes, name, kind })
}

/// 类别的中文名（错误文案用）。
fn kind_label(kind: MediaKind) -> &'static str {
    match kind {
        MediaKind::Image => "图片",
        MediaKind::Video => "视频",
        MediaKind::Audio => "语音",
        MediaKind::File => "文件",
    }
}

/// 能力不允许时的说明文案（宿主侧兜底；渲染端另有一份 i18n 提示）。
fn capability_error(channel: &str, cap: &ChannelMediaCapability, kind: MediaKind) -> String {
    if cap.outbound.is_empty() {
        return if cap.inbound.is_empty() {
            format!("{channel} 不支持发送文件")
        } else {
            format!("{channel} 只能接收消息，无法向外发送")
        };
    }
    format!("{channel} 不支持发送{}", kind_label(kind))
}

/// 发一条媒体前的公共准备：过授权面 → 卡能力 → 降级改写。
///
/// 能力检查放在这里而不是各通道里：钉钉（无出站媒体）、企业微信（只能发图片）这类
/// 协议约束在唯一一处拦截，渲染端只是「提前告知」，不是唯一防线。返回的 `OutboundMedia`
/// 已按能力改写完毕（非原生但可降级的类别已变 `File`），各通道的 `match media.kind`
/// 因此只会见到自己原生支持的类别。
///
/// 真正的「按通道上传」由各宿主壳分发（见模块头注释）。
pub fn prepare_outbound(
    access: &dyn WorkspaceFs,
    channel: &str,
    path: &str,
    kind: Option<&str>,
) -> Result<OutboundMedia, String> {
    let cap = capability_of(channel);
    let mut media = load_outbound_media(access, path)?;
    if let Some(explicit) = kind {
        media.kind = resolve_media_kind_named(Some(explicit), &media.name, &media.bytes);
    }
    let Some(effective) = effective_kind(&cap, media.kind) else {
        return Err(capability_error(channel, &cap, media.kind));
    };
    // 原生端点做不到、但这条通道能发文件：降级为文件发。集中在这一处。
    if effective != media.kind {
        log::info(
            channel,
            format!(
                "{channel} 无原生{}端点，降级为文件发送: {}",
                kind_label(media.kind),
                media.name
            ),
        );
        media.kind = effective;
    }
    Ok(media)
}
