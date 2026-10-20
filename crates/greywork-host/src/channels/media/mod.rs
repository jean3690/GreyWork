//! 聊天通道共用的媒体层：入站落盘 / 取走、出站授权与读取、能力矩阵，以及三个通用命令。
//!
//! 七条通道（微信 / 钉钉 / 飞书 / Telegram / QQ / Discord / 企业微信）的媒体协议各不相同，
//! 但落到宿主侧的动作是同一批：把下载到的字节安全落进 `<应用数据>/<channel>/inbox`、
//! 让渲染端凭路径取走、把授权面内的本地文件读出来交给各通道上传。这些放在这里，
//! 通道模块只写自己的协议与上传端点。
//!
//! 与 `channel_common` 的分工：那边是「连媒体都不涉及」的基础设施（目录 / 事件 / 私有写），
//! 这边是需要 `WorkspaceFsAccess`、`serde` 与 `HostContext` 的媒体关注点。
//!
//! 命令刻意做成「一对通用入口 + 按 channel 分发」，而不是七条通道各来一对：
//! take 的逻辑与通道无关（唯一变量是 inbox 目录名，而目录名就是 channel 名）；
//! send 的差异只在「用哪套协议上传」这一处，由 [`ChannelHost`] 抽象、[`send_media_via`] 统一分发。
//!
//! 「从宿主取某个通道 host」是宿主专有的：桌面用 `AppHandle::state::<XHost>()`、服务端用
//! `CommandContext` 里的各 host 字段。两端各自把这些 host 摆进 [`ChannelRegistry`]（一行一条），
//! 分发逻辑因此只写一遍。
//!
//! # 子模块
//!
//! - [`types`]：核心类型（`MediaKind` / `MediaRefDto` / `OutboundMedia`）；
//! - [`host`]：通道媒体出口 trait 与注册表；
//! - [`capability`]：通道媒体能力矩阵与降级规则；
//! - [`naming`]：命名 / 魔数嗅探 / 判类纯函数；
//! - [`store`]：入站落盘 / 取走（inbox）；
//! - [`outbound`]：出站授权校验、读取与降级改写；
//! - [`dispatch`]：按通道分发上传 + 能力矩阵命令；
//! - [`commands`]：命令入参。

mod capability;
mod commands;
mod dispatch;
mod host;
mod naming;
mod outbound;
mod store;
mod types;

#[cfg(test)]
mod tests;

pub use capability::{
    capability_allows, capability_of, effective_kind, ChannelMediaCapability, CHANNELS,
};
pub use commands::{SendMediaArgs, TakeMediaArgs};
pub use dispatch::{channel_media_capabilities, send_media_via};
pub use host::{ChannelHost, ChannelRegistry};
pub use naming::{
    ext_of, finalize_media, inbox_file_name, kind_by_name, resolve_media_kind_named,
    sanitize_display_name, sniff_audio, sniff_image, sniff_video,
};
pub use outbound::{load_outbound_media, prepare_outbound};
pub use store::{
    channel_take_media, inbox_dir, prune_inbox, store_inbound_media, take_media_from_inbox,
};
pub use types::{MediaKind, MediaRefDto, OutboundMedia};

use std::time::Duration;

/// 入站媒体收件目录名（`<应用数据>/<channel>/inbox`）。
pub const INBOX_SUB_DIR: &str = "inbox";
/// 收件文件保留时长：渲染端崩溃 / 未取走的孤儿超过它就清理。
pub const INBOX_STALE: Duration = Duration::from_secs(24 * 60 * 60);
/// 单个媒体文件的明文上限（入站落盘与出站读取共用）。
pub const MAX_MEDIA_BYTES: u64 = 20 * 1024 * 1024;
