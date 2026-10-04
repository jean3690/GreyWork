//! L4 app：组合根与命令注册表。
//!
//! 本层是依赖的顶点，只被 `apps/*` 消费；回根后即 `greywork_host::commands`。

pub mod commands;
