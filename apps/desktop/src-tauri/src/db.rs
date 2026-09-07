//! 数据面：SQLite 会话存储（P0）。
//!
//! 设计约束（对齐「IPC 大 content 修正」）：
//! - 正文真库归位：ThreadMessage 全文以 JSON payload 存入 messages 表；
//!   渲染端不再是会话数据的唯一真源，localStorage 仅作首帧缓存。
//! - 单进程单写者：`std::sync::Mutex<Connection>`，command 为同步 fn（本地
//!   微秒级事务，不进 tokio）。
//! - 迁移链：`PRAGMA user_version` 顺序推进，新列/新表只追加迁移不回头改。
//! - 快照形状与前端 `PersistedSessions`（v2）1:1：会话行拆列存储，消息不透明
//!   （前端 ThreadMessage 类型演进不需要后端同步迁移）。
//! - `meta.initialized` 标记区分「空库（未接管）」与「真源（零会话）」：
//!   前端仅在未接管时用本地种子/缓存填充并回写，避免清空会话后重启又冒种子。

use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// 单条会话的快照视图（camelCase 对齐前端 SessionRecord 字段）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationDto {
    pub id: String,
    pub title: String,
    pub workspace_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    /// ThreadMessage 全文（不透明 JSON：steps/tools/thinking 等字段原样往返）。
    pub messages: Vec<serde_json::Value>,
}

/// 全量快照（sync / load 共用形状）。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionsSnapshotDto {
    pub sessions: Vec<ConversationDto>,
    pub active_session_id: Option<String>,
}

/// 编排运行存档行：PlannerRun 全文不透明（subtasks 等字段原样往返），
/// id 拆列便于删除与去重（id 亦在 payload 内，sync 时校验一致性）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunDto {
    pub id: String,
    pub payload: serde_json::Value,
}

/// ACP 后端目录项（与前端 AgentProviderConfig 对齐；enabled 由宿主持久化，
/// 前端只做首次 seed——目录真源归 Rust，渲染端不再硬编码启停）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentProviderDto {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub command: String,
    pub enabled: bool,
}

/// 自动化任务行（与前端 AutomationTask 对齐；cron 空 = 手动触发，永不自动到期）。
/// running 为运行期瞬时态，不落库（load 后前端统一置 false）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationTaskDto {
    pub id: String,
    pub name: String,
    /// 人类可读触发描述（如「每天 09:00」）。
    pub schedule: String,
    /// 标准 cron 5 段表达式（分 时 日 月 周）；None = 手动触发。
    pub cron: Option<String>,
    pub target: String,
    pub intent: String,
    pub enabled: bool,
    /// 最近一次运行时间戳（epoch ms；0 = 从未）。
    pub last_run: i64,
}

/// 到期执行队列行（宿主 push 的 pending 快照；渲染端消费后 finish）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationDueDto {
    pub id: i64,
    pub task_id: String,
    pub name: String,
    pub target: String,
    pub intent: String,
    pub due_at: i64,
}

/// 到期队列保留窗口：pending 超 60min 无人消费即 sweep（等价旧「busy 跳过」语义，
/// 但 busy/重启不再丢——窗口内渲染端恢复即补跑）。
const PENDING_DUE_WINDOW_MS: i64 = 3_600_000;
/// 全状态行最长保留：超 24h 清理，防表膨胀。
const DUE_KEEP_MS: i64 = 86_400_000;

