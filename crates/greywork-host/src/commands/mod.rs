//! 命令注册表：桌面 `generate_handler!` 与 headless 服务端 `dispatch` 的唯一对齐基准。
//!
//! 桌面壳仍用 Tauri 的 `generate_handler!`（它要求每个命令是具体的 `fn`，无法内省），
//! 这里另存一份**元数据表** [`COMMANDS`] 与一个**分发入口** [`dispatch`]，服务端用它把
//! HTTP/WS 请求路由到共享实现。两者会不会漂移由桌面壳里的漂移测试兜住 —— 它把
//! `generate_handler!` 的命令名集合与本表逐一比对。
//!
//! 设计要点：
//! - **不构造 `CommandContext` 的桌面端**：本表只为服务端提供分发；桌面端只是把同一批
//!   `#[tauri::command]` 薄包装注册进 Tauri。`CommandContext` 里的 `Arc<T>` 是给服务端
//!   在启动期建一次、跨请求复用的。
//! - **桌面专属命令**（`desktop_only`）也列进表里（漂移测试要对齐），但 `dispatch` 一律
//!   返回明确错误 —— 原生文件对话框、系统托盘、系统浏览器这类能力 headless 没有对应物。
//! - **binary 命令**返回原始字节（`CommandOutput::Binary`），服务端包成 HTTP body；
//!   桌面端包成 `tauri::ipc::Response`。
//! - 入参结构体散在**所属领域模块**（`git::RootArg` 等），与前端扁平入参 camelCase 对齐。

mod acp;
mod app;
mod channels;
mod db;
mod fs;
mod git;
mod llm;
mod markets;
mod office;
mod rag;
mod registry;
mod sys;

#[cfg(test)]
mod tests;

pub use registry::*;
