//! 会话文件存储的桌面命令入口；实现收在 `greywork_host::store_fs`（与 headless 服务端共用）。
//!
//! 家目录由启动期注册的 `Arc<dyn HostContext>`（`lib.rs` 的 `TauriHost`）提供。

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, State};

use greywork_host::db::{Db, SessionsSnapshotDto};
use greywork_host::host::HostContext;
use greywork_host::workspace_fs::WorkspaceFsAccess;

pub use greywork_host::store_fs::{
    default_root, RelocateReportDto, RelocateRequestDto, SyncReportDto, WorkspaceDirDto,
};

/// 读全量会话快照（文件面；未就绪 → null）。含 SQLite → 文件一次性迁移。
#[tauri::command]
pub fn store_sessions_load(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    db: State<'_, Db>,
    access: State<'_, WorkspaceFsAccess>,
    workspaces: Vec<WorkspaceDirDto>,
) -> Result<Option<SessionsSnapshotDto>, String> {
    greywork_host::store_fs::store_sessions_load(
        host_ctx.inner().as_ref(),
        &db,
        &*access,
        workspaces,
    )
}

/// 增量同步会话快照（调用方为渲染端 debounce 持久层）。
#[tauri::command]
pub fn store_sessions_sync(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    access: State<'_, WorkspaceFsAccess>,
    snapshot: SessionsSnapshotDto,
    workspaces: Vec<WorkspaceDirDto>,
    deleted_session_ids: Vec<String>,
) -> Result<SyncReportDto, String> {
    greywork_host::store_fs::store_sessions_sync(
        host_ctx.inner().as_ref(),
        &*access,
        snapshot,
        workspaces,
        deleted_session_ids,
    )
}

/// 工作区改绑文件夹后把既有会话文件搬到新目录。
#[tauri::command]
pub fn store_sessions_relocate(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    access: State<'_, WorkspaceFsAccess>,
    request: RelocateRequestDto,
) -> Result<RelocateReportDto, String> {
    greywork_host::store_fs::store_sessions_relocate(host_ctx.inner().as_ref(), &*access, request)
}

/// 默认数据根（`~/.greyWork`）——前端产物默认落盘目录基准。
#[tauri::command]
pub fn store_default_root(host_ctx: State<'_, Arc<dyn HostContext>>) -> Result<String, String> {
    greywork_host::store_fs::store_default_root(host_ctx.inner().as_ref())
}

/// 删除某会话的附件目录（会话被删除时调用）：只删 `<root>/attachments/<会话id>`，
/// 其余路径一律拒绝，且目录不存在时按已删处理。
#[tauri::command]
pub fn attachments_prune_session(
    host_ctx: State<'_, Arc<dyn HostContext>>,
    session_id: String,
) -> Result<(), String> {
    greywork_host::store_fs::attachments_prune_session(host_ctx.inner().as_ref(), session_id)
}

/// 系统文件夹选择器：让用户自定义工作区文件夹（桌面端目录对话框）。
///
/// **留桌面**：依赖原生目录对话框，headless 服务端没有对应物。
#[tauri::command]
pub async fn pick_workspace_folder(
    app: AppHandle,
    access: State<'_, WorkspaceFsAccess>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<PathBuf>>();
    app.dialog()
        .file()
        .set_title("选择工作区文件夹")
        .pick_folder(move |file_path| {
            let _ = tx.send(file_path.and_then(|path| path.as_path().map(PathBuf::from)));
        });
    let selected = rx
        .await
        .map_err(|error| format!("目录选择对话框失败: {error}"))?;
    selected
        .map(|path| {
            access.authorize_selected_path(&path).map(|path| {
                // 剥掉 `\\?\`：这个值会被存进工作区记录并在历史列表里显示，
                // 也会被前端当绝对路径判定。
                greywork_host::path_safety::strip_verbatim_prefix(&path.to_string_lossy())
            })
        })
        .transpose()
}