/// 全局数据库状态（setup 阶段打开，经 Tauri manage 注入）。
pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    /// 打开（或创建）数据目录下的库文件并推进迁移链。
    pub fn open_at(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建数据目录失败: {e}"))?;
        }
        let conn = Connection::open(path).map_err(|e| format!("打开数据库失败: {e}"))?;
        Self::with_connection(conn)
    }

    /// 内存库（测试用）：WAL 对 memory 库退化为 memory 模式，不报错。
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self, String> {
        Self::with_connection(
            Connection::open_in_memory().map_err(|e| format!("打开内存库失败: {e}"))?,
        )
    }

    fn with_connection(mut conn: Connection) -> Result<Self, String> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 2000;",
        )
        .map_err(|e| format!("初始化数据库 PRAGMA 失败: {e}"))?;
        migrate(&mut conn).map_err(|e| format!("迁移数据库失败: {e}"))?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// 读全量快照；库尚未被 sync 接管（无 initialized 标记）时返回 None。
    pub fn load_snapshot(&self) -> Result<Option<SessionsSnapshotDto>, String> {
        let conn = self.conn.lock();
        let initialized: Option<String> = conn
            .query_row(
                "SELECT value FROM meta WHERE key = 'initialized'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("读取初始化标记失败: {e}"))?;
        if initialized.is_none() {
            return Ok(None);
        }
        let active_session_id = conn
            .query_row(
                "SELECT value FROM meta WHERE key = 'active_session_id'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("读取活动会话失败: {e}"))?;

        let mut stmt = conn
            .prepare("SELECT id, title, workspace_id, created_at, updated_at FROM conversations ORDER BY updated_at DESC")
            .map_err(|e| format!("准备会话查询失败: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(ConversationDto {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    workspace_id: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                    messages: Vec::new(),
                })
            })
            .map_err(|e| format!("查询会话失败: {e}"))?;

        let mut sessions = Vec::new();
        for row in rows {
            let mut conversation = row.map_err(|e| format!("读取会话行失败: {e}"))?;
            conversation.messages = load_messages(&conn, &conversation.id)?;
            sessions.push(conversation);
        }
        drop(stmt);
        Ok(Some(SessionsSnapshotDto {
            sessions,
            active_session_id,
        }))
    }

    /// 全量替换快照（事务）：库中不在快照里的会话连同消息删除；
    /// 在场会话先清消息再整批重插（消息不透明，无法行级 diff）。
    /// 首次调用写入 initialized 标记，此后空快照 = 用户清空，不再回退种子。
    /// 生产只读旧库（load_snapshot 供文件面迁移）；写侧仅测试模拟旧库用。
    #[cfg(test)]
    pub fn sync_snapshot(&self, snapshot: &SessionsSnapshotDto) -> Result<(), String> {
        let mut conn = self.conn.lock();
        let tx = conn
            .transaction()
            .map_err(|e| format!("开启事务失败: {e}"))?;

        // 1) 标记接管（幂等）
        tx.execute(
            "INSERT INTO meta (key, value) VALUES ('initialized', '1') ON CONFLICT(key) DO NOTHING",
            [],
        )
        .map_err(|e| format!("写入初始化标记失败: {e}"))?;

        // 2) 活动会话落 meta（None → 删 key）
        match &snapshot.active_session_id {
            Some(id) => {
                tx.execute(
                    "INSERT INTO meta (key, value) VALUES ('active_session_id', ?1)
                     ON CONFLICT(key) DO UPDATE SET value = ?1",
                    params![id],
                )
                .map_err(|e| format!("写入活动会话失败: {e}"))?;
            }
            None => {
                tx.execute("DELETE FROM meta WHERE key = 'active_session_id'", [])
                    .map_err(|e| format!("清除活动会话失败: {e}"))?;
            }
        }

        // 3) 删除不在快照里的会话（messages 经外键级联清理）
        {
            let mut stmt = tx
                .prepare("SELECT id FROM conversations")
                .map_err(|e| format!("准备会话枚举失败: {e}"))?;
            let existing: Vec<String> = stmt
                .query_map([], |row| row.get(0))
                .map_err(|e| format!("枚举会话失败: {e}"))?
                .collect::<Result<_, _>>()
                .map_err(|e| format!("读取会话 id 失败: {e}"))?;
            drop(stmt);
            let kept: std::collections::HashSet<&str> =
                snapshot.sessions.iter().map(|s| s.id.as_str()).collect();
            for id in existing.iter().filter(|id| !kept.contains(id.as_str())) {
                tx.execute("DELETE FROM conversations WHERE id = ?1", params![id])
                    .map_err(|e| format!("删除会话失败: {e}"))?;
            }
        }

        // 4) upsert 会话 + 重建消息
        for conversation in &snapshot.sessions {
            tx.execute(
                "INSERT INTO conversations (id, title, workspace_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(id) DO UPDATE SET
                   title = ?2, workspace_id = ?3, created_at = ?4, updated_at = ?5",
                params![
                    conversation.id,
                    conversation.title,
                    conversation.workspace_id,
                    conversation.created_at,
                    conversation.updated_at
                ],
            )
            .map_err(|e| format!("写入会话失败: {e}"))?;

            tx.execute(
                "DELETE FROM messages WHERE conversation_id = ?1",
                params![conversation.id],
            )
            .map_err(|e| format!("清理旧消息失败: {e}"))?;
            let mut insert = tx
                .prepare("INSERT INTO messages (id, conversation_id, payload) VALUES (?1, ?2, ?3)")
                .map_err(|e| format!("准备消息写入失败: {e}"))?;
            for message in &conversation.messages {
                let id = message
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| "消息缺少字符串 id 字段".to_string())?;
                insert
                    .execute(params![id, conversation.id, message.to_string()])
                    .map_err(|e| format!("写入消息失败: {e}"))?;
            }
            drop(insert);
        }

        tx.commit().map_err(|e| format!("提交事务失败: {e}"))?;
        Ok(())
    }

    /// 读设置快照（meta.settings）；从未持久化过 → None（前端以本地值回填）。
    pub fn load_settings(&self) -> Result<Option<serde_json::Value>, String> {
        let conn = self.conn.lock();
        let raw: Option<String> = conn
            .query_row("SELECT value FROM meta WHERE key = 'settings'", [], |row| {
                row.get(0)
            })
            .optional()
            .map_err(|e| format!("读取设置失败: {e}"))?;
        match raw {
            Some(payload) => serde_json::from_str(&payload)
                .map(Some)
                .map_err(|e| format!("解析设置 JSON 失败: {e}")),
            None => Ok(None),
        }
    }

    /// 全量替换设置快照（设置对象整体读写；无接管标记语义——空对象也合法）。
    pub fn sync_settings(&self, settings: &serde_json::Value) -> Result<(), String> {
        let conn = self.conn.lock();
        let payload = settings.to_string();
        conn.execute(
            "INSERT INTO meta (key, value) VALUES ('settings', ?1)
             ON CONFLICT(key) DO UPDATE SET value = ?1",
            params![payload],
        )
        .map_err(|e| format!("写入设置失败: {e}"))?;
        Ok(())
    }

    /// schema 版本（PRAGMA user_version）——系统诊断面。
    pub fn schema_version(&self) -> Result<i64, String> {
        let conn = self.conn.lock();
        conn.query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|e| format!("读取 schema 版本失败: {e}"))
    }

    /// 读自动化任务清单；从未 sync 接管（无 automation_initialized 标记）→ None。
    /// 与 sessions 的 initialized 语义一致：用户清空全部任务后重启不得复活种子。
    pub fn load_automations(&self) -> Result<Option<Vec<AutomationTaskDto>>, String> {
        let conn = self.conn.lock();
        let initialized: Option<String> = conn
            .query_row(
                "SELECT value FROM meta WHERE key = 'automation_initialized'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("读取自动化接管标记失败: {e}"))?;
        if initialized.is_none() {
            return Ok(None);
        }
        let mut stmt = conn
            .prepare(
                "SELECT id, name, schedule, cron, target, intent, enabled, last_run
                 FROM automation_tasks ORDER BY rowid",
            )
            .map_err(|e| format!("准备自动化查询失败: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(AutomationTaskDto {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    schedule: row.get(2)?,
                    cron: row.get(3)?,
                    target: row.get(4)?,
                    intent: row.get(5)?,
                    enabled: row.get::<_, i64>(6)? != 0,
                    last_run: row.get(7)?,
                })
            })
            .map_err(|e| format!("查询自动化失败: {e}"))?;
        let mut tasks = Vec::new();
        for row in rows {
            tasks.push(row.map_err(|e| format!("读取自动化行失败: {e}"))?);
        }
        Ok(Some(tasks))
    }

    /// 读编排运行存档；从未 sync 接管 → None（前端以本地/空存档回填）。
    pub fn load_team_runs(&self) -> Result<Option<Vec<TeamRunDto>>, String> {
        let conn = self.conn.lock();
        let initialized: Option<String> = conn
            .query_row(
                "SELECT value FROM meta WHERE key = 'team_runs_initialized'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("读取编排存档标记失败: {e}"))?;
        if initialized.is_none() {
            return Ok(None);
        }
        let mut stmt = conn
            .prepare("SELECT id, payload FROM team_runs ORDER BY rowid")
            .map_err(|e| format!("准备存档查询失败: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(TeamRunDto {
                    id: row.get(0)?,
                    payload: serde_json::from_str(&row.get::<_, String>(1)?).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            1,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?,
                })
            })
            .map_err(|e| format!("查询存档失败: {e}"))?;
        let mut runs = Vec::new();
        for row in rows {
            runs.push(row.map_err(|e| format!("读取存档行失败: {e}"))?);
        }
        Ok(Some(runs))
    }

    /// 全量替换编排存档（事务；库中不在快照的运行删除）。首次调用写接管标记。
    pub fn sync_team_runs(&self, runs: &[TeamRunDto]) -> Result<(), String> {
        let mut conn = self.conn.lock();
        let tx = conn
            .transaction()
            .map_err(|e| format!("开启事务失败: {e}"))?;
        tx.execute(
            "INSERT INTO meta (key, value) VALUES ('team_runs_initialized', '1') ON CONFLICT(key) DO NOTHING",
            [],
        )
        .map_err(|e| format!("写入存档接管标记失败: {e}"))?;

        {
            let mut stmt = tx
                .prepare("SELECT id FROM team_runs")
                .map_err(|e| format!("准备存档枚举失败: {e}"))?;
            let existing: Vec<String> = stmt
                .query_map([], |row| row.get(0))
                .map_err(|e| format!("枚举存档失败: {e}"))?
                .collect::<Result<_, _>>()
                .map_err(|e| format!("读取存档 id 失败: {e}"))?;
            drop(stmt);
            let kept: std::collections::HashSet<&str> =
                runs.iter().map(|r| r.id.as_str()).collect();
            for id in existing.iter().filter(|id| !kept.contains(id.as_str())) {
                tx.execute("DELETE FROM team_runs WHERE id = ?1", params![id])
                    .map_err(|e| format!("删除存档失败: {e}"))?;
            }
        }

        for run in runs {
            tx.execute(
                "INSERT INTO team_runs (id, payload) VALUES (?1, ?2)
                 ON CONFLICT(id) DO UPDATE SET payload = ?2",
                params![run.id, run.payload.to_string()],
            )
            .map_err(|e| format!("写入存档失败: {e}"))?;
        }
        tx.commit().map_err(|e| format!("提交事务失败: {e}"))?;
        Ok(())
    }

    /// 读 ACP 后端目录；未接管 → None（前端以内置缺省 seed）。
    pub fn load_agent_providers(&self) -> Result<Option<Vec<AgentProviderDto>>, String> {
        let conn = self.conn.lock();
        let initialized: Option<String> = conn
            .query_row(
                "SELECT value FROM meta WHERE key = 'agent_providers_initialized'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("读取后端目录标记失败: {e}"))?;
        if initialized.is_none() {
            return Ok(None);
        }
        let mut stmt = conn
            .prepare("SELECT id, name, kind, command, enabled FROM agent_providers ORDER BY rowid")
            .map_err(|e| format!("准备后端目录查询失败: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(AgentProviderDto {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    kind: row.get(2)?,
                    command: row.get(3)?,
                    enabled: row.get::<_, i64>(4)? != 0,
                })
            })
            .map_err(|e| format!("查询后端目录失败: {e}"))?;
        let mut providers = Vec::new();
        for row in rows {
            providers.push(row.map_err(|e| format!("读取后端目录行失败: {e}"))?);
        }
        Ok(Some(providers))
    }

    /// 全量替换 ACP 后端目录（事务；启停切换走此快照 sync）。首次写接管标记。
    pub fn sync_agent_providers(&self, providers: &[AgentProviderDto]) -> Result<(), String> {
        let mut conn = self.conn.lock();
        let tx = conn
            .transaction()
            .map_err(|e| format!("开启事务失败: {e}"))?;
        tx.execute(
            "INSERT INTO meta (key, value) VALUES ('agent_providers_initialized', '1') ON CONFLICT(key) DO NOTHING",
            [],
        )
        .map_err(|e| format!("写入后端目录接管标记失败: {e}"))?;

        {
            let mut stmt = tx
                .prepare("SELECT id FROM agent_providers")
                .map_err(|e| format!("准备后端枚举失败: {e}"))?;
            let existing: Vec<String> = stmt
                .query_map([], |row| row.get(0))
                .map_err(|e| format!("枚举后端失败: {e}"))?
                .collect::<Result<_, _>>()
                .map_err(|e| format!("读取后端 id 失败: {e}"))?;
            drop(stmt);
            let kept: std::collections::HashSet<&str> =
                providers.iter().map(|p| p.id.as_str()).collect();
            for id in existing.iter().filter(|id| !kept.contains(id.as_str())) {
                tx.execute("DELETE FROM agent_providers WHERE id = ?1", params![id])
                    .map_err(|e| format!("删除后端失败: {e}"))?;
            }
        }

        for provider in providers {
            tx.execute(
                "INSERT INTO agent_providers (id, name, kind, command, enabled)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(id) DO UPDATE SET name = ?2, kind = ?3, command = ?4, enabled = ?5",
                params![
                    provider.id,
                    provider.name,
                    provider.kind,
                    provider.command,
                    provider.enabled as i64
                ],
            )
            .map_err(|e| format!("写入后端失败: {e}"))?;
        }
        tx.commit().map_err(|e| format!("提交事务失败: {e}"))?;
        Ok(())
    }

    /// 已启用 ACP 后端的启动程序名（spawn 白名单扩展面）。
    ///
    /// 取每条启用后端命令首 token 的 basename（`npx -y pkg` → `npx`，`/usr/bin/x --acp` → `x`），
    /// 供 `acp_start` 在内置白名单之外放行用户自配的 agent。未接管目录 / 无启用项 → 空数组。
    /// 仅收敛「能被启动的程序面」的扩展：shell 元字符拒绝仍由 process_guard 生效。
    pub fn enabled_agent_programs(&self) -> Vec<String> {
        let Ok(Some(providers)) = self.load_agent_providers() else {
            return Vec::new();
        };
        providers
            .iter()
            .filter(|provider| provider.enabled)
            .filter_map(|provider| {
                let program = provider.command.split_whitespace().next()?;
                let basename = program.rsplit(['/', '\\']).next().unwrap_or(program);
                (!basename.is_empty()).then(|| basename.to_string())
            })
            .collect()
    }

    /// 全量替换自动化清单（事务；与 sessions 同语义——库中不在快照的任务删除）。
    /// 首次调用写 automation_initialized 标记。
    pub fn sync_automations(&self, tasks: &[AutomationTaskDto]) -> Result<(), String> {
        let mut conn = self.conn.lock();
        let tx = conn
            .transaction()
            .map_err(|e| format!("开启事务失败: {e}"))?;
        tx.execute(
            "INSERT INTO meta (key, value) VALUES ('automation_initialized', '1') ON CONFLICT(key) DO NOTHING",
            [],
        )
        .map_err(|e| format!("写入自动化接管标记失败: {e}"))?;

        {
            let mut stmt = tx
                .prepare("SELECT id FROM automation_tasks")
                .map_err(|e| format!("准备自动化枚举失败: {e}"))?;
            let existing: Vec<String> = stmt
                .query_map([], |row| row.get(0))
                .map_err(|e| format!("枚举自动化失败: {e}"))?
                .collect::<Result<_, _>>()
                .map_err(|e| format!("读取自动化 id 失败: {e}"))?;
            drop(stmt);
            let kept: std::collections::HashSet<&str> =
                tasks.iter().map(|t| t.id.as_str()).collect();
            for id in existing.iter().filter(|id| !kept.contains(id.as_str())) {
                tx.execute("DELETE FROM automation_tasks WHERE id = ?1", params![id])
                    .map_err(|e| format!("删除自动化失败: {e}"))?;
            }
        }

        for task in tasks {
            tx.execute(
                "INSERT INTO automation_tasks (id, name, schedule, cron, target, intent, enabled, last_run)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(id) DO UPDATE SET
                   name = ?2, schedule = ?3, cron = ?4, target = ?5,
                   intent = ?6, enabled = ?7, last_run = ?8",
                params![
                    task.id,
                    task.name,
                    task.schedule,
                    task.cron,
                    task.target,
                    task.intent,
                    task.enabled as i64,
                    task.last_run
                ],
            )
            .map_err(|e| format!("写入自动化失败: {e}"))?;
        }
        tx.commit().map_err(|e| format!("提交事务失败: {e}"))?;
        Ok(())
    }

    /* ===== 自动化到期执行队列（P2 可靠化：宿主 push、渲染端消费） ===== */

    /// 当前 epoch 毫秒（宿主 push / 窗口判定共用同一时钟源）。
    fn now_ms() -> i64 {
        chrono::Utc::now().timestamp_millis()
    }

    /// 到期入队：同一任务同一 due 毫秒幂等（INSERT OR IGNORE + unique 约束）。
    /// 宿主重启后同分钟重推被库挡下（替代原纯内存分钟键防重）。返回是否新插入。
    pub fn automation_due_push(
        &self,
        task: &AutomationTaskDto,
        due_at: i64,
    ) -> Result<bool, String> {
        let conn = self.conn.lock();
        let changed = conn
            .execute(
                "INSERT OR IGNORE INTO automation_due
                   (task_id, due_at, name, target, intent, status, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?2)",
                params![task.id, due_at, task.name, task.target, task.intent],
            )
            .map_err(|e| format!("自动化到期入队失败: {e}"))?;
        Ok(changed > 0)
    }

    /// 拉取可执行队列：pending 且到期在最近窗口内（超窗由 sweep 清理，陈旧任务不执行）。
    pub fn automation_due_list(&self) -> Result<Vec<AutomationDueDto>, String> {
        let conn = self.conn.lock();
        let cutoff = Self::now_ms() - PENDING_DUE_WINDOW_MS;
        let mut stmt = conn
            .prepare(
                "SELECT id, task_id, name, target, intent, due_at FROM automation_due
                 WHERE status = 'pending' AND due_at >= ?1 ORDER BY due_at, id",
            )
            .map_err(|e| format!("准备到期队列查询失败: {e}"))?;
        let rows = stmt
            .query_map(params![cutoff], |row| {
                Ok(AutomationDueDto {
                    id: row.get(0)?,
                    task_id: row.get(1)?,
                    name: row.get(2)?,
                    target: row.get(3)?,
                    intent: row.get(4)?,
                    due_at: row.get(5)?,
                })
            })
            .map_err(|e| format!("查询到期队列失败: {e}"))?;
        let mut items = Vec::new();
        for row in rows {
            items.push(row.map_err(|e| format!("读取到期队列行失败: {e}"))?);
        }
        Ok(items)
    }

    /// 拉取宿主兜底消费的过期行：pending 且 due_at 早于 now - stale_after_ms
    /// （渲染端在场每 30s 轮询，超时未消费 ≈ 渲染端挂/长忙）。限量防堆积。
    pub fn automation_due_list_stale(
        &self,
        stale_after_ms: i64,
        limit: u32,
    ) -> Result<Vec<AutomationDueDto>, String> {
        let conn = self.conn.lock();
        let cutoff = Self::now_ms() - stale_after_ms;
        let mut stmt = conn
            .prepare(
                "SELECT id, task_id, name, target, intent, due_at FROM automation_due
                 WHERE status = 'pending' AND due_at <= ?1 ORDER BY due_at, id LIMIT ?2",
            )
            .map_err(|e| format!("准备过期队列查询失败: {e}"))?;
        let rows = stmt
            .query_map(params![cutoff, limit], |row| {
                Ok(AutomationDueDto {
                    id: row.get(0)?,
                    task_id: row.get(1)?,
                    name: row.get(2)?,
                    target: row.get(3)?,
                    intent: row.get(4)?,
                    due_at: row.get(5)?,
                })
            })
            .map_err(|e| format!("查询过期队列失败: {e}"))?;
        let mut items = Vec::new();
        for row in rows {
            items.push(row.map_err(|e| format!("读取过期队列行失败: {e}"))?);
        }
        Ok(items)
    }

    /// 完成认领：pending → 终态（原子 UPDATE WHERE status='pending'，防双执行者双跑）。
    /// status: "success" | "failed"；返回是否认领成功。
    pub fn automation_due_finish(&self, id: i64, status: &str) -> Result<bool, String> {
        let conn = self.conn.lock();
        let changed = conn
            .execute(
                "UPDATE automation_due SET status = ?2, updated_at = ?3
                 WHERE id = ?1 AND status = 'pending'",
                params![id, status, Self::now_ms()],
            )
            .map_err(|e| format!("完成到期任务失败: {e}"))?;
        Ok(changed > 0)
    }

    /// 队列清扫：pending 超窗（60min 无人消费）删除；任何状态超 24h 删除。
    /// 宿主 tick 周期调用（30s 一次，空表开销可忽略）。
    pub fn automation_due_sweep(&self) -> Result<(), String> {
        let conn = self.conn.lock();
        let now = Self::now_ms();
        conn.execute(
            "DELETE FROM automation_due WHERE due_at < ?1 OR (status = 'pending' AND due_at < ?2)",
            params![now - DUE_KEEP_MS, now - PENDING_DUE_WINDOW_MS],
        )
        .map_err(|e| format!("清理到期队列失败: {e}"))?;
        Ok(())
    }

    /// 宿主自主执行落库：新建会话 + user/assistant 两条 ThreadMessage 原文
    /// （payload 不透明 JSON；前端 hydrate 后按既有 ThreadMessage 形状渲染）。
    pub fn insert_host_execution(
        &self,
        conversation_id: &str,
        title: &str,
        workspace_id: Option<&str>,
        user_message: &serde_json::Value,
        assistant_message: &serde_json::Value,
    ) -> Result<(), String> {
        let mut conn = self.conn.lock();
        let tx = conn
            .transaction()
            .map_err(|e| format!("开启事务失败: {e}"))?;
        let now = Self::now_ms();
        tx.execute(
            "INSERT INTO conversations (id, title, workspace_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![conversation_id, title, workspace_id, now],
        )
        .map_err(|e| format!("写入宿主会话失败: {e}"))?;
        for message in [user_message, assistant_message] {
            let id = message["id"].as_str().unwrap_or_default();
            if id.is_empty() {
                return Err("宿主消息缺 id".to_string());
            }
            tx.execute(
                "INSERT INTO messages (id, conversation_id, payload) VALUES (?1, ?2, ?3)",
                params![id, conversation_id, message.to_string()],
            )
            .map_err(|e| format!("写入宿主消息失败: {e}"))?;
        }
        tx.commit().map_err(|e| format!("提交事务失败: {e}"))?;
        Ok(())
    }

    /// 宿主执行成功回写任务 last_run（渲染端缺席时由宿主维护库值；
    /// 渲染端 hydrate 从库拉取即见）。
    pub fn automation_mark_last_run(&self, task_id: &str, at: i64) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE automation_tasks SET last_run = ?2 WHERE id = ?1",
            params![task_id, at],
        )
        .map_err(|e| format!("回写运行时刻失败: {e}"))?;
        Ok(())
    }
}

