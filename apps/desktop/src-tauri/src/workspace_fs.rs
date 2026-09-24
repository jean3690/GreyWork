//! 工作区文件 IO 的桌面命令入口；授权面与 CRUD 实现收在 `greywork_host::workspace_fs`
//! （与 headless 服务端共用）。
//!
//! `WorkspaceFsAccess` 由本壳在 `setup` 里构造并 `manage`，因此这里既能拿到
//! `State`，也能把它转交给共享实现。

use std::path::PathBuf;
use tauri::State;

// 供 `crate::workspace_fs::WorkspaceFsAccess` 的既有引用继续解析（sys / acp_host / channel_media / lib）。
pub use greywork_host::workspace_fs::{DirEntryInfo, FileProbe, WorkspaceFsAccess};

/// 确保目录存在（产物默认目录等工作区相关落盘前置）。
#[tauri::command]
pub fn fs_ensure_dir(access: State<'_, WorkspaceFsAccess>, path: String) -> Result<(), String> {
    greywork_host::workspace_fs::fs_ensure_dir(&access, path)
}

/// 新建空文件（工作区文件树「新建文件」）。
#[tauri::command]
pub fn fs_create_file(access: State<'_, WorkspaceFsAccess>, path: String) -> Result<(), String> {
    greywork_host::workspace_fs::fs_create_file(&access, path)
}

/// 新建文件夹（工作区文件树「新建文件夹」）。
#[tauri::command]
pub fn fs_create_dir(access: State<'_, WorkspaceFsAccess>, path: String) -> Result<(), String> {
    greywork_host::workspace_fs::fs_create_dir(&access, path)
}

/// 改名 / 移动（工作区文件树「重命名 / 剪切后粘贴」）。
#[tauri::command]
pub fn fs_rename_path(
    access: State<'_, WorkspaceFsAccess>,
    from: String,
    to: String,
) -> Result<(), String> {
    greywork_host::workspace_fs::fs_rename_path(&access, from, to)
}

/// 复制（工作区文件树「复制后粘贴」，目录递归）。
#[tauri::command]
pub fn fs_copy_path(
    access: State<'_, WorkspaceFsAccess>,
    from: String,
    to: String,
) -> Result<(), String> {
    greywork_host::workspace_fs::fs_copy_path(&access, from, to)
}

/// 删除文件或文件夹（工作区文件树「删除」）。
#[tauri::command]
pub fn fs_delete_path(access: State<'_, WorkspaceFsAccess>, path: String) -> Result<(), String> {
    greywork_host::workspace_fs::fs_delete_path(&access, path)
}

/// 读取文本文件（10MB 上限），供工作区「打开文件」读取真实磁盘文件。
#[tauri::command]
pub fn fs_read_text_file(
    access: State<'_, WorkspaceFsAccess>,
    path: String,
) -> Result<String, String> {
    greywork_host::workspace_fs::fs_read_text_file(&access, path)
}

/// 读二进制文件（**原始字节**回传，≤20MB），供右栏预览真实磁盘上的 xlsx / pdf / 图片等。
///
/// 用 `tauri::ipc::Response` 而不是 base64 字符串：base64 把载荷撑大 33%，还要经 JSON
/// 转义、再由前端解码一遍 —— 每次打开预览都付这份开销。这里直接回字节，前端拿到 ArrayBuffer。
#[tauri::command]
pub fn fs_read_binary(
    access: State<'_, WorkspaceFsAccess>,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    greywork_host::workspace_fs::fs_read_binary(&access, path).map(tauri::ipc::Response::new)
}

/// 探测文件能否按文本预览 / 编辑（只读前 8KB，不把大文件整个读进来）。
#[tauri::command]
pub fn fs_probe_file(
    access: State<'_, WorkspaceFsAccess>,
    path: String,
) -> Result<FileProbe, String> {
    greywork_host::workspace_fs::fs_probe_file(&access, path)
}

/// 写回文本文件（单次 ≤10MB），供编辑器保存时同步到工作区存放文件夹。
#[tauri::command]
pub fn fs_write_text_file(
    access: State<'_, WorkspaceFsAccess>,
    path: String,
    content: String,
) -> Result<(), String> {
    greywork_host::workspace_fs::fs_write_text_file(&access, path, content)
}

/// 写二进制文件（base64 载荷，≤20MB），产物默认落盘通道。
#[tauri::command]
pub fn fs_write_binary(
    access: State<'_, WorkspaceFsAccess>,
    path: String,
    data_base64: String,
) -> Result<(), String> {
    greywork_host::workspace_fs::fs_write_binary(&access, path, data_base64)
}

/// 浅层列目录；指向授权根之外的符号链接不会暴露给渲染端。
#[tauri::command]
pub fn fs_list_dir(
    access: State<'_, WorkspaceFsAccess>,
    path: String,
) -> Result<Vec<DirEntryInfo>, String> {
    greywork_host::workspace_fs::fs_list_dir(&access, path)
}

/// 系统文件选择器。路径在返回渲染端前即写入宿主授权账本。
///
/// **留桌面**：依赖原生文件对话框，headless 服务端没有对应物（浏览器侧用 `<input type=file>`
/// 自行上传，不走这条命令）。
#[tauri::command]
pub async fn fs_pick_files(
    app: tauri::AppHandle,
    access: State<'_, WorkspaceFsAccess>,
    purpose: String,
    multiple: bool,
) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    // `media` 是对话附件通道：不限扩展名 —— 通用文件（PDF / 压缩包 / Office 文档）
    // 也要能选，类型判定与限额由渲染端 `lib/attachments.ts` 统一把关。
    if purpose != "media" && purpose != "workspace" {
        return Err(format!("未知文件选择用途: {purpose}"));
    }
    let dialog = app.dialog().file().set_title("选择文件");
    let selected = if multiple {
        let (tx, rx) = tokio::sync::oneshot::channel();
        dialog.pick_files(move |paths| {
            let _ = tx.send(paths.unwrap_or_default());
        });
        rx.await
            .map_err(|error| format!("文件选择对话框失败: {error}"))?
            .into_iter()
            .filter_map(|path| path.as_path().map(PathBuf::from))
            .collect::<Vec<_>>()
    } else {
        let (tx, rx) = tokio::sync::oneshot::channel();
        dialog.pick_file(move |path| {
            let _ = tx.send(path);
        });
        rx.await
            .map_err(|error| format!("文件选择对话框失败: {error}"))?
            .and_then(|path| path.as_path().map(PathBuf::from))
            .into_iter()
            .collect::<Vec<_>>()
    };
    access.authorize_selected_paths(&selected)
}
