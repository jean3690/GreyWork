//! 本地 RAG：授权工作区文本 → 分块 → 本地 embedding（openai-compatible）→ SQLite 持久化 → 暴力余弦检索。
//!
//! 设计约束：
//! - 只索引授权根内的文件（复用 `WorkspaceFsAccess` 的授权面），不跟随符号链接。
//! - 向量以 float32 小端 BLOB 存 SQLite（见 `db::rag_*`），检索在内存缓存上暴力余弦 ——
//!   索引规模是「一个工作区」（文件数上限 2 万、单文件 1MB），远没到需要 ANN 的量级，
//!   因此不引新依赖。内存缓存首次检索时从库里懒加载，构建/清空后失效。
//! - embedding 走宿主 HTTP（`llm::llm_embed`），密钥只在宿主侧解析，绝不进渲染端。
//! - 构建按文件发 `rag://event` 进度；单个文件失败只跳过它，不中断整次构建。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::db::{Db, RagChunkDto, RagChunkRow};
use crate::host::HostContext;
use crate::llm::{self, EmbedArgs};
use crate::log;
use crate::workspace_fs::WorkspaceFsAccess;

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

/* ===== 命令入参 / 出参 ===== */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexBuildArgs {
    pub root: String,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub api_key_env: Option<String>,
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
    /// 强制全量重建（跳过 mtime 增量判断）。
    #[serde(default)]
    pub force: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchArgs {
    pub query: String,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub api_key_env: Option<String>,
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
    #[serde(default)]
    pub top_k: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexBuildResult {
    pub files: usize,
    pub chunks: usize,
    /// 本次因未变而跳过的文件数（增量命中）。
    pub skipped: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagStatus {
    pub chunks: i64,
    pub files: i64,
    pub model: Option<String>,
    pub dim: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagHit {
    pub path: String,
    pub chunk_index: i64,
    pub text: String,
    pub score: f32,
}

/* ===== 命令实现 ===== */

/// 构建（或增量更新）指定授权根的向量索引。
pub async fn rag_index_build(
    host: &dyn HostContext,
    workspace: &WorkspaceFsAccess,
    db: &Db,
    rag: &RagHost,
    args: IndexBuildArgs,
) -> Result<IndexBuildResult, String> {
    let root_path = workspace.resolve_existing(&args.root)?;
    if !root_path.is_dir() {
        return Err("索引根必须是目录".to_string());
    }
    if args.base_url.trim().is_empty() || args.model.trim().is_empty() {
        return Err("base_url and model are required".to_string());
    }
    let root = root_path.to_string_lossy().to_string();
    let model = args.model.trim().to_string();

    // embedding 模型换过 → 整库失效（不同模型的向量不可比），除非本来就空。
    let stored_model = db.rag_meta_get(META_MODEL)?;
    let model_changed = stored_model
        .as_deref()
        .is_some_and(|stored| stored != model);
    let force = args.force || model_changed;
    if force {
        db.rag_clear()?;
        rag.invalidate();
    }
    db.rag_meta_set(META_MODEL, &model)?;

    let files = collect_files(&root_path);
    let existing = if force {
        HashMap::new()
    } else {
        db.rag_file_stats(&root)?
    };
    let total = files.len();
    log::info(
        "rag",
        format!("index build root={root} files={total} force={force}"),
    );
    emit_progress(host, 0, total);

    let mut kept: Vec<String> = Vec::with_capacity(total);
    let mut chunk_count = 0usize;
    let mut skipped = 0usize;
    let mut dim = None;
    let mut done = 0usize;

    for file in files {
        let path = file.path.to_string_lossy().to_string();
        kept.push(path.clone());
        done += 1;

        let unchanged = !force
            && existing
                .get(&path)
                .is_some_and(|(mtime, size)| *mtime == file.mtime && *size == file.size as i64);
        if unchanged {
            skipped += 1;
            emit_progress(host, done, total);
            continue;
        }

        match index_one_file(db, &args, &model, &root, &file).await {
            Ok((chunks, file_dim)) => {
                chunk_count += chunks;
                if file_dim.is_some() {
                    dim = file_dim;
                }
            }
            Err(error) => {
                log::warn("rag", format!("跳过文件 {path}: {error}"));
                // 失败即视为未索引：清掉它的旧行，避免检索命中过期内容。
                let _ = db.rag_replace_file(&root, &path, 0, 0, &[]);
            }
        }
        emit_progress(host, done, total);
    }

    // 清理已删除 / 改名的文件（不在本次遍历集合里的路径）。
    let pruned = db.rag_prune_files(&root, &kept)?;
    if let Some(dim) = dim {
        db.rag_meta_set("rag.embedding.dim", &dim.to_string())?;
    }
    rag.invalidate();

    emit_json(
        host,
        serde_json::json!({
            "kind": "done",
            "files": total,
            "chunks": chunk_count,
            "skipped": skipped,
            "pruned": pruned,
        }),
    );
    Ok(IndexBuildResult {
        files: total,
        chunks: chunk_count,
        skipped,
    })
}

/// 读取 → 分块 → 取向量 → 落库（单文件）。
async fn index_one_file(
    db: &Db,
    args: &IndexBuildArgs,
    model: &str,
    root: &str,
    file: &FileEntry,
) -> Result<(usize, Option<i64>), String> {
    let bytes = std::fs::read(&file.path).map_err(|error| format!("读取失败: {error}"))?;
    let text = crate::text::decode_text_bytes(&bytes);
    let chunks = chunk_text(&text);
    let path = file.path.to_string_lossy().to_string();
    if chunks.is_empty() {
        db.rag_replace_file(root, &path, file.mtime, file.size as i64, &[])?;
        return Ok((0, None));
    }

    let mut rows = Vec::with_capacity(chunks.len());
    let mut dim = None;
    for (batch_index, batch) in chunks.chunks(EMBED_BATCH).enumerate() {
        let result = llm::llm_embed(EmbedArgs {
            base_url: args.base_url.clone(),
            model: model.to_string(),
            api_key_env: args.api_key_env.clone(),
            headers: args.headers.clone(),
            input: batch.to_vec(),
        })
        .await?;
        if result.embeddings.len() != batch.len() {
            return Err(format!(
                "embedding 返回数量与输入不符：{} vs {}",
                result.embeddings.len(),
                batch.len()
            ));
        }
        dim = Some(result.dim as i64);
        for (offset, (text, vec)) in batch.iter().zip(result.embeddings).enumerate() {
            rows.push(RagChunkDto {
                chunk_index: (batch_index * EMBED_BATCH + offset) as i64,
                text: text.clone(),
                vec,
            });
        }
    }
    let count = rows.len();
    db.rag_replace_file(root, &path, file.mtime, file.size as i64, &rows)?;
    Ok((count, dim))
}

/// 检索：把 query 取向量，与内存索引暴力余弦，返回 top-K。
pub async fn rag_search(db: &Db, rag: &RagHost, args: SearchArgs) -> Result<Vec<RagHit>, String> {
    let query = args.query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    if args.base_url.trim().is_empty() || args.model.trim().is_empty() {
        return Err("base_url and model are required".to_string());
    }
    let result = llm::llm_embed(EmbedArgs {
        base_url: args.base_url.trim().to_string(),
        model: args.model.trim().to_string(),
        api_key_env: args.api_key_env,
        headers: args.headers,
        input: vec![query.to_string()],
    })
    .await?;
    let Some(query_vec) = result.embeddings.into_iter().next() else {
        return Ok(Vec::new());
    };

    let index = rag.load(db)?;
    let top_k = args.top_k.unwrap_or(6).clamp(1, 50);
    let mut scored: Vec<RagHit> = index
        .iter()
        .map(|row| RagHit {
            path: row.path.clone(),
            chunk_index: row.chunk_index,
            text: row.text.clone(),
            score: cosine(&query_vec, &row.vec),
        })
        .collect();
    scored.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    scored.truncate(top_k);
    Ok(scored)
}

/// 索引状态（分块数 / 文件数 / 当前 embedding 模型）。
pub fn rag_status(db: &Db) -> Result<RagStatus, String> {
    let (chunks, files) = db.rag_stats()?;
    let model = db.rag_meta_get(META_MODEL)?;
    let dim = db
        .rag_meta_get("rag.embedding.dim")?
        .and_then(|value| value.parse::<i64>().ok());
    Ok(RagStatus {
        chunks,
        files,
        model,
        dim,
    })
}

/// 清空索引与内存缓存。
pub fn rag_clear(db: &Db, rag: &RagHost) -> Result<(), String> {
    db.rag_clear()?;
    rag.invalidate();
    Ok(())
}

/* ===== 遍历 / 分块 / 相似度（纯函数，便于单测） ===== */

/// 一个候选文件：路径 + 大小 + mtime（epoch 秒）。
struct FileEntry {
    path: PathBuf,
    size: u64,
    mtime: i64,
}

/// 递归收集根下可索引的文本文件（不跟随符号链接，忽略黑名单目录与二进制）。
fn collect_files(root: &Path) -> Vec<FileEntry> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    let mut dirs = 0usize;
    while let Some(dir) = stack.pop() {
        if dirs >= MAX_DIRS || out.len() >= MAX_FILES {
            break;
        }
        dirs += 1;
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            if out.len() >= MAX_FILES {
                break;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            // 不跟随符号链接：`file_type` 来自 read_dir 的 dirent，不触发跟随。
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            if file_type.is_dir() {
                if name.starts_with('.')
                    || IGNORE_DIRS
                        .iter()
                        .any(|ignored| ignored.eq_ignore_ascii_case(&name))
                {
                    continue;
                }
                stack.push(path);
                continue;
            }
            if !file_type.is_file() || !is_indexable_name(&name) {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if metadata.len() == 0 || metadata.len() > MAX_FILE_BYTES {
                continue;
            }
            // 二进制嗅探：首 1KB 出现 NUL 即按二进制跳过（扩展名白名单之外的双保险）。
            if let Ok(prefix) = crate::text::read_prefix(&path, 1024) {
                if crate::text::looks_binary(&prefix) {
                    continue;
                }
            }
            let mtime = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |duration| duration.as_secs() as i64);
            out.push(FileEntry {
                path,
                size: metadata.len(),
                mtime,
            });
        }
    }
    out
}

/// 文件名是否属于文本索引白名单（扩展名命中，或属无扩展名的已知文本文件）。
fn is_indexable_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if TEXT_FILENAMES.iter().any(|candidate| lower == *candidate) {
        return true;
    }
    match lower.rsplit_once('.') {
        Some((_, ext)) => TEXT_EXTENSIONS.contains(&ext),
        None => false,
    }
}

/// 按行聚合分块：每块目标 `CHUNK_CHARS` 字符，相邻块重叠 `CHUNK_OVERLAP` 字符。
fn chunk_text(text: &str) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    for line in text.lines() {
        let line_len = line.chars().count();
        if !current.is_empty() && current.chars().count() + line_len + 1 > CHUNK_CHARS {
            let finished = std::mem::take(&mut current);
            current = tail_chars(&finished, CHUNK_OVERLAP);
            chunks.push(finished);
        }
        current.push_str(line);
        current.push('\n');
    }
    if !current.trim().is_empty() {
        chunks.push(current);
    }
    chunks
}

/// 取字符串末尾 `n` 个字符（不足则不重叠，避免短块被整块重复）。
fn tail_chars(value: &str, n: usize) -> String {
    let count = value.chars().count();
    if count <= n {
        return String::new();
    }
    value.chars().skip(count - n).collect()
}

/// 余弦相似度；维度不符或零向量返回 0。
fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0f32;
    let mut norm_a = 0.0f32;
    let mut norm_b = 0.0f32;
    for index in 0..a.len() {
        dot += a[index] * b[index];
        norm_a += a[index] * a[index];
        norm_b += b[index] * b[index];
    }
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    dot / (norm_a.sqrt() * norm_b.sqrt())
}