/// 读某会话的全部消息（按插入序）。
fn load_messages(
    conn: &Connection,
    conversation_id: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let mut stmt = conn
        .prepare("SELECT payload FROM messages WHERE conversation_id = ?1 ORDER BY rowid")
        .map_err(|e| format!("准备消息查询失败: {e}"))?;
    let rows = stmt
        .query_map(params![conversation_id], |row| row.get::<_, String>(0))
        .map_err(|e| format!("查询消息失败: {e}"))?;
    let mut messages = Vec::new();
    for row in rows {
        let payload = row.map_err(|e| format!("读取消息行失败: {e}"))?;
        let value: serde_json::Value =
            serde_json::from_str(&payload).map_err(|e| format!("解析消息 JSON 失败: {e}"))?;
        messages.push(value);
    }
    Ok(messages)
}

/// 迁移链：下标 = 目标 user_version。只追加不修改历史项。
const MIGRATIONS: [&str; 5] = [
    "
CREATE TABLE conversations (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL DEFAULT '',
    workspace_id TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
CREATE TABLE messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    payload         TEXT NOT NULL
);
CREATE INDEX idx_messages_conversation ON messages(conversation_id);
CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
",
    "
CREATE TABLE automation_tasks (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL DEFAULT '',
    schedule  TEXT NOT NULL DEFAULT '',
    cron      TEXT,
    target    TEXT NOT NULL DEFAULT '',
    intent    TEXT NOT NULL DEFAULT '',
    enabled   INTEGER NOT NULL DEFAULT 0,
    last_run  INTEGER NOT NULL DEFAULT 0
);
",
    "
CREATE TABLE team_runs (
    id       TEXT PRIMARY KEY,
    payload  TEXT NOT NULL
);
",
    "
CREATE TABLE agent_providers (
    id       TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    kind     TEXT NOT NULL,
    command  TEXT NOT NULL,
    enabled  INTEGER NOT NULL DEFAULT 0
);
",
    "
CREATE TABLE automation_due (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT NOT NULL REFERENCES automation_tasks(id) ON DELETE CASCADE,
    due_at     INTEGER NOT NULL,
    name       TEXT NOT NULL DEFAULT '',
    target     TEXT NOT NULL DEFAULT '',
    intent     TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'pending',
    updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_automation_due_once ON automation_due(task_id, due_at);
CREATE INDEX idx_automation_due_pending ON automation_due(status, due_at);
",
];

/// 顺序推进 user_version 到 MIGRATIONS.len()。
fn migrate(conn: &mut Connection) -> rusqlite::Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    for (index, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
        conn.execute_batch(sql)?;
        let next = (index + 1) as i64;
        conn.execute_batch(&format!("PRAGMA user_version = {next}"))?;
    }
    Ok(())
}

