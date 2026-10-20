//! 核心媒体类型。

use serde::Serialize;

/// 媒体类别（决定落盘 / 展示分支，也决定各通道走哪套端点）。
///
/// 序列化成 `"image" | "video" | "audio" | "file"`；`Audio` 是「语音 / 音频」的统一类别
/// （各通道的语音端点叫法不一：Telegram `voice`、QQ `silk`、飞书 `audio`、微信 `voice_item`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaKind {
    Image,
    Video,
    Audio,
    File,
}

impl MediaKind {
    pub fn as_str(self) -> &'static str {
        match self {
            MediaKind::Image => "image",
            MediaKind::Video => "video",
            MediaKind::Audio => "audio",
            MediaKind::File => "file",
        }
    }
}

/// 一条已落进 inbox 的入站媒体：字节在宿主侧，渲染端凭 `path` 取走。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaRefDto {
    /// "image" | "file"
    pub kind: String,
    pub name: String,
    pub mime: String,
    pub size: u64,
    /// inbox 里的绝对路径（`channel_take_media` 取走后由宿主删除）。
    pub path: String,
}

/// 出站媒体：授权面校验 + 读字节 + 判类之后的载荷。
pub struct OutboundMedia {
    pub bytes: Vec<u8>,
    /// 文件名（各通道上传时用；也是日志里的标识）。
    pub name: String,
    pub kind: MediaKind,
}
