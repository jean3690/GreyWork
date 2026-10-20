//! 路径 / 目录解析与文件工具（含附件目录、活动会话、就绪标记）。

use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use crate::core::ports::WorkspaceFs;

use super::{ATTACHMENTS_SUB_DIR, GREY_WORK_DIR, SESSIONS_SUB_DIR};

const READY_MARKER: &str = ".ready";
const ACTIVE_FILE: &str = "active.json";

/// 校验并规范化用户自选工作区文件夹：必须存在、是目录、非根目录。
fn validate_folder(folder: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(folder);
    if !path.is_absolute() {
        return Err("工作区文件夹必须是绝对路径".into());
    }
    let meta = std::fs::metadata(&path).map_err(|e| format!("工作区文件夹不可访问: {e}"))?;
    if !meta.is_dir() {
        return Err("工作区文件夹不是目录".into());
    }
    // 统一走 path_safety：`parent().is_none()` 判不出 Windows 的 UNC 根
    // `\\server\share`（它的 parent 不是 None），会把它当普通目录放行。
    if crate::path_safety::is_filesystem_root(&path) {
        return Err("不允许把根目录作为工作区".into());
    }
    Ok(path)
}

pub(super) fn validate_authorized_folder(
    access: &dyn WorkspaceFs,
    folder: &str,
) -> Result<(), String> {
    let authorized = access.validate_existing(folder)?;
    if authorized.is_dir() {
        Ok(())
    } else {
        Err("工作区授权路径不是目录".into())
    }
}

pub(super) fn validate_authorized_workspaces(
    access: &dyn WorkspaceFs,
    workspaces: &[super::dto::WorkspaceDirDto],
) -> Result<(), String> {
    for workspace in workspaces {
        if let Some(folder) = workspace
            .folder
            .as_deref()
            .filter(|folder| !folder.is_empty())
        {
            validate_authorized_folder(access, folder)?;
        }
    }
    Ok(())
}

/// 默认数据根：`<home>/.greyWork`（目录不存在则创建）。
pub fn default_root(home: &Path) -> Result<PathBuf, String> {
    let root = home.join(GREY_WORK_DIR);
    std::fs::create_dir_all(&root).map_err(|e| format!("创建 ~/.greyWork 失败: {e}"))?;
    Ok(root)
}

/// 校验并拼出某会话的附件目录。
///
/// 只认纯 id（见 `path_safety::is_safe_session_id`），且固定拼在附件根之下 ——
/// 渲染端能调这个命令，就不能把任意路径的删除权交给它。
fn session_attachments_dir(root: &Path, session_id: &str) -> Result<PathBuf, String> {
    if !crate::path_safety::is_safe_session_id(session_id) {
        return Err(format!("非法会话 id: {session_id}"));
    }
    Ok(root.join(ATTACHMENTS_SUB_DIR).join(session_id))
}

/// 删除某会话的附件目录（`~/.greyWork/attachments/<会话id>/`）。
/// 幂等：目录不存在视为已删（会话从没发过附件是常态）。
pub fn prune_session_attachments(root: &Path, session_id: &str) -> Result<(), String> {
    let dir = session_attachments_dir(root, session_id)?;
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("删除附件目录失败: {error}")),
    }
}

/// 某文件夹（None = 默认根）的会话目录；目录确保存在。
pub(super) fn session_dir_for_folder(root: &Path, folder: Option<&str>) -> Result<PathBuf, String> {
    match folder {
        Some(folder) => {
            let folder = validate_folder(folder)?;
            let dir = folder.join(GREY_WORK_DIR).join(SESSIONS_SUB_DIR);
            std::fs::create_dir_all(&dir).map_err(|e| format!("创建工作区会话目录失败: {e}"))?;
            Ok(dir)
        }
        None => {
            let dir = root.join(SESSIONS_SUB_DIR);
            std::fs::create_dir_all(&dir).map_err(|e| format!("创建默认会话目录失败: {e}"))?;
            Ok(dir)
        }
    }
}

/// 某工作区（或无工作区）的会话目录；目录确保存在。
pub(super) fn session_dir_for(
    root: &Path,
    workspaces: &[super::dto::WorkspaceDirDto],
    workspace_id: Option<&str>,
) -> Result<PathBuf, String> {
    let bound = workspace_id.and_then(|id| workspaces.iter().find(|w| w.id == id));
    session_dir_for_folder(root, bound.and_then(|w| w.folder.as_deref()))
}

/// 快照涉及的全部会话目录（默认目录 + 各绑定工作区目录；去重、跳过失效目录）。
pub(super) fn all_session_dirs(
    root: &Path,
    workspaces: &[super::dto::WorkspaceDirDto],
) -> Result<Vec<PathBuf>, String> {
    let mut dirs = vec![session_dir_for_folder(root, None)?];
    for workspace in workspaces {
        if workspace.folder.is_none() {
            continue;
        }
        // 目录失效（被删/改名）：跳过，不阻塞整次操作
        if let Ok(dir) = session_dir_for(root, workspaces, Some(&workspace.id)) {
            // 归一化比较：folder 来自用户输入/历史记录，`C:\ws` 与 `c:/ws` 是同一目录，
            // 直接 `==` 会让它被算两次（同一批会话写两遍）。
            if !dirs
                .iter()
                .any(|seen| crate::path_safety::same_path(seen, &dir))
            {
                dirs.push(dir);
            }
        }
    }
    Ok(dirs)
}

/// 会话 id → 安全文件名（仅保留字母数字与 `-`/`_`，杜绝路径穿越）。
fn safe_file_name(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

pub(super) fn session_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{}.json", safe_file_name(id)))
}

/// 磁盘上某会话文件的 `updatedAt`；文件缺失/损坏 → None（按「无冲突」处理）。
pub(super) fn disk_updated_at(raw: &str) -> Option<i64> {
    serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .and_then(|value| value.get("updatedAt").and_then(|at| at.as_i64()))
}

pub(super) fn read_active(root: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(root.join(ACTIVE_FILE)).ok()?;
    serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|v| {
            v.get("activeSessionId")
                .and_then(|s| s.as_str())
                .map(String::from)
        })
}

pub(super) fn write_active(root: &Path, active: Option<&str>) -> Result<(), String> {
    let payload = serde_json::json!({ "activeSessionId": active });
    std::fs::write(root.join(ACTIVE_FILE), payload.to_string())
        .map_err(|e| format!("写入活动会话失败: {e}"))
}

pub(super) fn list_session_files(dir: &Path) -> Result<Vec<(String, PathBuf)>, String> {
    let mut out = Vec::new();
    let reader = std::fs::read_dir(dir).map_err(|e| format!("读取会话目录失败: {e}"))?;
    for entry in reader {
        let entry = entry.map_err(|e| format!("读取会话目录项失败: {e}"))?;
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".json") {
            out.push((name[..name.len() - 5].to_string(), entry.path()));
        }
    }
    Ok(out)
}

/// 文件是否已接管（.ready 存在 = 真源，即使会话为空）。
pub(super) fn is_ready(root: &Path) -> bool {
    root.join(READY_MARKER).exists()
}

/// 置就绪标记（空快照也代表「用户清空」，不复活种子）。
pub(super) fn mark_ready(root: &Path) -> Result<(), String> {
    std::fs::write(root.join(READY_MARKER), "1").map_err(|e| format!("写入就绪标记失败: {e}"))
}
