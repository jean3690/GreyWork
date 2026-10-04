//! L1 infra：本机资源适配器（数据库、工作区文件系统、git、进程与沙箱等）。
//!
//! 本层只依赖 L0 core，向上为 L2 services / L3 channels / L4 app 提供能力。

pub mod db;
pub mod git;
pub mod http;
pub mod process_guard;
pub mod sandbox;
pub mod sheet;
pub mod store_fs;
pub mod workspace_fs;
pub mod worktree;
