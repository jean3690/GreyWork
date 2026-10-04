//! L3 channels：聊天通道（协议、凭证、连接、命令与媒体收发）。
//!
//! 本层依赖 L0–L2，向上为 L4 app 的命令注册提供各通道宿主。
//! [`common`] / [`media`] 是共享层：前者放协议通用工具，后者放 `ChannelHost` trait 与注册表；
//! 回根时分别别名成 `channel_common` / `channel_media`（旧路径不变）。

pub mod common;
pub mod dingtalk;
pub mod discord;
pub mod feishu;
pub mod media;
pub mod qq;
pub mod telegram;
pub mod wechat;
pub mod wecom;