/* ===== Tauri commands（薄壳：逻辑在 Db 方法，便于脱离 State 单测） ===== */

/// 读设置快照（meta.settings）；从未持久化过 → null。
#[tauri::command]
pub fn db_settings_load(state: tauri::State<'_, Db>) -> Result<Option<serde_json::Value>, String> {
    state.load_settings()
}

/// 全量替换设置快照（单对象 upsert；调用方为渲染端显式 persist）。
#[tauri::command]
pub fn db_settings_sync(
    state: tauri::State<'_, Db>,
    settings: serde_json::Value,
) -> Result<(), String> {
    state.sync_settings(&settings)
}

/// 读自动化任务清单；库未接管 → null（前端以种子回填并首落库）。
#[tauri::command]
pub fn db_automations_load(
    state: tauri::State<'_, Db>,
) -> Result<Option<Vec<AutomationTaskDto>>, String> {
    state.load_automations()
}

/// 全量替换自动化清单（事务幂等）。
#[tauri::command]
pub fn db_automations_sync(
    state: tauri::State<'_, Db>,
    tasks: Vec<AutomationTaskDto>,
) -> Result<(), String> {
    state.sync_automations(&tasks)
}

/// 拉取到期执行队列（pending 且在最近窗口内；渲染端单消费循环调用）。
#[tauri::command]
pub fn db_automations_due_list(
    state: tauri::State<'_, Db>,
) -> Result<Vec<AutomationDueDto>, String> {
    state.automation_due_list()
}

