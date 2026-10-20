//! 本地 RAG：授权工作区文本 → 分块 → 本地 embedding（openai-compatible）→ SQLite 持久化 → 暴力余弦检索。
//!
//! 设计约束：
//! - 只索引授权根内的文件（复用 `WorkspaceFsAccess` 的授权面），不跟随符号链接。
//! - 向量以 float32 小端 BLOB 存 SQLite（见 `db::rag_*`），检索在内存缓存上暴力余弦 ——
//!   索引规模是「一个工作区」（文件数上限 2 万、单文件 1MB），远没到需要 ANN 的量级，
//!   因此不引新依赖。内存缓存首次检索时从库里懒加载，构建/清空后失效。
//! - 懒加载时把向量 **L2 归一化并按行主序拼进一块连续 arena**（见 [`RagIndex`]）：
//!   检索退化成单位向量点积——省掉每行重算的分母，扫描顺序且可被自动向量化。
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
/// `None` = 尚未从库里加载。检索时懒加载成 `Arc<RagIndex>`（构建一次，多次查询共享），
/// 构建 / 清空后置回 `None`，下一次检索自动重载。
#[derive(Default)]
pub struct RagHost {
    cache: Mutex<Option<Arc<RagIndex>>>,
}

impl RagHost {
    /// 让缓存失效（构建 / 清空后调用）。
    pub fn invalidate(&self) {
        *self.cache.lock() = None;
    }

    /// 取内存索引（必要时从库里加载并构建 arena）。
    fn load(&self, db: &Db) -> Result<Arc<RagIndex>, String> {
        {
            let guard = self.cache.lock();
            if let Some(cached) = guard.as_ref() {
                return Ok(Arc::clone(cached));
            }
        }
        let index = Arc::new(RagIndex::build(db.rag_load_chunks(None)?));
        *self.cache.lock() = Some(Arc::clone(&index));
        Ok(index)
    }
}

/// 内存检索索引：懒加载时一次性构建，之后只读。
///
/// **归一化 + SoA**：构建时把每个向量 L2 归一化成单位向量，并按行主序拼进**一块连续
/// arena**。检索因此退化成「单位向量点积」，且扫描是顺序的——相比逐行 `Vec<f32>`
/// （每行一次堆分配、跨行跳读），少一次浮点累加、少几十万次指针追逐，也让乘加能被
/// 自动向量化。归一化在这里做**一次**，而不是每次查询对每个 chunk 重算分母。
///
/// 维度不齐的行（换过 embedding 模型却没整库重建）**不进 arena**：此时 `arena` 为
/// `None`，全部行保留原始向量，检索退回 [`search::cosine`] 逐行路径——与引入 arena
/// 之前完全一致（维度不符 / 零范数 → 0 分）。
struct RagIndex {
    /// 行元数据（path / chunk_index / text）。进 arena 的行其 `vec` 已被抽空，
    /// 数据归 arena 持有，不留第二份内存。
    rows: Vec<RagChunkRow>,
    /// 全库维度一致时的连续向量存储。
    arena: Option<Arena>,
}

/// 同维度的单位向量 arena：`unit.len() == dim * rows.len()`，行主序。
struct Arena {
    dim: usize,
    unit: Vec<f32>,
}

impl RagIndex {
    /// 从库行构建：维度一致就归一化 + 拼 arena，否则原样保留（退化路径）。
    fn build(mut rows: Vec<RagChunkRow>) -> Self {
        let dim = rows.first().map(|row| row.vec.len()).unwrap_or(0);
        // dim == 0 同样不走 arena：零维向量没有可归一化的内容，留给退化路径。
        let uniform = dim > 0 && rows.iter().all(|row| row.vec.len() == dim);
        if !uniform {
            return Self { rows, arena: None };
        }
        let mut unit = Vec::with_capacity(dim * rows.len());
        for row in &mut rows {
            // 抽空原向量：数据搬进 arena 后原分配即可释放，构建完只剩一份。
            let vec = std::mem::take(&mut row.vec);
            let norm = vec.iter().map(|v| v * v).sum::<f32>().sqrt();
            if norm > 0.0 {
                unit.extend(vec.iter().map(|v| v / norm));
            } else {
                // 零向量归一化仍是零向量：点积恒为 0，与 `cosine` 的零范数分支同义。
                unit.resize(unit.len() + dim, 0.0);
            }
        }
        Self {
            rows,
            arena: Some(Arena { dim, unit }),
        }
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
