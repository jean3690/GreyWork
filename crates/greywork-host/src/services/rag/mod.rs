//! 本地 RAG：授权工作区文本 → 分块 → 本地 embedding（openai-compatible）→ SQLite 持久化 → 暴力余弦检索。
//!
//! 设计约束：
//! - 只索引授权根内的文件（复用 `WorkspaceFsAccess` 的授权面），不跟随符号链接。
//! - 向量以 float32 小端 BLOB 存 SQLite（见 `db::rag_*`），检索在内存缓存上暴力余弦 ——
//!   索引规模是「一个工作区」（文件数上限 2 万、单文件 1MB），远没到需要 ANN 的量级，
//!   因此不引新依赖。内存缓存首次检索时从库里懒加载，构建/清空后失效。
//! - embedding 走 [`crate::core::ports::Embedder`] 端口（默认实现 `llm::LlmEmbedder` 打宿主 HTTP），
//!   密钥只在宿主侧解析，绝不进渲染端。
//! - 构建按文件发 `rag://event` 进度；单个文件失败只跳过它，不中断整次构建。

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;

use crate::core::ports::WorkspaceFs;
use crate::core::ports::{EmbedArgs, Embedder};
use crate::db::{Db, RagChunkDto, RagChunkRow};
use crate::host::HostContext;
use crate::log;

/// 单文件参与索引的上限：生成物 / 日志 / 打包产物不进索引。
const MAX_FILE_BYTES: u64 = 1024 * 1024;
/// 单块目标字符数（按行聚合，避免把一行代码从中间切断）与相邻块的重叠字符数。
const CHUNK_CHARS: usize = 1200;
const CHUNK_OVERLAP: usize = 200;
/// 一次 embedding 请求的批大小：本地服务也要避免单请求体过大。
const EMBED_BATCH: usize = 32;
/// 递归遍历上限：目录数与文件数，防一个畸形目录树把一次构建拖死。
const MAX_DIRS: usize = 4096;
const MAX_FILES: usize = 20_000;
/// 只索引这些扩展名的文件（白名单比「靠 NUL 嗅探」可靠：JPEG 首 KB 未必有 NUL）。
const TEXT_EXTENSIONS: &[&str] = &[
    "txt",
    "md",
    "markdown",
    "rst",
    "adoc",
    "log",
    "csv",
    "tsv",
    "json",
    "jsonl",
    "yaml",
    "yml",
    "toml",
    "ini",
    "cfg",
    "conf",
    "env",
    "properties",
    "xml",
    "html",
    "htm",
    "css",
    "scss",
    "sass",
    "less",
    "js",
    "jsx",
    "mjs",
    "cjs",
    "ts",
    "tsx",
    "mts",
    "cts",
    "vue",
    "svelte",
    "astro",
    "py",
    "pyi",
    "rb",
    "php",
    "go",
    "rs",
    "java",
    "kt",
    "kts",
    "scala",
    "c",
    "h",
    "cc",
    "cpp",
    "hpp",
    "cs",
    "swift",
    "m",
    "mm",
    "sh",
    "bash",
    "zsh",
    "fish",
    "ps1",
    "bat",
    "cmd",
    "sql",
    "graphql",
    "gql",
    "proto",
    "lua",
    "r",
    "dart",
    "ex",
    "exs",
    "erl",
    "clj",
    "cljs",
    "hs",
    "ml",
    "tf",
    "tfvars",
    "gradle",
    "dockerfile",
    "makefile",
    "cmake",
    "gitignore",
    "editorconfig",
    "lock",
];
/// 目录名黑名单（按路径段匹配）：构建产物与依赖目录，遍历时整棵跳过。
const IGNORE_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    ".nuxt",
    "vendor",
    "coverage",
    ".git",
    ".idea",
    ".vscode",
    ".gradle",
    ".cache",
    ".pnpm-store",
];
/// 无扩展名但仍应按文本索引的文件名（Dockerfile / Makefile 这类）。
const TEXT_FILENAMES: &[&str] = &[
    "dockerfile",
    "makefile",
    "cmakelists.txt",
    "procfile",
    "license",
    "readme",
];

const META_MODEL: &str = "rag.embedding.model";

/* ===== 宿主状态 ===== */

/// RAG 宿主状态：内存索引缓存。
///
/// `None` = 尚未从库里加载。检索时懒加载成 `Arc<Vec<…>>`（一次拷贝，多次查询共享），
/// 构建 / 清空后置回 `None`，下一次检索自动重载。
#[derive(Default)]
pub struct RagHost {
    cache: Mutex<Option<Arc<Vec<RagChunkRow>>>>,
}

impl RagHost {
    /// 让缓存失效（构建 / 清空后调用）。
    pub fn invalidate(&self) {
        *self.cache.lock() = None;
    }

    /// 取内存索引（必要时从库里加载）。
    fn load(&self, db: &Db) -> Result<Arc<Vec<RagChunkRow>>, String> {
        {
            let guard = self.cache.lock();
            if let Some(cached) = guard.as_ref() {
                return Ok(Arc::clone(cached));
            }
        }
        let rows = Arc::new(db.rag_load_chunks(None)?);
        *self.cache.lock() = Some(Arc::clone(&rows));
        Ok(rows)
    }
}

mod dto;
mod index;
mod search;
mod status;
mod walk;

#[cfg(test)]
mod tests;

pub use dto::*;
pub use index::*;
pub use search::*;
pub use status::*;