/// 发一条 `rag://event`。
fn emit_json(host: &dyn HostContext, payload: serde_json::Value) {
    crate::host::emit_json(host, "rag://event", payload);
}

fn emit_progress(host: &dyn HostContext, done: usize, total: usize) {
    emit_json(
        host,
        serde_json::json!({ "kind": "progress", "done": done, "total": total }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_text_splits_long_text_with_overlap() {
        // 每行 40 字符 × 40 行 = 1600 字符 > CHUNK_CHARS，应切成多块。
        let line = "x".repeat(40);
        let text = (0..40).map(|_| line.clone()).collect::<Vec<_>>().join("\n");
        let chunks = chunk_text(&text);
        assert!(chunks.len() >= 2, "长文本应切成多块: {}", chunks.len());
        // 相邻块重叠：后一块开头 == 前一块末尾的重叠段。
        let lead: String = chunks[1].chars().take(CHUNK_OVERLAP).collect();
        assert!(!lead.is_empty());
        assert!(chunks[0].ends_with(&lead), "前一块应以第二块的开头结尾");
    }

    #[test]
    fn chunk_text_keeps_short_text_in_one_piece() {
        let chunks = chunk_text("hello\nworld\n");
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0], "hello\nworld\n");
        assert!(chunk_text("   \n\n").is_empty());
    }

    #[test]
    fn tail_chars_handles_short_and_multibyte() {
        assert_eq!(tail_chars("abc", 10), "");
        assert_eq!(tail_chars("abcdef", 2), "ef");
        // 按字符而非字节：中文不会被切坏
        assert_eq!(tail_chars("你好世界", 2), "世界");
    }

    #[test]
    fn cosine_matches_expected_values() {
        assert!((cosine(&[1.0, 0.0], &[1.0, 0.0]) - 1.0).abs() < 1e-6);
        assert!((cosine(&[1.0, 0.0], &[0.0, 1.0])).abs() < 1e-6);
        // 长度不等 / 零向量 → 0
        assert_eq!(cosine(&[1.0], &[1.0, 2.0]), 0.0);
        assert_eq!(cosine(&[0.0, 0.0], &[1.0, 1.0]), 0.0);
    }

    #[test]
    fn is_indexable_name_filters_extensions_and_known_files() {
        assert!(is_indexable_name("main.rs"));
        assert!(is_indexable_name("README.MD"));
        assert!(is_indexable_name("Dockerfile"));
        assert!(is_indexable_name("Makefile"));
        assert!(!is_indexable_name("photo.png"));
        assert!(!is_indexable_name("binary"));
    }

    #[test]
    fn collect_files_skips_ignored_dirs_and_binaries() {
        let tmp = std::env::temp_dir().join(format!("gw-rag-walk-{}", std::process::id()));
        let root = tmp.join("root");
        std::fs::create_dir_all(root.join("src")).expect("mkdir src");
        std::fs::create_dir_all(root.join("node_modules/pkg")).expect("mkdir nm");
        std::fs::write(root.join("src/main.rs"), "fn main() {}").expect("write rs");
        std::fs::write(root.join("node_modules/pkg/index.js"), "x").expect("write ignored");
        std::fs::write(root.join("logo.png"), [0x89, b'P', b'N', b'G', 0, 0]).expect("write png");

        let mut names: Vec<String> = collect_files(&root)
            .into_iter()
            .map(|file| {
                file.path
                    .strip_prefix(&root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect();
        names.sort();
        assert_eq!(names, vec!["src/main.rs"]);
    }

    #[test]
    fn rag_round_trip_persists_and_clears() {
        let db = Db::open_in_memory().expect("db");
        db.rag_replace_file(
            "/root",
            "/root/a.rs",
            10,
            20,
            &[
                RagChunkDto {
                    chunk_index: 0,
                    text: "第一块".into(),
                    vec: vec![1.0, 0.0],
                },
                RagChunkDto {
                    chunk_index: 1,
                    text: "第二块".into(),
                    vec: vec![0.0, 1.0],
                },
            ],
        )
        .expect("insert");
        let rows = db.rag_load_chunks(None).expect("load");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].vec, vec![1.0, 0.0]);
        let (chunks, files) = db.rag_stats().expect("stats");
        assert_eq!((chunks, files), (2, 1));

        // 整体替换：只剩新的一块
        db.rag_replace_file(
            "/root",
            "/root/a.rs",
            11,
            21,
            &[RagChunkDto {
                chunk_index: 0,
                text: "重写".into(),
                vec: vec![0.5, 0.5],
            }],
        )
        .expect("replace");
        assert_eq!(db.rag_load_chunks(None).expect("reload").len(), 1);

        // 统计 + 增量 mtime
        let stats = db.rag_file_stats("/root").expect("file stats");
        assert_eq!(stats.get("/root/a.rs"), Some(&(11, 21)));

        // 清理不在 keep 里的路径
        let pruned = db.rag_prune_files("/root", &[]).expect("prune");
        assert_eq!(pruned, 1);
        assert!(db.rag_load_chunks(None).expect("empty").is_empty());

        db.rag_meta_set(META_MODEL, "bge-m3").expect("meta");
        assert_eq!(
            db.rag_meta_get(META_MODEL).expect("get"),
            Some("bge-m3".into())
        );
        db.rag_clear().expect("clear");
        assert_eq!(db.rag_meta_get(META_MODEL).expect("get2"), None);
    }

    #[test]
    fn rag_status_reports_meta() {
        let db = Db::open_in_memory().expect("db");
        db.rag_meta_set(META_MODEL, "nomic-embed-text")
            .expect("meta");
        db.rag_meta_set("rag.embedding.dim", "768").expect("dim");
        let status = rag_status(&db).expect("status");
        assert_eq!(status.chunks, 0);
        assert_eq!(status.model.as_deref(), Some("nomic-embed-text"));
        assert_eq!(status.dim, Some(768));
    }

    #[tokio::test]
    async fn rag_search_ranks_by_cosine() {
        let db = Db::open_in_memory().expect("db");
        db.rag_replace_file(
            "/root",
            "/root/a.rs",
            1,
            1,
            &[
                RagChunkDto {
                    chunk_index: 0,
                    text: "near".into(),
                    vec: vec![1.0, 0.0],
                },
                RagChunkDto {
                    chunk_index: 1,
                    text: "far".into(),
                    vec: vec![0.0, 1.0],
                },
            ],
        )
        .expect("insert");

        // mock /v1/embeddings 返回与 "near" 同向的查询向量。
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = vec![0u8; 4096];
                    let _ = stream.read(&mut buf).await;
                    let body = r#"{"data":[{"embedding":[1,0]}]}"#;
                    let wire = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = stream.write_all(wire.as_bytes()).await;
                    let _ = stream.shutdown().await;
                });
            }
        });

        let rag = RagHost::default();
        let hits = rag_search(
            &db,
            &rag,
            SearchArgs {
                query: "query".into(),
                base_url: format!("http://{addr}/v1"),
                model: "m".into(),
                api_key_env: None,
                headers: None,
                top_k: Some(1),
            },
        )
        .await
        .expect("search");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].text, "near");
        assert!((hits[0].score - 1.0).abs() < 1e-6);
    }
}
