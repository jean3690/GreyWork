use std::collections::HashMap;

use serde::{Deserialize, Serialize};

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
