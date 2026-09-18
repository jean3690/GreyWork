//! 会话文件存储（P0 数据面 v3）。
//!
//! 目标布局（用户确认）：
//! - 默认（无工作区）：`~/.greyWork/sessions/<会话id>.json`
//! - 绑定工作区：`<工作区文件夹>/.greyWork/sessions/<会话id>.json`
//! - 活动会话：`~/.greyWork/active.json`；就绪标记：`~/.greyWork/.ready`
//!
//! 语义与旧 SQLite 会话面 1:1 对齐：
//! - `read` 在未就绪时返回 None → 前端以本地缓存/种子为真源并回写（避免清空后复活种子）；
//! - 迁移：SQLite 已接管（meta.initialized）而文件面未就绪时，把库快照一次性导出成文件。
//!
//! sync 为**增量**替换（v3.1，多实例安全）：
//! - 内容逐字节相同 → 跳过写（不刷 mtime，省掉整目录重写）；
//! - 磁盘 `updatedAt` 严格更新 → 判为冲突，**不覆盖**，回报给前端由它按条合并；
//! - 删除只按调用方显式给出的 `deletedSessionIds` 执行 —— 不再扫目录把「不在快照里的
//!   文件」当垃圾清掉，否则两个实例同时开着时，A 的全量同步会删掉 B 刚建的会话。
//! - 所有命令在 `~/.greyWork/.lock` 上互斥（目录锁 + 陈旧接管），保证跨进程串行。
//!
//! 消息负载不透明（ThreadMessage 全文 JSON 往返，零解析）。

use crate::db::{ConversationDto, Db, SessionsSnapshotDto};
use serde::{Deserialize, Serialize};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const GREY_WORK_DIR: &str = ".greyWork";
pub const SESSIONS_SUB_DIR: &str = "sessions";
/// 会话附件目录（渲染端 `state/attachment-library.ts` 按同一布局写入）。
pub const ATTACHMENTS_SUB_DIR: &str = "attachments";
const READY_MARKER: &str = ".ready";
const ACTIVE_FILE: &str = "active.json";

/* ===== 跨进程存储锁 ===== */

const LOCK_DIR: &str = ".lock";
const LOCK_OWNER_FILE: &str = "owner.json";
/// 超过该时长仍未释放的锁判为陈旧（持有进程崩溃/被 kill），可强行接管。
const LOCK_STALE_MS: u128 = 30_000;
const LOCK_RETRY_DELAY: Duration = Duration::from_millis(25);
const LOCK_RETRY_LIMIT: u32 = 40;

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 会话存储的跨进程互斥锁。
///
/// 以「创建目录」作为原子的加锁动作（`create_dir` 在已存在时失败，POSIX 与 Windows
/// 皆然），目录内的 `owner.json` 只用于陈旧判定，不参与互斥本身 —— 因此不存在
/// 「先建目录再写 owner，中间被别人抢走」的窗口。RAII：Drop 即释放，panic 也能回收。
struct StoreLock {
    dir: PathBuf,
}

impl StoreLock {
    fn acquire(root: &Path) -> Result<Self, String> {
        let dir = root.join(LOCK_DIR);
        for _ in 0..LOCK_RETRY_LIMIT {
            match std::fs::create_dir(&dir) {
                Ok(()) => {
                    let owner =
                        serde_json::json!({ "pid": std::process::id(), "at": now_ms() as u64 });
                    // owner 写失败不致命（只影响陈旧判定精度），锁本身已经拿到
                    let _ = std::fs::write(dir.join(LOCK_OWNER_FILE), owner.to_string());
                    return Ok(Self { dir });
                }
                Err(err) if err.kind() == ErrorKind::AlreadyExists => {
                    if Self::is_stale(&dir) {
                        let _ = std::fs::remove_dir_all(&dir);
                        continue;
                    }
                    std::thread::sleep(LOCK_RETRY_DELAY);
                }
                Err(err) => return Err(format!("获取会话存储锁失败: {err}")),
            }
        }
        Err("会话存储锁被其它实例长期占用，本次同步放弃".into())
    }

