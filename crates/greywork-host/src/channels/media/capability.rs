//! 通道媒体能力矩阵与降级规则。

use serde::Serialize;

use super::types::MediaKind;

/// 通道的媒体能力：能收哪些类别、能**原生**发哪些类别。
///
/// `outbound` 只列原生端点支持的类别；发不了原生的类别由共享层的降级规则补上
/// （「这条通道能发文件，就把视频 / 语音当文件发」）。序列化成
/// `{ "inbound": [...], "outbound": [...] }`，渲染端据此如实提示。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelMediaCapability {
    pub inbound: Vec<MediaKind>,
    pub outbound: Vec<MediaKind>,
}

/// 构造能力（少写点 `to_vec`）。
fn caps(inbound: &[MediaKind], outbound: &[MediaKind]) -> ChannelMediaCapability {
    ChannelMediaCapability {
        inbound: inbound.to_vec(),
        outbound: outbound.to_vec(),
    }
}

/// 本版已接入媒体的通道（能力矩阵的遍历顺序，也是渲染端兜底矩阵的依据）。
pub const CHANNELS: [&str; 7] = [
    "wechat", "dingtalk", "feishu", "telegram", "qq", "discord", "wecom",
];

/// 通道的媒体能力。**协议事实的单一事实来源**：能收 / 能原生发哪些类别都看这里，
/// 与「哪条通道的实现已经接入」无关 —— 后者由 `channel_send_media` 的分发决定。
pub fn capability_of(channel: &str) -> ChannelMediaCapability {
    use MediaKind::{Audio, File, Image, Video};
    match channel {
        // 双向收发图片 / 视频 / 文件；SDK 没有语音发送端点，音频降级为文件。
        "wechat" => caps(&[Image, Video, Audio, File], &[Image, Video, File]),
        // 全类别原生双向。
        "telegram" | "discord" => caps(&[Image, Video, Audio, File], &[Image, Video, Audio, File]),
        // 出站 media 需封面 `image_key`、audio 需 opus，原生只到图片与文件（视频音频降级为文件）。
        "feishu" => caps(&[Image, Video, Audio, File], &[Image, File]),
        // 语音端点要 SILK 编码，原生只到图片与视频（音频降级为文件）。
        "qq" => caps(&[Image, Video, Audio, File], &[Image, Video, File]),
        // 被动回复只能把图片塞进 stream 的图文混排，没有文件出口；入站语音由企业微信转写成文本
        // （无原始音频可下），按文本转达而不进媒体矩阵。
        "wecom" => caps(&[Image, Video, File], &[Image]),
        // sessionWebhook 只认 text/markdown/link/actionCard/feedCard，出站没有任何媒体通道；
        // 入站图片 / 视频 / 语音 / 文件仅单聊可收（群聊常缺 downloadCode）。
        "dingtalk" => caps(&[Image, Video, Audio, File], &[]),
        _ => caps(&[], &[]),
    }
}

/// 该能力下这种媒体能不能出站：原生支持，或能降级为文件发。
///
/// 渲染端 `channelMediaAllows` 与宿主侧同一口径 —— 两端都只做「提前告知」与「拦截」，
/// 真正的降级改写发生在 `channel_send_media`。
pub fn capability_allows(cap: &ChannelMediaCapability, kind: MediaKind) -> bool {
    if cap.outbound.contains(&kind) {
        return true;
    }
    kind != MediaKind::File && cap.outbound.contains(&MediaKind::File)
}

/// 出站类别 → 实际下发给通道的类别：能力不允许返回 None，非原生但可降级的改写为 `File`。
///
/// 各通道的 `match media.kind` 因此只会见到自己原生支持的类别。
pub fn effective_kind(cap: &ChannelMediaCapability, kind: MediaKind) -> Option<MediaKind> {
    if !capability_allows(cap, kind) {
        return None;
    }
    if cap.outbound.contains(&kind) {
        Some(kind)
    } else {
        Some(MediaKind::File)
    }
}
