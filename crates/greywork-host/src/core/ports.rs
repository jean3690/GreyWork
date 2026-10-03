//! 跨层端口 trait：模块间依赖这些接口，而非具体实现。
//!
//! 原则（遵循 `host` 的告诫）：**窄、按职责拆**，不做上帝 trait。每个 trait 只在
//! 「≥2 消费方」或「需要测试替身」处引入。具体实现留在各自层（如
//! `WorkspaceFsAccess` 实现 [`WorkspaceFs`] / [`WorkspaceAuthorizer`]）。

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;

use serde::{Deserialize, Serialize};

/// 工作区文件系统的**授权读取面**。
///
/// 消费方（`git` / `worktree` / `rag` / `sheet` / `store_fs` / `channel_media` / `llm`
/// 等）只依赖本 trait，不再依赖具体实现 `WorkspaceFsAccess`。
///
/// 注意：破坏性写操作（`resolve_write` / `resolve_entry`）刻意**不入 trait** —— 它们只由
/// 工作区自身的 CRUD 命令消费，暴露出去只会扩大可绕过授权面的入口。
pub trait WorkspaceFs: Send + Sync {
    /// 解析**已存在**的授权路径为规范绝对路径（`canonicalize` + 授权校验）。
    fn resolve_existing(&self, raw: &str) -> Result<PathBuf, String>;

    /// 与 [`WorkspaceFs::resolve_existing`] 同义（历史命名，保留给 `store_fs` 等调用方）。
    fn validate_existing(&self, raw: &str) -> Result<PathBuf, String>;

    /// 该路径是否是某个已授权的工作区根。
    fn is_authorized_root(&self, path: &Path) -> bool;

    /// 已授权根的只读快照。
    fn authorized_roots(&self) -> Vec<PathBuf>;
}

/// 工作区**授权写入面**：把用户动作（系统选择器 / OS 拖放）产生的路径纳入授权集合。
///
/// 只由宿主壳（桌面 / 服务端）在收到用户动作时调用；普通 IPC 命令不得自行扩大授权面。
pub trait WorkspaceAuthorizer: Send + Sync {
    /// 授权单个（已存在的）文件或目录。
    fn authorize_selected_path(&self, path: &Path) -> Result<PathBuf, String>;

    /// 授权一批「系统文件选择器」选中的普通文件，返回剥离 `\\?\` 前缀的路径。
    fn authorize_selected_paths(&self, selected: &[PathBuf]) -> Result<Vec<String>, String>;

    /// 授权一批「OS 拖放」的文件（目录被忽略）。
    fn authorize_drop_paths(&self, dropped: &[PathBuf]) -> Result<(), String>;
}

/// 文本向量化请求（本地 OpenAI 兼容 `/embeddings`）。
///
/// 放在端口层而非 `llm` 模块：它是 [`Embedder`] 端口的请求形状，消费方（RAG）不应
/// 为拿到参数类型而依赖具体传输实现。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedArgs {
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub api_key_env: Option<String>,
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
    pub input: Vec<String>,
}

/// 向量结果：`dim` 冗余回传，便于调用方校验模型是否换过。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedResult {
    pub embeddings: Vec<Vec<f32>>,
    pub dim: usize,
    pub model: String,
}

/// 文本向量化端口。
///
/// RAG 只依赖本 trait，不依赖 `llm` 模块；测试可注入假实现，无需真起 HTTP。
/// async 方法手写 `Pin<Box<dyn Future>>` 以保持 dyn 兼容（不引 `async-trait`）。
pub trait Embedder: Send + Sync {
    fn embed<'a>(
        &'a self,
        args: EmbedArgs,
    ) -> Pin<Box<dyn Future<Output = Result<EmbedResult, String>> + Send + 'a>>;
}