    /// 锁是否陈旧：优先看 `owner.json` 的取锁时刻；文件尚未写出（持有者刚建目录）
    /// 或已损坏时退回目录 mtime，避免把刚拿到锁的对手误判为死锁。
    fn is_stale(dir: &Path) -> bool {
        if let Some(at) = std::fs::read_to_string(dir.join(LOCK_OWNER_FILE))
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .and_then(|value| value.get("at").and_then(|at| at.as_u64()))
        {
            return now_ms().saturating_sub(u128::from(at)) > LOCK_STALE_MS;
        }
        std::fs::metadata(dir)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|at| at.elapsed().ok())
            .map(|age| age.as_millis() > LOCK_STALE_MS)
            .unwrap_or(false)
    }
}

impl Drop for StoreLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/* ===== DTO ===== */

/// 前端工作区目录清单（会话归属 → 磁盘文件夹）。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDirDto {
    pub id: String,
    /// 用户选择的文件夹（绝对路径；None/空 = 未绑定 → 默认目录）。
    pub folder: Option<String>,
}

/// 一条被拒绝覆盖的会话：磁盘版本比内存版本新（另一实例写过）。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConflictDto {
    pub id: String,
    pub disk_updated_at: i64,
}

/// 增量同步结果：前端据此判断是否需要回读合并。
#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncReportDto {
    pub written: usize,
    pub skipped: usize,
    pub deleted: usize,
    pub conflicts: Vec<ConflictDto>,
}

/// 会话搬迁请求：工作区改绑文件夹时把既有会话文件挪到新目录。
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RelocateRequestDto {
    pub session_ids: Vec<String>,
    /// 原文件夹（None = 默认根 `~/.greyWork`）。
    pub from_folder: Option<String>,
    /// 目标文件夹（None = 默认根）。
    pub to_folder: Option<String>,
}

/// 搬迁结果：moved 实际搬走的条数，missing 源侧本就没有文件的 id，
/// conflicts 目标侧已有更新版本、两边都保留的 id。
#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelocateReportDto {
    pub moved: usize,
    pub missing: Vec<String>,
    pub conflicts: Vec<String>,
}

/* ===== 路径与文件工具 ===== */

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

fn validate_authorized_folder(
    access: &crate::workspace_fs::WorkspaceFsAccess,
    folder: &str,
) -> Result<(), String> {
    let authorized = access.validate_existing(folder)?;
    if authorized.is_dir() {
        Ok(())
    } else {
        Err("工作区授权路径不是目录".into())
    }
}

