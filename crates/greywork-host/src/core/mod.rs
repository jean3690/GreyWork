//! L0 core：宿主出口契约、跨层端口 trait 与纯原语。
//!
//! 本层不依赖任何其他层，可被 L1–L4 自由使用。
//! - [`host`]：`HostContext` 宿主出口（桌面 / 服务端的唯一契约）。
//! - [`ports`]：跨层端口 trait（存储、工作区、通道等）的定义处。
//! - [`log`] / [`text`] / [`path_safety`] / [`csp`]：无副作用的纯工具。

pub mod csp;
pub mod host;
pub mod log;
pub mod path_safety;
pub mod ports;
pub mod text;
