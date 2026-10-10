//! 读 / 写 / 搬迁 / 迁移。

use std::io::ErrorKind;
use std::path::Path;

use crate::db::{ConversationDto, Db, SessionsSnapshotDto};

use super::dto::{
    ConflictDto, RelocateReportDto, RelocateRequestDto, SyncReportDto, WorkspaceDirDto,
};
use super::paths::{
    all_session_dirs, disk_updated_at, is_ready, list_session_files, mark_ready, read_active,
    session_dir_for, session_dir_for_folder, session_path, write_active,
};

/// 聚合读取全部会话文件（默认目录 + 各工作区目录）；未就绪 → None。
pub fn read_snapshot(
    root: &Path,
    workspaces: &[WorkspaceDirDto],
) -> Result<Option<SessionsSnapshotDto>, String> {
    if !is_ready(root) {
        return Ok(None);
    }
    let mut sessions = Vec::new();
    for dir in all_session_dirs(root, workspaces)? {
        for (id, path) in list_session_files(&dir)? {
            // BOM 容错：会话文件被编辑器存成「UTF-8 with BOM」时 from_str 会解析失败，
            // 表现是「整个会话突然读不出来」（见 text::read_bytes_without_bom）。
            let raw = crate::text::read_bytes_without_bom(&path)
                .map_err(|e| format!("读取会话 {id} 失败: {e}"))?;
            let session: ConversationDto =
                serde_json::from_slice(&raw).map_err(|e| format!("解析会话 {id} 失败: {e}"))?;
            sessions.push(session);
        }
    }
    sessions.sort_by_key(|session| std::cmp::Reverse(session.updated_at));
    Ok(Some(SessionsSnapshotDto {
        sessions,
        active_session_id: read_active(root),
    }))
}

/// 增量同步快照（文件面）：按归属写入各目录，只删调用方显式列出的会话。
///
/// 三类结果互斥：内容未变 → skipped；磁盘更新更晚 → conflicts（不写）；其余 → written。
pub fn write_snapshot(
    root: &Path,
    snapshot: &SessionsSnapshotDto,
    workspaces: &[WorkspaceDirDto],
    deleted: &[String],
) -> Result<SyncReportDto, String> {
    let mut report = SyncReportDto::default();
    for session in &snapshot.sessions {
        let dir = session_dir_for(root, workspaces, session.workspace_id.as_deref())?;
        let path = session_path(&dir, &session.id);
        let payload = serde_json::to_string(session).map_err(|e| format!("序列化会话失败: {e}"))?;
        match std::fs::read_to_string(&path) {
            Ok(existing) if existing == payload => {
                report.skipped += 1;
                continue;
            }
            Ok(existing) => {
                if let Some(disk_at) = disk_updated_at(&existing) {
                    if disk_at > session.updated_at {
                        report.conflicts.push(ConflictDto {
                            id: session.id.clone(),
                            disk_updated_at: disk_at,
                        });
                        continue;
                    }
                }
            }
            // 不存在 / 不可读（含损坏）→ 直接写
            Err(_) => {}
        }
        std::fs::write(&path, payload).map_err(|e| format!("写入会话文件失败: {e}"))?;
        report.written += 1;
    }

    if !deleted.is_empty() {
        for dir in all_session_dirs(root, workspaces)? {
            for id in deleted {
                let path = session_path(&dir, id);
                match std::fs::remove_file(&path) {
                    Ok(()) => report.deleted += 1,
                    Err(err) if err.kind() == ErrorKind::NotFound => {}
                    // 单个文件删不掉（Windows 上被编辑器/杀软占着）不该让整轮同步失败：
                    // 报错会让前端以为「什么都没写」，而降级成警告后其余删除照常完成。
                    Err(err) => crate::log::warn(
                        "store_fs",
                        format!("删除会话文件失败（已跳过）{}: {err}", path.display()),
                    ),
                }
            }
        }
    }

    write_active(root, snapshot.active_session_id.as_deref())?;
    // 就绪标记：空快照也代表「用户清空」，不复活种子
    mark_ready(root)?;
    Ok(report)
}

/// 把给定会话的文件从旧文件夹搬到新文件夹（工作区改绑目录时调用）。
///
/// 目标已有**更新**版本时两边都保留并记入 conflicts —— 宁可留下一份重复，也不能
/// 静默盖掉另一实例/另一次会话里更晚的内容。
pub fn relocate_sessions(
    root: &Path,
    request: &RelocateRequestDto,
) -> Result<RelocateReportDto, String> {
    let from = session_dir_for_folder(root, request.from_folder.as_deref())?;
    let to = session_dir_for_folder(root, request.to_folder.as_deref())?;
    let mut report = RelocateReportDto::default();
    // 归一化比较：同一目录的不同写法（大小写/分隔符）不该被当成一次搬迁，
    // 否则会把文件在同一个目录里「搬」成自己。
    if crate::path_safety::same_path(&from, &to) {
        return Ok(report);
    }
    for id in &request.session_ids {
        let source = session_path(&from, id);
        let payload = match std::fs::read_to_string(&source) {
            Ok(raw) => raw,
            Err(_) => {
                report.missing.push(id.clone());
                continue;
            }
        };
        let target = session_path(&to, id);
        if let Ok(existing) = std::fs::read_to_string(&target) {
            let newer = match (disk_updated_at(&existing), disk_updated_at(&payload)) {
                (Some(target_at), Some(source_at)) => target_at > source_at,
                // 目标存在但无法判定新旧：保守视为冲突，不动任何一边
                _ => true,
            };
            if newer {
                report.conflicts.push(id.clone());
                continue;
            }
        }
        // 同分区走 rename（原子且省一次拷贝）；跨设备回落读写 + 删源
        if std::fs::rename(&source, &target).is_err() {
            std::fs::write(&target, &payload).map_err(|e| format!("搬迁会话 {id} 失败: {e}"))?;
            // 目标已写好，源文件删不掉只是留一份冗余 —— 不该把这次搬迁判为失败
            if let Err(error) = std::fs::remove_file(&source) {
                crate::log::warn(
                    "store_fs",
                    format!("清理旧会话文件失败（已保留）{id}: {error}"),
                );
            }
        }
        report.moved += 1;
    }
    Ok(report)
}

/// 迁移入口：SQLite 会话面已接管而文件面未就绪 → 导出一次并置就绪。
pub fn migrate_from_db(
    root: &Path,
    db: &Db,
    workspaces: &[WorkspaceDirDto],
) -> Result<Option<SessionsSnapshotDto>, String> {
    if is_ready(root) {
        return Ok(None);
    }
    match db
        .load_snapshot()
        .map_err(|e| format!("读取旧库失败: {e}"))?
    {
        Some(legacy) => {
            write_snapshot(root, &legacy, workspaces, &[])?;
            Ok(Some(legacy))
        }
        None => Ok(None),
    }
}