fn validate_authorized_workspaces(
    access: &crate::workspace_fs::WorkspaceFsAccess,
    workspaces: &[WorkspaceDirDto],
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
fn session_dir_for_folder(root: &Path, folder: Option<&str>) -> Result<PathBuf, String> {
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
fn session_dir_for(
    root: &Path,
    workspaces: &[WorkspaceDirDto],
    workspace_id: Option<&str>,
) -> Result<PathBuf, String> {
    let bound = workspace_id.and_then(|id| workspaces.iter().find(|w| w.id == id));
    session_dir_for_folder(root, bound.and_then(|w| w.folder.as_deref()))
}

/// 快照涉及的全部会话目录（默认目录 + 各绑定工作区目录；去重、跳过失效目录）。
fn all_session_dirs(root: &Path, workspaces: &[WorkspaceDirDto]) -> Result<Vec<PathBuf>, String> {
    let mut dirs = vec![session_dir_for_folder(root, None)?];
    for workspace in workspaces {
        if workspace.folder.is_none() {
            continue;
        }
        // 目录失效（被删/改名）：跳过，不阻塞整次操作
        if let Ok(dir) = session_dir_for(root, workspaces, Some(&workspace.id)) {
            if !dirs.iter().any(|seen| seen == &dir) {
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

fn session_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{}.json", safe_file_name(id)))
}

/// 磁盘上某会话文件的 `updatedAt`；文件缺失/损坏 → None（按「无冲突」处理）。
fn disk_updated_at(raw: &str) -> Option<i64> {
    serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .and_then(|value| value.get("updatedAt").and_then(|at| at.as_i64()))
}

fn read_active(root: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(root.join(ACTIVE_FILE)).ok()?;
    serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|v| {
            v.get("activeSessionId")
                .and_then(|s| s.as_str())
                .map(String::from)
        })
}

fn write_active(root: &Path, active: Option<&str>) -> Result<(), String> {
    let payload = serde_json::json!({ "activeSessionId": active });
    std::fs::write(root.join(ACTIVE_FILE), payload.to_string())
        .map_err(|e| format!("写入活动会话失败: {e}"))
}

fn list_session_files(dir: &Path) -> Result<Vec<(String, PathBuf)>, String> {
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
fn is_ready(root: &Path) -> bool {
    root.join(READY_MARKER).exists()
}

/* ===== 读 / 写 / 搬迁 ===== */

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
            let raw =
                std::fs::read_to_string(&path).map_err(|e| format!("读取会话 {id} 失败: {e}"))?;
            let session: ConversationDto =
                serde_json::from_str(&raw).map_err(|e| format!("解析会话 {id} 失败: {e}"))?;
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
                    Err(err) => return Err(format!("删除会话文件失败: {err}")),
                }
            }
        }
    }

    write_active(root, snapshot.active_session_id.as_deref())?;
    // 就绪标记：空快照也代表「用户清空」，不复活种子
    std::fs::write(root.join(READY_MARKER), "1").map_err(|e| format!("写入就绪标记失败: {e}"))?;
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
    if from == to {
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
            std::fs::remove_file(&source).map_err(|e| format!("清理旧会话文件 {id} 失败: {e}"))?;
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

/* ===== Tauri 命令 ===== */

fn app_home(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    app.path()
        .home_dir()
        .map_err(|e| format!("解析用户目录失败: {e}"))
}

/// 读全量会话快照（文件面；未就绪 → null）。含 SQLite → 文件一次性迁移。
#[tauri::command]
pub fn store_sessions_load(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
    access: tauri::State<'_, crate::workspace_fs::WorkspaceFsAccess>,
    workspaces: Vec<WorkspaceDirDto>,
) -> Result<Option<SessionsSnapshotDto>, String> {
    validate_authorized_workspaces(&access, &workspaces)?;
    let root = default_root(&app_home(&app)?)?;
    let _lock = StoreLock::acquire(&root)?;
    if let Some(migrated) = migrate_from_db(&root, &db, &workspaces)? {
        return Ok(Some(migrated));
    }
    read_snapshot(&root, &workspaces)
}

/// 增量同步会话快照（调用方为渲染端 debounce 持久层）。
///
/// `deleted_session_ids` 是本次要落实的删除清单：只删它，绝不扫目录清扫，
/// 否则多实例并发时会互删对方新建的会话。
#[tauri::command]
pub fn store_sessions_sync(
    app: tauri::AppHandle,
    access: tauri::State<'_, crate::workspace_fs::WorkspaceFsAccess>,
    snapshot: SessionsSnapshotDto,
    workspaces: Vec<WorkspaceDirDto>,
    deleted_session_ids: Vec<String>,
) -> Result<SyncReportDto, String> {
    validate_authorized_workspaces(&access, &workspaces)?;
    let root = default_root(&app_home(&app)?)?;
    let _lock = StoreLock::acquire(&root)?;
    write_snapshot(&root, &snapshot, &workspaces, &deleted_session_ids)
}

/// 工作区改绑文件夹后把既有会话文件搬到新目录。
#[tauri::command]
pub fn store_sessions_relocate(
    app: tauri::AppHandle,
    access: tauri::State<'_, crate::workspace_fs::WorkspaceFsAccess>,
    request: RelocateRequestDto,
) -> Result<RelocateReportDto, String> {
    if let Some(folder) = request
        .from_folder
        .as_deref()
        .filter(|folder| !folder.is_empty())
    {
        validate_authorized_folder(&access, folder)?;
    }
    if let Some(folder) = request
        .to_folder
        .as_deref()
        .filter(|folder| !folder.is_empty())
    {
        validate_authorized_folder(&access, folder)?;
    }
    let root = default_root(&app_home(&app)?)?;
    let _lock = StoreLock::acquire(&root)?;
    relocate_sessions(&root, &request)
}

/// 默认数据根（`~/.greyWork`）——前端产物默认落盘目录基准。
#[tauri::command]
pub fn store_default_root(app: tauri::AppHandle) -> Result<String, String> {
    default_root(&app_home(&app)?).map(|root| root.to_string_lossy().into_owned())
}

/// 删除某会话的附件目录（会话被删除时调用）：只删 `<root>/attachments/<会话id>`，
/// 其余路径一律拒绝，且目录不存在时按已删处理。
#[tauri::command]
pub fn attachments_prune_session(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    let root = default_root(&app_home(&app)?)?;
    prune_session_attachments(&root, &session_id)
}

/// 系统文件夹选择器：让用户自定义工作区文件夹（桌面端目录对话框）。
#[tauri::command]
pub async fn pick_workspace_folder(
    app: tauri::AppHandle,
    access: tauri::State<'_, crate::workspace_fs::WorkspaceFsAccess>,
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
            access
                .authorize_selected_path(&path)
                .map(|path| path.to_string_lossy().into_owned())
        })
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use serde_json::json;

    fn dir(id: &str, folder: Option<&str>) -> WorkspaceDirDto {
        WorkspaceDirDto {
            id: id.into(),
            folder: folder.map(String::from),
        }
    }

    fn conversation(
        id: &str,
        title: &str,
        workspace_id: Option<&str>,
        n: usize,
    ) -> ConversationDto {
        ConversationDto {
            id: id.into(),
            title: title.into(),
            workspace_id: workspace_id.map(String::from),
            created_at: n as i64,
            updated_at: n as i64,
            messages: (0..n)
                .map(|i| json!({ "id": format!("m{i}"), "content": format!("msg {i}") }))
                .collect(),
        }
    }

    /// 每个用例独占一个临时 home，避免同一进程内并行用例互相踩锁与文件。
    fn temp_home(tag: &str) -> PathBuf {
        let home = std::env::temp_dir().join(format!("gw-store-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        home
    }

    #[test]
    fn unready_returns_none_and_sync_takes_over() {
        let tmp = temp_home("ready");
        let root = default_root(&tmp).unwrap();
        assert_eq!(root, tmp.join(".greyWork"));

        // 未就绪 → None（前端种子回写语义）
        assert!(read_snapshot(&root, &[]).unwrap().is_none());

        let snapshot = SessionsSnapshotDto {
            sessions: vec![conversation("ses-a", "A", None, 2)],
            active_session_id: Some("ses-a".into()),
        };
        let report = write_snapshot(&root, &snapshot, &[], &[]).unwrap();
        assert_eq!(report.written, 1);
        let loaded = read_snapshot(&root, &[])
            .unwrap()
            .expect("接管后应返回真源");
        assert_eq!(loaded.sessions.len(), 1);
        assert_eq!(loaded.sessions[0].messages.len(), 2);
        assert_eq!(loaded.active_session_id.as_deref(), Some("ses-a"));

        // 空快照 = 用户清空（不复活）；文件本身要靠显式删除清单才消失
        write_snapshot(
            &root,
            &SessionsSnapshotDto::default(),
            &[],
            &["ses-a".into()],
        )
        .unwrap();
        let loaded = read_snapshot(&root, &[]).unwrap().expect("接管后空真源");
        assert!(loaded.sessions.is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn workspace_bound_sessions_land_in_workspace_dir() {
        let tmp = temp_home("ws");
        let root = default_root(&tmp).unwrap();
        let ws_folder = tmp.join("my-project");
        std::fs::create_dir_all(&ws_folder).unwrap();

        let workspaces = vec![dir("w-1", Some(&ws_folder.to_string_lossy()))];
        let snapshot = SessionsSnapshotDto {
            sessions: vec![
                conversation("ses-ws", "工作区会话", Some("w-1"), 1),
                conversation("ses-free", "自由会话", None, 1),
            ],
            active_session_id: None,
        };
        write_snapshot(&root, &snapshot, &workspaces, &[]).unwrap();

        // 工作区文件落在 <folder>/.greyWork/sessions/
        assert!(ws_folder.join(".greyWork/sessions/ses-ws.json").exists());
        // 默认目录是 ~/.greyWork/sessions/
        assert!(root.join("sessions/ses-free.json").exists());

        let loaded = read_snapshot(&root, &workspaces).unwrap().unwrap();
        assert_eq!(loaded.sessions.len(), 2);

        // 工作区失效（目录被删）→ 不阻塞加载，其余照常
        std::fs::remove_dir_all(&ws_folder).unwrap();
        let loaded = read_snapshot(&root, &workspaces).unwrap().unwrap();
        assert_eq!(loaded.sessions.len(), 1);
        assert_eq!(loaded.sessions[0].id, "ses-free");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn unchanged_sessions_are_skipped_without_touching_files() {
        let tmp = temp_home("incr");
        let root = default_root(&tmp).unwrap();
        let snapshot = SessionsSnapshotDto {
            sessions: vec![
                conversation("ses-a", "A", None, 1),
                conversation("ses-b", "B", None, 2),
            ],
            active_session_id: None,
        };
        let first = write_snapshot(&root, &snapshot, &[], &[]).unwrap();
        assert_eq!((first.written, first.skipped), (2, 0));

        let path = root.join("sessions/ses-a.json");
        let before = std::fs::metadata(&path).unwrap().modified().unwrap();
        let second = write_snapshot(&root, &snapshot, &[], &[]).unwrap();
        assert_eq!(
            (second.written, second.skipped),
            (0, 2),
            "内容未变应全部跳过"
        );
        assert_eq!(
            std::fs::metadata(&path).unwrap().modified().unwrap(),
            before,
            "跳过的文件不该被重写"
        );

        // 内容有变 → 重新写入
        let mut bumped = snapshot.clone();
        bumped.sessions[0].title = "A2".into();
        bumped.sessions[0].updated_at = 99;
        let third = write_snapshot(&root, &bumped, &[], &[]).unwrap();
        assert_eq!((third.written, third.skipped), (1, 1));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn newer_disk_version_is_reported_as_conflict_and_kept() {
        let tmp = temp_home("conflict");
        let root = default_root(&tmp).unwrap();
        let mut fresh = conversation("ses-a", "磁盘版", None, 1);
        fresh.updated_at = 5_000;
        write_snapshot(
            &root,
            &SessionsSnapshotDto {
                sessions: vec![fresh],
                active_session_id: None,
            },
            &[],
            &[],
        )
        .unwrap();

        // 内存里是更旧的版本（另一实例已写过更新内容）
        let mut stale = conversation("ses-a", "内存旧版", None, 1);
        stale.updated_at = 1_000;
        let report = write_snapshot(
            &root,
            &SessionsSnapshotDto {
                sessions: vec![stale],
                active_session_id: None,
            },
            &[],
            &[],
        )
        .unwrap();
        assert_eq!(report.written, 0);
        assert_eq!(
            report.conflicts,
            vec![ConflictDto {
                id: "ses-a".into(),
                disk_updated_at: 5_000
            }]
        );
        let loaded = read_snapshot(&root, &[]).unwrap().unwrap();
        assert_eq!(loaded.sessions[0].title, "磁盘版", "冲突时磁盘版本不被覆盖");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn only_explicit_deletions_remove_files() {
        let tmp = temp_home("delete");
        let root = default_root(&tmp).unwrap();
        let snapshot = SessionsSnapshotDto {
            sessions: vec![
                conversation("ses-old", "旧", None, 1),
                conversation("ses-keep", "留", None, 1),
            ],
            active_session_id: None,
        };
        write_snapshot(&root, &snapshot, &[], &[]).unwrap();

        // 另一实例刚建的会话文件（本实例快照里没有）
        let foreign = root.join("sessions/ses-foreign.json");
        std::fs::write(
            &foreign,
            serde_json::to_string(&conversation("ses-foreign", "别的实例", None, 1)).unwrap(),
        )
        .unwrap();

        let pruned = SessionsSnapshotDto {
            sessions: vec![conversation("ses-keep", "留", None, 1)],
            active_session_id: None,
        };
        let report = write_snapshot(&root, &pruned, &[], &["ses-old".into()]).unwrap();
        assert_eq!(report.deleted, 1);
        assert!(!root.join("sessions/ses-old.json").exists());
        assert!(root.join("sessions/ses-keep.json").exists());
        assert!(foreign.exists(), "陌生会话文件不该被清扫掉");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn relocate_moves_sessions_into_workspace_dir() {
        let tmp = temp_home("relocate");
        let root = default_root(&tmp).unwrap();
        let folder = tmp.join("proj");
        std::fs::create_dir_all(&folder).unwrap();
        let snapshot = SessionsSnapshotDto {
            sessions: vec![
                conversation("ses-a", "A", None, 1),
                conversation("ses-b", "B", None, 1),
            ],
            active_session_id: None,
        };
        write_snapshot(&root, &snapshot, &[], &[]).unwrap();

        let request = RelocateRequestDto {
            session_ids: vec!["ses-a".into(), "ses-b".into(), "ses-missing".into()],
            from_folder: None,
            to_folder: Some(folder.to_string_lossy().into_owned()),
        };
        let report = relocate_sessions(&root, &request).unwrap();
        assert_eq!(report.moved, 2);
        assert_eq!(report.missing, vec!["ses-missing".to_string()]);
        assert!(report.conflicts.is_empty());
        assert!(!root.join("sessions/ses-a.json").exists(), "源文件应被搬走");
        let moved = folder.join(".greyWork/sessions/ses-a.json");
        assert!(moved.exists());
        let payload: ConversationDto =
            serde_json::from_str(&std::fs::read_to_string(&moved).unwrap()).unwrap();
        assert_eq!(payload.title, "A");

        // 同目录搬迁 = no-op
        let same = relocate_sessions(
            &root,
            &RelocateRequestDto {
                session_ids: vec!["ses-a".into()],
                from_folder: None,
                to_folder: None,
            },
        )
        .unwrap();
        assert_eq!(same, RelocateReportDto::default());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn relocate_keeps_both_sides_on_conflict() {
        let tmp = temp_home("relocate-conflict");
        let root = default_root(&tmp).unwrap();
        let folder = tmp.join("proj");
        let target_dir = folder.join(".greyWork/sessions");
        std::fs::create_dir_all(&target_dir).unwrap();

        let mut source = conversation("ses-a", "源旧版", None, 1);
        source.updated_at = 1_000;
        write_snapshot(
            &root,
            &SessionsSnapshotDto {
                sessions: vec![source],
                active_session_id: None,
            },
            &[],
            &[],
        )
        .unwrap();
        let mut target = conversation("ses-a", "目标新版", None, 1);
        target.updated_at = 9_000;
        std::fs::write(
            target_dir.join("ses-a.json"),
            serde_json::to_string(&target).unwrap(),
        )
        .unwrap();

        let report = relocate_sessions(
            &root,
            &RelocateRequestDto {
                session_ids: vec!["ses-a".into()],
                from_folder: None,
                to_folder: Some(folder.to_string_lossy().into_owned()),
            },
        )
        .unwrap();
        assert_eq!(report.moved, 0);
        assert_eq!(report.conflicts, vec!["ses-a".to_string()]);
        assert!(
            root.join("sessions/ses-a.json").exists(),
            "冲突时源文件保留"
        );
        let kept: ConversationDto =
            serde_json::from_str(&std::fs::read_to_string(target_dir.join("ses-a.json")).unwrap())
                .unwrap();
        assert_eq!(kept.title, "目标新版");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn lock_is_exclusive_and_reclaims_stale_holder() {
        let tmp = temp_home("lock");
        let root = default_root(&tmp).unwrap();

        // 持有期间：目录锁存在；释放后消失
        {
            let _guard = StoreLock::acquire(&root).unwrap();
            assert!(root.join(LOCK_DIR).exists());
            assert!(
                std::fs::create_dir(root.join(LOCK_DIR)).is_err(),
                "锁目录应互斥"
            );
        }
        assert!(!root.join(LOCK_DIR).exists(), "Drop 应释放锁");

        // 陈旧锁（owner 时间戳远超阈值）→ 可强行接管
        let lock_dir = root.join(LOCK_DIR);
        std::fs::create_dir(&lock_dir).unwrap();
        let stale_at = now_ms().saturating_sub(LOCK_STALE_MS * 3) as u64;
        std::fs::write(
            lock_dir.join(LOCK_OWNER_FILE),
            serde_json::json!({ "pid": 1, "at": stale_at }).to_string(),
        )
        .unwrap();
        let guard = StoreLock::acquire(&root).expect("陈旧锁应被接管");
        drop(guard);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn migrate_exports_legacy_db_once() {
        let tmp = temp_home("mig");
        let root = default_root(&tmp).unwrap();

        // 旧库：真实 SQLite 文件（Db::open_at），已接管且有两会话
        let db_path = tmp.join("greywork.db");
        let db = Db::open_at(&db_path).unwrap();
        let legacy = SessionsSnapshotDto {
            sessions: vec![conversation("legacy-1", "旧会话", None, 3)],
            active_session_id: Some("legacy-1".into()),
        };
        db.sync_snapshot(&legacy).unwrap();

        // 文件面未就绪 → 迁移并返回旧快照；再次 load 走文件面（幂等）
        let loaded = migrate_from_db(&root, &db, &[])
            .unwrap()
            .expect("迁移应返回数据");
        assert_eq!(loaded.sessions[0].id, "legacy-1");
        assert!(root.join("sessions/legacy-1.json").exists());
        assert!(root.join(".ready").exists());
        assert!(migrate_from_db(&root, &db, &[]).unwrap().is_none());

        // 清空旧库后文件面仍是真源（不回退）
        db.sync_snapshot(&SessionsSnapshotDto::default()).unwrap();
        let loaded = read_snapshot(&root, &[]).unwrap().unwrap();
        assert_eq!(loaded.sessions.len(), 1);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn prune_session_attachments_removes_only_that_session() {
        let tmp = temp_home("att");
        let root = default_root(&tmp).unwrap();
        let target = root.join("attachments/ses-a");
        let other = root.join("attachments/ses-b");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(target.join("att-1.png"), b"x").unwrap();

        prune_session_attachments(&root, "ses-a").unwrap();
        assert!(!target.exists());
        assert!(other.exists(), "别的会话的附件不能被带上");
        // 幂等：目录已不在（或从没发过附件）不算失败
        prune_session_attachments(&root, "ses-a").unwrap();
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn prune_session_attachments_rejects_traversal_ids() {
        let tmp = temp_home("att-bad");
        let root = default_root(&tmp).unwrap();
        let victim = tmp.join("victim");
        std::fs::create_dir_all(&victim).unwrap();

        for id in [
            "",
            "..",
            "../victim",
            "a/b",
            "a\\b",
            ".hidden",
            // Windows 盘符相对路径：`join` 会整段替换基准目录
            "C:evil",
            "c:",
            // Win32 保留设备名与结尾点（会被静默剥掉而与 `CON` 撞名）
            "CON",
            "con.txt",
            "foo.",
        ] {
            assert!(
                prune_session_attachments(&root, id).is_err(),
                "id {id:?} 应被拒绝"
            );
        }
        assert!(victim.exists(), "越界 id 不能删到附件根之外");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
