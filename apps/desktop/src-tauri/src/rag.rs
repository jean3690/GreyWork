//! 本地 RAG 命令的桌面薄包装；实现收在 `greywork_host::rag`（与 headless 服务端共用）。

use std::collections::HashMap;
use std::sync::Arc;

use greywork_host::db::Db;
use greywork_host::host::HostContext;
use greywork_host::rag::{
    IndexBuildArgs, IndexBuildResult, RagHit, RagHost, RagStatus, SearchArgs,
};
use greywork_host::workspace_fs::WorkspaceFsAccess;
use tauri::State;

/// 构建（或增量更新）授权工作区的向量索引；进度经 `rag://event` 广播。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn rag_index_build(
    host: State<'_, Arc<dyn HostContext>>,
    access: State<'_, WorkspaceFsAccess>,
    db: State<'_, Db>,
    rag: State<'_, RagHost>,
    root: String,
    base_url: String,
    model: String,
    api_key_env: Option<String>,
    headers: Option<HashMap<String, String>>,
    force: Option<bool>,
) -> Result<IndexBuildResult, String> {
    greywork_host::rag::rag_index_build(
        host.inner().as_ref(),
        &access,
        &db,
        &rag,
        IndexBuildArgs {
            root,
            base_url,
            model,
            api_key_env,
            headers,
            force: force.unwrap_or(false),
        },
    )
    .await
}

/// 语义检索：返回与 query 最相近的工作区分块。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn rag_search(
    db: State<'_, Db>,
    rag: State<'_, RagHost>,
    query: String,
    base_url: String,
    model: String,
    api_key_env: Option<String>,
    headers: Option<HashMap<String, String>>,
    top_k: Option<usize>,
) -> Result<Vec<RagHit>, String> {
    greywork_host::rag::rag_search(
        &db,
        &rag,
        SearchArgs {
            query,
            base_url,
            model,
            api_key_env,
            headers,
            top_k,
        },
    )
    .await
}

/// 索引状态（分块数 / 文件数 / embedding 模型）。
#[tauri::command]
pub async fn rag_status(db: State<'_, Db>) -> Result<RagStatus, String> {
    greywork_host::rag::rag_status(&db)
}

/// 清空索引与内存缓存。
#[tauri::command]
pub async fn rag_clear(db: State<'_, Db>, rag: State<'_, RagHost>) -> Result<(), String> {
    greywork_host::rag::rag_clear(&db, &rag)
}
