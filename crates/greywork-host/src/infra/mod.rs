//! L1 infra：本机资源适配器（数据库、工作区文件系统等）。
//!
//! 本层只依赖 L0 core，向上为 L2 services / L4 app 提供能力。
//! 目前仅 [`db`] 已归位，其余 infra 模块仍平铺（见重构计划 P5）。

pub mod db;
pub mod workspace_fs;