/// 完成认领到期任务（pending → success/failed；原子防双执行）。
#[tauri::command]
pub fn db_automations_due_finish(
    state: tauri::State<'_, Db>,
    id: i64,
    status: String,
) -> Result<bool, String> {
    state.automation_due_finish(id, &status)
}

/// 读编排运行存档；库未接管 → null。
#[tauri::command]
pub fn db_team_runs_load(state: tauri::State<'_, Db>) -> Result<Option<Vec<TeamRunDto>>, String> {
    state.load_team_runs()
}

/// 全量替换编排存档（事务幂等；运行结束后由渲染端写一次）。
#[tauri::command]
pub fn db_team_runs_sync(state: tauri::State<'_, Db>, runs: Vec<TeamRunDto>) -> Result<(), String> {
    state.sync_team_runs(&runs)
}

/// 读 ACP 后端目录；库未接管 → null（前端以内置缺省 seed 并首落库）。
#[tauri::command]
pub fn db_agents_load(
    state: tauri::State<'_, Db>,
) -> Result<Option<Vec<AgentProviderDto>>, String> {
    state.load_agent_providers()
}

/// 全量替换 ACP 后端目录（事务幂等；启停切换由渲染端 persist 驱动）。
#[tauri::command]
pub fn db_agents_sync(
    state: tauri::State<'_, Db>,
    providers: Vec<AgentProviderDto>,
) -> Result<(), String> {
    state.sync_agent_providers(&providers)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot_with(sessions: Vec<ConversationDto>, active: Option<&str>) -> SessionsSnapshotDto {
        SessionsSnapshotDto {
            sessions,
            active_session_id: active.map(|s| s.to_string()),
        }
    }

    fn conversation(id: &str, message_count: usize) -> ConversationDto {
        ConversationDto {
            id: id.to_string(),
            title: format!("会话 {id}"),
            workspace_id: Some("ws-1".to_string()),
            created_at: 1_000,
            updated_at: 2_000,
            messages: (0..message_count)
                .map(|i| {
                    json!({
                        "id": format!("{id}-m{i}"),
                        "role": if i % 2 == 0 { "user" } else { "assistant" },
                        "content": format!("消息 {i}"),
                        "ts": 1_000 + i as i64,
                        "tools": [ { "toolCallId": format!("t{i}"), "kind": "think" } ],
                    })
                })
                .collect(),
        }
    }

    #[test]
    fn migrations_advance_user_version_and_create_tables() {
        let db = Db::open_in_memory().expect("open");
        let conn = db.conn.lock();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, MIGRATIONS.len() as i64);
        for table in ["conversations", "messages", "meta"] {
            let count: i64 = conn
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    params![table],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(count, 1, "表 {table} 应存在");
        }
    }

    #[test]
    fn fresh_db_loads_none_until_first_sync() {
        let db = Db::open_in_memory().expect("open");
        assert!(
            db.load_snapshot().unwrap().is_none(),
            "未接管前 load 应为 None"
        );

        db.sync_snapshot(&snapshot_with(vec![], None)).unwrap();
        let loaded = db.load_snapshot().unwrap().expect("接管后 load 应为 Some");
        assert!(loaded.sessions.is_empty());
        assert!(loaded.active_session_id.is_none());
    }

    #[test]
    fn roundtrip_preserves_conversation_and_message_fields() {
        let db = Db::open_in_memory().expect("open");
        let snapshot = snapshot_with(
            vec![conversation("ses-a", 3), conversation("ses-b", 1)],
            Some("ses-b"),
        );
        db.sync_snapshot(&snapshot).unwrap();

        let loaded = db.load_snapshot().unwrap().expect("some");
        assert_eq!(loaded.sessions.len(), 2);
        assert_eq!(loaded.active_session_id.as_deref(), Some("ses-b"));

        let a = loaded.sessions.iter().find(|s| s.id == "ses-a").unwrap();
        assert_eq!(a.title, "会话 ses-a");
        assert_eq!(a.workspace_id.as_deref(), Some("ws-1"));
        assert_eq!(a.created_at, 1_000);
        assert_eq!(a.messages.len(), 3);
        // 消息不透明往返：tools 等扩展字段原样保留
        assert_eq!(a.messages[0]["tools"][0]["toolCallId"], "t0");
        assert_eq!(a.messages[0]["content"], "消息 0");
        assert_eq!(a.messages[2]["role"], "user");
        assert_eq!(a.messages[1]["role"], "assistant");
    }

    #[test]
    fn sync_is_idempotent_and_orders_messages_by_insertion() {
        let db = Db::open_in_memory().expect("open");
        let snapshot = snapshot_with(vec![conversation("ses-a", 3)], Some("ses-a"));
        db.sync_snapshot(&snapshot).unwrap();
        db.sync_snapshot(&snapshot).unwrap(); // 同快照重复同步

        let loaded = db.load_snapshot().unwrap().expect("some");
        assert_eq!(loaded.sessions.len(), 1);
        let a = &loaded.sessions[0];
        assert_eq!(a.messages.len(), 3, "重复同步不得复制消息");
        let ids: Vec<&str> = a.messages.iter().filter_map(|m| m["id"].as_str()).collect();
        assert_eq!(
            ids,
            vec!["ses-a-m0", "ses-a-m1", "ses-a-m2"],
            "消息保持插入序"
        );
    }

    #[test]
    fn sync_removes_vanished_sessions_with_cascade() {
        let db = Db::open_in_memory().expect("open");
        db.sync_snapshot(&snapshot_with(
            vec![conversation("ses-a", 2), conversation("ses-b", 4)],
            Some("ses-a"),
        ))
        .unwrap();
        // 第二次同步少一个会话 → 应整体删除（消息级联）
        db.sync_snapshot(&snapshot_with(
            vec![conversation("ses-a", 2)],
            Some("ses-a"),
        ))
        .unwrap();

        let loaded = db.load_snapshot().unwrap().expect("some");
        assert_eq!(loaded.sessions.len(), 1);
        assert_eq!(loaded.sessions[0].id, "ses-a");
        let orphan: i64 = db
            .conn
            .lock()
            .query_row(
                "SELECT count(*) FROM messages WHERE conversation_id = 'ses-b'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(orphan, 0, "会话删除后消息应级联清除");
    }

    #[test]
    fn active_session_id_roundtrip_and_clear() {
        let db = Db::open_in_memory().expect("open");
        db.sync_snapshot(&snapshot_with(vec![], Some("ses-x")))
            .unwrap();
        assert_eq!(
            db.load_snapshot()
                .unwrap()
                .unwrap()
                .active_session_id
                .as_deref(),
            Some("ses-x")
        );
        db.sync_snapshot(&snapshot_with(vec![], None)).unwrap();
        assert!(db
            .load_snapshot()
            .unwrap()
            .unwrap()
            .active_session_id
            .is_none());
    }

    #[test]
    fn empty_snapshot_after_initialization_stays_empty() {
        // 用户清空全部会话后重启：不得因「空库」回退到种子数据
        let db = Db::open_in_memory().expect("open");
        db.sync_snapshot(&snapshot_with(
            vec![conversation("ses-a", 1)],
            Some("ses-a"),
        ))
        .unwrap();
        db.sync_snapshot(&snapshot_with(vec![], None)).unwrap();
        let loaded = db.load_snapshot().unwrap();
        assert!(loaded.is_some(), "接管后清空仍是真源（Some 空快照）");
        assert!(loaded.unwrap().sessions.is_empty());
    }

    #[test]
    fn settings_load_none_before_first_sync() {
        let db = Db::open_in_memory().expect("open");
        assert!(db.load_settings().unwrap().is_none());
        // settings 不写接管标记：与会话快照互不干扰
        assert!(db.load_snapshot().unwrap().is_none());
    }

    #[test]
    fn settings_roundtrip_preserves_nested_object() {
        let db = Db::open_in_memory().expect("open");
        let settings = json!({
            "theme": "light",
            "modelProviders": [
                { "id": "opencode", "name": "OpenCode", "model": "ling-3.0-flash-fin-free", "enabled": true }
            ],
            "cliIntegrations": [],
            "selectedModelProviderId": null
        });
        db.sync_settings(&settings).unwrap();
        let loaded = db.load_settings().unwrap().expect("some");
        assert_eq!(loaded["theme"], "light");
        assert_eq!(
            loaded["modelProviders"][0]["model"],
            "ling-3.0-flash-fin-free"
        );
        assert!(loaded["selectedModelProviderId"].is_null());
    }

    #[test]
    fn settings_sync_overwrites_previous() {
        let db = Db::open_in_memory().expect("open");
        db.sync_settings(&json!({ "theme": "dark" })).unwrap();
        db.sync_settings(&json!({ "theme": "system" })).unwrap();
        let loaded = db.load_settings().unwrap().expect("some");
        assert_eq!(loaded["theme"], "system");
        assert_eq!(loaded.as_object().unwrap().len(), 1, "整体替换不残留旧键");
    }

    #[test]
    fn migrations_advance_to_v2_with_automation_tasks() {
        let db = Db::open_in_memory().expect("open");
        let conn = db.conn.lock();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, MIGRATIONS.len() as i64);
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'automation_tasks'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    fn task(id: &str, cron: Option<&str>, enabled: bool) -> AutomationTaskDto {
        AutomationTaskDto {
            id: id.to_string(),
            name: format!("任务 {id}"),
            schedule: "每天 09:00".to_string(),
            cron: cron.map(|c| c.to_string()),
            target: "主仓".to_string(),
            intent: "生成日报".to_string(),
            enabled,
            last_run: 0,
        }
    }

    #[test]
    fn automations_load_none_until_first_sync() {
        let db = Db::open_in_memory().expect("open");
        assert!(db.load_automations().unwrap().is_none());
        db.sync_automations(&[]).unwrap();
        let loaded = db.load_automations().unwrap().expect("接管后 Some");
        assert!(loaded.is_empty(), "接管后空清单 = 用户清空（不复活种子）");
    }

    #[test]
    fn automations_roundtrip_preserves_cron_and_enabled() {
        let db = Db::open_in_memory().expect("open");
        let tasks = vec![
            task("at-1", Some("0 9 * * *"), true),
            task("at-2", None, false), // 手动触发
        ];
        db.sync_automations(&tasks).unwrap();
        let loaded = db.load_automations().unwrap().expect("some");
        assert_eq!(loaded.len(), 2);
        let at1 = loaded.iter().find(|t| t.id == "at-1").unwrap();
        assert_eq!(at1.cron.as_deref(), Some("0 9 * * *"));
        assert!(at1.enabled);
        assert_eq!(at1.name, "任务 at-1");
        let at2 = loaded.iter().find(|t| t.id == "at-2").unwrap();
        assert!(at2.cron.is_none());
        assert!(!at2.enabled);
    }

    #[test]
    fn automations_sync_removes_vanished_and_updates_last_run() {
        let db = Db::open_in_memory().expect("open");
        db.sync_automations(&[
            task("at-1", Some("0 9 * * *"), true),
            task("at-2", None, false),
        ])
        .unwrap();
        // 前端执行完成回写 last_run（同一任务 upsert）
        let mut updated = task("at-1", Some("0 9 * * *"), true);
        updated.last_run = 1_700_000_000_000;
        db.sync_automations(&[updated]).unwrap();
        let loaded = db.load_automations().unwrap().expect("some");
        assert_eq!(loaded.len(), 1, "at-2 消失应被删除");
        assert_eq!(loaded[0].last_run, 1_700_000_000_000);
        assert_eq!(loaded[0].id, "at-1");
    }

    fn run(id: &str, goal: &str) -> TeamRunDto {
        TeamRunDto {
            id: id.to_string(),
            payload: json!({
                "id": id,
                "goal": goal,
                "status": "done",
                "subtasks": [ { "id": format!("{id}-s1"), "role": "builder", "prompt": goal, "status": "done" } ],
                "createdAt": 1_000,
                "finishedAt": 2_000,
            }),
        }
    }

    #[test]
    fn team_runs_migration_v3_advances_version() {
        let db = Db::open_in_memory().expect("open");
        let conn = db.conn.lock();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, MIGRATIONS.len() as i64);
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'team_runs'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn team_runs_load_none_until_first_sync() {
        let db = Db::open_in_memory().expect("open");
        assert!(db.load_team_runs().unwrap().is_none());
        db.sync_team_runs(&[]).unwrap();
        let loaded = db.load_team_runs().unwrap().expect("接管后 Some");
        assert!(loaded.is_empty(), "接管后空存档 = 用户清空");
    }

    #[test]
    fn team_runs_roundtrip_preserves_subtasks_untouched() {
        let db = Db::open_in_memory().expect("open");
        let runs = vec![run("run-1", "生成日报"), run("run-2", "巡检依赖")];
        db.sync_team_runs(&runs).unwrap();
        let loaded = db.load_team_runs().unwrap().expect("some");
        assert_eq!(loaded.len(), 2);
        let run1 = loaded.iter().find(|r| r.id == "run-1").unwrap();
        assert_eq!(run1.payload["goal"], "生成日报");
        assert_eq!(run1.payload["subtasks"][0]["role"], "builder");
        assert_eq!(run1.payload["status"], "done");
        // payload 内 id 与行 id 一致
        assert_eq!(run1.payload["id"], "run-1");
    }

    #[test]
    fn team_runs_sync_upserts_and_removes_vanished() {
        let db = Db::open_in_memory().expect("open");
        db.sync_team_runs(&[run("run-1", "a"), run("run-2", "b")])
            .unwrap();
        let mut updated = run("run-1", "a 更新");
        updated.payload["goal"] = json!("更新目标");
        db.sync_team_runs(&[updated]).unwrap();
        let loaded = db.load_team_runs().unwrap().expect("some");
        assert_eq!(loaded.len(), 1, "run-2 消失应删除");
        assert_eq!(loaded[0].payload["goal"], "更新目标");
    }

    fn provider(id: &str, enabled: bool) -> AgentProviderDto {
        AgentProviderDto {
            id: id.to_string(),
            name: format!("后端 {id}"),
            kind: "acp".to_string(),
            command: format!("{id} acp"),
            enabled,
        }
    }

    #[test]
    fn agent_providers_migration_v4_advances_version() {
        let db = Db::open_in_memory().expect("open");
        let conn = db.conn.lock();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, MIGRATIONS.len() as i64);
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'agent_providers'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn agent_providers_load_none_until_first_sync() {
        let db = Db::open_in_memory().expect("open");
        assert!(db.load_agent_providers().unwrap().is_none());
        db.sync_agent_providers(&[]).unwrap();
        assert!(db.load_agent_providers().unwrap().unwrap().is_empty());
    }

    #[test]
    fn agent_providers_roundtrip_preserves_enabled_and_command() {
        let db = Db::open_in_memory().expect("open");
        db.sync_agent_providers(&[provider("opencode", true), provider("codex", false)])
            .unwrap();
        let loaded = db.load_agent_providers().unwrap().expect("some");
        assert_eq!(loaded.len(), 2);
        let opencode = loaded.iter().find(|p| p.id == "opencode").unwrap();
        assert!(opencode.enabled);
        assert_eq!(opencode.command, "opencode acp");
        let codex = loaded.iter().find(|p| p.id == "codex").unwrap();
        assert!(!codex.enabled);
    }

    #[test]
    fn agent_providers_sync_toggles_and_removes_vanished() {
        let db = Db::open_in_memory().expect("open");
        db.sync_agent_providers(&[provider("opencode", true), provider("mock-agent", true)])
            .unwrap();
        // 禁用 opencode + 移除 mock-agent（模拟目录缩减）
        db.sync_agent_providers(&[provider("opencode", false)])
            .unwrap();
        let loaded = db.load_agent_providers().unwrap().expect("some");
        assert_eq!(loaded.len(), 1);
        assert!(!loaded[0].enabled);
    }

    #[test]
    fn enabled_agent_programs_collects_first_tokens_of_enabled_only() {
        let db = Db::open_in_memory().expect("open");
        db.sync_agent_providers(&[
            provider("opencode", true), // "opencode acp" → opencode
            provider("codex", false),   // 禁用 → 不进入可 spawn 面
            AgentProviderDto {
                id: "custom-1".to_string(),
                name: "My Agent".to_string(),
                kind: "acp".to_string(),
                command: "/usr/bin/my-agent --acp".to_string(),
                enabled: true, // 绝对路径 → 取 basename
            },
            AgentProviderDto {
                id: "custom-2".to_string(),
                name: "npx 型".to_string(),
                kind: "acp".to_string(),
                command: "npx -y @acp/whatever".to_string(),
                enabled: true,
            },
        ])
        .unwrap();
        assert_eq!(
            db.enabled_agent_programs(),
            vec!["opencode", "my-agent", "npx"]
        );
    }

    #[test]
    fn enabled_agent_programs_empty_before_takeover() {
        let db = Db::open_in_memory().expect("open");
        assert!(db.enabled_agent_programs().is_empty());
        // 空目录接管后依旧为空（无启用项）
        db.sync_agent_providers(&[]).unwrap();
        assert!(db.enabled_agent_programs().is_empty());
    }

    #[test]
    fn missing_message_id_is_rejected() {
        let db = Db::open_in_memory().expect("open");
        let mut bad = conversation("ses-a", 1);
        bad.messages[0] = json!({ "role": "user", "content": "无 id" });
        let result = db.sync_snapshot(&snapshot_with(vec![bad], None));
        assert!(result.is_err(), "消息缺 id 应整体拒绝（防静默丢消息）");
    }

    /* ===== automation_due 到期执行队列 ===== */

    #[test]
    fn due_migration_v5_creates_table_and_advances_version() {
        let db = Db::open_in_memory().expect("open");
        {
            let conn = db.conn.lock();
            let version: i64 = conn
                .query_row("PRAGMA user_version", [], |row| row.get(0))
                .unwrap();
            assert_eq!(version, 5, "迁移链推进到 v5");
            let count: i64 = conn
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='automation_due'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(count, 1, "automation_due 表存在");
        }
    }

    #[test]
    fn due_push_is_idempotent_per_task_due_at() {
        let db = Db::open_in_memory().expect("open");
        db.sync_automations(&[task("at-1", Some("0 9 * * *"), true)])
            .unwrap();
        let t = task("at-1", Some("0 9 * * *"), true);
        let now = Db::now_ms();
        assert!(db.automation_due_push(&t, now).unwrap());
        assert!(
            !db.automation_due_push(&t, now).unwrap(),
            "同任务同 due_at 重复入队应被 unique 挡下（宿主重启兜底）"
        );
        assert!(
            db.automation_due_push(&t, now + 60_000).unwrap(),
            "不同 due_at（下一分钟）可入队"
        );
        assert_eq!(db.automation_due_list().unwrap().len(), 2);
    }

    #[test]
    fn due_list_returns_pending_snapshot_in_window_only() {
        let db = Db::open_in_memory().expect("open");
        db.sync_automations(&[
            task("at-fresh", Some("0 9 * * *"), true),
            task("at-stale", Some("0 3 * * *"), true),
        ])
        .unwrap();
        let fresh = task("at-fresh", Some("0 9 * * *"), true);
        let stale = task("at-stale", Some("0 3 * * *"), true);
        // 刚到期（now - 1s）与超窗（now - 2h）各一条
        let now = Db::now_ms();
        db.automation_due_push(&fresh, now - 1_000).unwrap();
        db.automation_due_push(&stale, now - 7_200_000).unwrap();
        let items = db.automation_due_list().unwrap();
        assert_eq!(items.len(), 1, "超窗 pending 不进入可执行列表");
        assert_eq!(items[0].task_id, "at-fresh");
        assert_eq!(items[0].intent, fresh.intent);
        assert!(items[0].id > 0);
    }

    #[test]
    fn due_finish_atomically_claims_pending_once() {
        let db = Db::open_in_memory().expect("open");
        db.sync_automations(&[task("at-1", Some("0 9 * * *"), true)])
            .unwrap();
        let t = task("at-1", Some("0 9 * * *"), true);
        db.automation_due_push(&t, Db::now_ms()).unwrap();
        let item = db.automation_due_list().unwrap().remove(0);
        assert!(db.automation_due_finish(item.id, "success").unwrap());
        assert!(
            !db.automation_due_finish(item.id, "failed").unwrap(),
            "终态行不可二次认领（防双执行者双跑）"
        );
        assert!(
            db.automation_due_list().unwrap().is_empty(),
            "完成行离开可执行列表"
        );
    }

    #[test]
    fn due_sweep_clears_window_expired_pending_and_old_records() {
        let db = Db::open_in_memory().expect("open");
        db.sync_automations(&[
            task("at-1", Some("0 9 * * *"), true),
            task("at-2", Some("0 3 * * *"), true),
            task("at-3", Some("0 6 * * *"), true),
        ])
        .unwrap();
        let now = Db::now_ms();
        let t1 = task("at-1", Some("0 9 * * *"), true);
        let t2 = task("at-2", Some("0 3 * * *"), true);
        let t3 = task("at-3", Some("0 6 * * *"), true);
        db.automation_due_push(&t1, now - 7_200_000).unwrap(); // pending 超窗 2h
        db.automation_due_push(&t2, now - 3_600_000).unwrap(); // pending 恰好窗口边界（>= 窗口不删）
        db.automation_due_push(&t3, now - 30_000).unwrap(); // 新鲜
                                                            // 一条完成于 25h 前（超保留期）
        let done_id = db.automation_due_list().unwrap().remove(0);
        let _ = done_id;
        // t3 完成并手动把 updated_at 改旧以测 24h 清理：直接改库
        {
            let conn = db.conn.lock();
            conn.execute(
                "UPDATE automation_due SET status='failed', updated_at = ?1 WHERE task_id='at-3'",
                params![now - 86_400_000 - 1],
            )
            .unwrap();
        }
        db.automation_due_sweep().unwrap();
        let remaining = db.automation_due_list().unwrap();
        assert_eq!(remaining.len(), 0, "超窗 pending 清理后不剩");
        {
            let conn = db.conn.lock();
            let count: i64 = conn
                .query_row("SELECT count(*) FROM automation_due", [], |row| row.get(0))
                .unwrap();
            assert_eq!(count, 1, "仅 t2（窗口内 pending）保留");
        }
    }

    #[tokio::test]
    async fn host_exec_finishes_stale_row_failed_without_model_config() {
        // 离线闭环：settings 未初始化 → 宿主无法执行 → 行原子 finish(failed)，
        // 渲染端恢复后不残留死队列（下个 cron 重新到期）。
        let db = Db::open_in_memory().expect("open");
        let task = task("at-host-1", Some("0 9 * * *"), true);
        db.sync_automations(&[task.clone()]).unwrap();
        let stale_due_at = chrono::Utc::now().timestamp_millis() - 180_000;
        db.automation_due_push(&task, stale_due_at).unwrap();

        crate::host_exec::claim_and_run(&db).await;

        let remaining = db.automation_due_list().unwrap();
        assert!(remaining.is_empty(), "过期行已被消费");
        {
            let conn = db.conn.lock();
            let status: String = conn
                .query_row(
                    "SELECT status FROM automation_due WHERE task_id = 'at-host-1'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(status, "failed");
            let last_run: i64 = conn
                .query_row(
                    "SELECT last_run FROM automation_tasks WHERE id = 'at-host-1'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(last_run, 0, "执行失败不更新 last_run");
        }
    }

    #[tokio::test]
    async fn host_exec_skips_fresh_pending_rows() {
        // 渲染端正常消费窗口内的行宿主不抢（避免双跑）。
        let db = Db::open_in_memory().expect("open");
        let task = task("at-host-2", None, true);
        db.sync_automations(&[task.clone()]).unwrap();
        db.automation_due_push(&task, chrono::Utc::now().timestamp_millis())
            .unwrap();

        crate::host_exec::claim_and_run(&db).await;

        let remaining = db.automation_due_list().unwrap();
        assert_eq!(remaining.len(), 1, "fresh 行留给渲染端");
    }

    #[test]
    fn due_rows_cascade_when_task_deleted() {
        let db = Db::open_in_memory().expect("open");
        db.sync_automations(&[task("at-1", Some("0 9 * * *"), true)])
            .unwrap();
        let t = task("at-1", Some("0 9 * * *"), true);
        db.automation_due_push(&t, Db::now_ms()).unwrap();
        // 任务被用户删除（sync 全量替换移除）→ 队列行级联消失
        db.sync_automations(&[]).unwrap();
        assert!(db.automation_due_list().unwrap().is_empty());
    }
}
