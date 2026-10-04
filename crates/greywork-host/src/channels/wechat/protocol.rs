use serde::Serialize;
use wechatbot::{CDNMedia, IncomingMessage, MessageItemType};

use crate::channel_media::{MediaKind, MediaRefDto};

/* ===== 宿主 DTO（渲染端 lib/wechat-backend.ts 的形状） ===== */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WechatStatusDto {
    pub logged_in: bool,
    pub user_id: Option<String>,
    pub bot_id: Option<String>,
    /// stopped / connecting / connected / paused / error
    pub state: String,
    pub detail: Option<String>,
    pub last_message_at: Option<i64>,
    pub pending_login: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WechatQrDto {
    /// 要编码成二维码的链接文本。
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WechatLoginPollDto {
    /// wait / confirmed / expired（SDK 不暴露「已扫码待确认」，故不会有 scaned）。
    pub status: String,
    /// `expired` 且宿主已自动换码时给出新二维码内容。
    pub qr_content: Option<String>,
    pub user_id: Option<String>,
    pub bot_id: Option<String>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WechatInboundDto {
    pub from_user_id: String,
    pub context_token: String,
    /// 文本内容；语音取微信云端转写。非文本消息为空串。
    pub text: String,
    /// item_list 的类型集合（1 文本 / 2 图片 / 3 语音 / 4 文件 / 5 视频）。
    pub item_types: Vec<i64>,
    /// 已下载解密的媒体（图片 / 视频 / 语音 / 文件）；失败或未支持的类型不出现在这里。
    pub media: Vec<MediaRefDto>,
    pub create_time_ms: i64,
    /// 宿主收到消息的时刻（epoch ms）。
    pub at: i64,
}

/* ===== 入站媒体：从 SDK 的解析结果里挑出要下载的条目 ===== */

/// 一条待下载的入站媒体（尚未取字节 / 解密）。
pub(super) struct InboundMedia {
    pub(super) kind: MediaKind,
    /// 展示名（图片无原名时按序号生成；文件取 `file_name`）。
    pub(super) name: String,
    /// 协议声明的明文大小（仅文件有；超限可提前拒绝）。
    pub(super) declared_size: Option<u64>,
    /// CDN 引用：地址与密钥都由 SDK 按协议拼，宿主不碰服务端下发的 URL。
    pub(super) media: CDNMedia,
    /// 解密密钥覆盖：图片的 key 常挂在 `image_item.aeskey` 而不是 media 里；None = 用 media 自带的。
    pub(super) aes_key: Option<String>,
}

/// 按条目自己的 `type` 抽可下载媒体：`2` 图片、`3` 语音、`4` 文件、`5` 视频。
///
/// 文本条目不进这里（`text_of` 另取）。缺少 `media`（拿不到 CDN 引用）的条目直接跳过。
pub(super) fn collect_media(message: &IncomingMessage) -> Vec<InboundMedia> {
    let mut out = Vec::new();
    for (index, item) in message.raw.item_list.iter().enumerate() {
        match item.item_type {
            MessageItemType::Image => {
                let Some(image) = item.image_item.as_ref() else {
                    continue;
                };
                let Some(media) = image.media.clone() else {
                    continue;
                };
                out.push(InboundMedia {
                    kind: MediaKind::Image,
                    name: format!("image-{index}"),
                    // 协议的图片条目没有明文大小字段（下载后再按实际字节数兜底）。
                    declared_size: None,
                    aes_key: nonempty(image.aeskey.as_deref())
                        .or_else(|| nonempty(Some(media.aes_key.as_str()))),
                    media,
                });
            }
            MessageItemType::Voice => {
                let Some(voice) = item.voice_item.as_ref() else {
                    continue;
                };
                let Some(media) = voice.media.clone() else {
                    continue;
                };
                out.push(InboundMedia {
                    kind: MediaKind::Audio,
                    name: format!("voice-{index}"),
                    declared_size: None,
                    // 语音没有独立 aeskey 字段，用 media 自带的。
                    aes_key: None,
                    media,
                });
            }
            MessageItemType::File => {
                let Some(file) = item.file_item.as_ref() else {
                    continue;
                };
                let Some(media) = file.media.clone() else {
                    continue;
                };
                let name = file
                    .file_name
                    .clone()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| format!("file-{index}"));
                out.push(InboundMedia {
                    kind: MediaKind::File,
                    name,
                    declared_size: file
                        .len
                        .as_deref()
                        .and_then(|value| value.trim().parse::<u64>().ok()),
                    media,
                    aes_key: None,
                });
            }
            MessageItemType::Video => {
                let Some(video) = item.video_item.as_ref() else {
                    continue;
                };
                let Some(media) = video.media.clone() else {
                    continue;
                };
                out.push(InboundMedia {
                    kind: MediaKind::Video,
                    name: format!("video-{index}"),
                    declared_size: video.video_size.and_then(|size| u64::try_from(size).ok()),
                    aes_key: None,
                    media,
                });
            }
            _ => {}
        }
    }
    out
}

/// 取消息文本：文本条目直取；语音条目取微信云端转写（协议自带，无需本地识别）。
///
/// 刻意不用 SDK 的 `IncomingMessage::text`：那会把图片 / 视频替换成 `[image]`、`[video]`
/// 之类的占位串，非文本消息就不再是空文本，「只认文字」那条兜底分支会失效。
pub(super) fn text_of(message: &IncomingMessage) -> String {
    let mut parts: Vec<String> = Vec::new();
    for item in &message.raw.item_list {
        let candidates = [
            item.text_item.as_ref().map(|text| text.text.as_str()),
            item.voice_item
                .as_ref()
                .and_then(|voice| voice.text.as_deref()),
        ];
        for text in candidates.into_iter().flatten() {
            if !text.trim().is_empty() {
                parts.push(text.trim().to_string());
            }
        }
    }
    parts.join("\n")
}

/// 条目类型集合（1 文本 / 2 图片 / 3 语音 / 4 文件 / 5 视频），供界面如实说明收到了什么。
pub(super) fn item_types_of(message: &IncomingMessage) -> Vec<i64> {
    message
        .raw
        .item_list
        .iter()
        .map(|item| item.item_type as i32 as i64)
        .collect()
}

/// 是否含「可识别条目」：文本 / 语音 / 图片 / 文件 / 视频（1..=5）。
///
/// 顶层 `message_type` 不可靠 —— 媒体消息也可能是 1，所以内容判定只看 `item_list`。
pub(super) fn has_recognizable_items(message: &IncomingMessage) -> bool {
    message
        .raw
        .item_list
        .iter()
        .any(|item| matches!(item.item_type as i32, 1..=5))
}

/// 非空字符串（空串与纯空白都视为「没有」）。
pub(super) fn nonempty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}
