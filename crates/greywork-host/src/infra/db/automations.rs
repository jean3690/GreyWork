//! 自动化任务与到期执行队列：任务 sync、到期 push/list/finish/sweep、运行记录、宿主执行落库。

use rusqlite::{params, OptionalExtension};

use super::dto::*;
use super::Db;

/// 到期队列保留窗口：pending 超 60min 无人消费即 sweep（等价旧「busy 跳过」语义，
/// 但 busy/重启不再丢——窗口内渲染端恢复即补跑）。
const PENDING_DUE_WINDOW_MS: i64 = 3_600_000;
/// 全状态行最长保留：超 24h 清理，防表膨胀。
const DUE_KEEP_MS: i64 = 86_400_000;

impl Db {
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
                "SELECT id, name, schedule, cron, target, intent, enabled, last_run, acp_provider_id, once_at
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
                    acp_provider_id: row.get(8)?,
                    once_at: row.get(9)?,
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
                "INSERT INTO automation_tasks (id, name, schedule, cron, target, intent, enabled, last_run, acp_provider_id, once_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(id) DO UPDATE SET
                   name = ?2, schedule = ?3, cron = ?4, target = ?5,
                   intent = ?6, enabled = ?7, last_run = ?8, acp_provider_id = ?9, once_at = ?10",
                params![
                    task.id,
                    task.name,
                    task.schedule,
                    task.cron,
                    task.target,
                    task.intent,
                    task.enabled,
                    task.last_run,
                    task.acp_provider_id,
                    task.once_at,
                ],
            )
            .map_err(|e| format!("写入自动化失败: {e}"))?;
        }
        // 孤儿运行记录清理：任务被移除后其历史随之作废（automation_runs 无外键，需显式清）。
        tx.execute(
            "DELETE FROM automation_runs WHERE task_id NOT IN (SELECT id FROM automation_tasks)",
            [],
        )
        .map_err(|e| format!("清理孤儿运行记录失败: {e}"))?;
        tx.commit().map_err(|e| format!("提交事务失败: {e}"))?;
        Ok(())
    }

    /* ===== 自动化到期执行队列（P2 可靠化：宿主 push、渲染端消费） ===== */

    /// 当前 epoch 毫秒（宿主 push / 窗口判定共用同一时钟源）。
    pub(crate) fn now_ms() -> i64 {
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
                   (task_id, due_at, name, target, intent, acp_provider_id, status, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?2)",
                params![
                    task.id,
                    due_at,
                    task.name,
                    task.target,
                    task.intent,
                    task.acp_provider_id
                ],
            )
            .map_err(|e| format!("自动化到期入队失败: {e}"))?;
        Ok(changed > 0)
    }

    /// 拉取可执行队列：pending 且到期在最近窗口内（超窗由 sweep 清理，陈旧任务不执行）。
    pub fn automation_due_list(&self) -> Result<Vec<AutomationDueDto>, String> {
        self.automation_due_list_at(Self::now_ms())
    }

    /// 固定时刻的可执行队列快照。生产入口传当前时间；测试用固定时间锁定窗口边界。
    pub(crate) fn automation_due_list_at(&self, now: i64) -> Result<Vec<AutomationDueDto>, String> {
        let conn = self.conn.lock();
        let cutoff = now - PENDING_DUE_WINDOW_MS;
        let mut stmt = conn
            .prepare(
                "SELECT id, task_id, name, target, intent, acp_provider_id, due_at FROM automation_due
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
                    acp_provider_id: row.get(5)?,
                    due_at: row.get(6)?,
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
                "SELECT id, task_id, name, target, intent, acp_provider_id, due_at FROM automation_due
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
                    acp_provider_id: row.get(5)?,
                    due_at: row.get(6)?,
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

    /// 队列清扫：pending 超窗（60min 无人消费）删除；终态记录完成超过 24h 删除。
    pub fn automation_due_sweep(&self) -> Result<(), String> {
        self.automation_due_sweep_at(Self::now_ms())
    }

    /// 固定时刻执行清扫，确保查询与删除共享同一个窗口边界。
    pub(crate) fn automation_due_sweep_at(&self, now: i64) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "DELETE FROM automation_due WHERE updated_at < ?1 OR (status = 'pending' AND due_at < ?2)",
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

    /// 记一条运行结果；写入后按 task_id 裁剪，仅保留最近 50 条（防表膨胀）。
    /// 无外键：渲染端 fire-and-forget 记录可能先于任务 sync 落库，外键会误挡。
    /// 孤儿行由 `sync_automations` 全量替换时清理。
    pub fn automation_record_run(&self, run: &AutomationRunInputDto) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO automation_runs (task_id, name, status, detail, session_id, mode, ran_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                run.task_id,
                run.name,
                run.status,
                run.detail,
                run.session_id,
                run.mode,
                run.ran_at
            ],
        )
        .map_err(|e| format!("写入运行记录失败: {e}"))?;
        conn.execute(
            "DELETE FROM automation_runs WHERE task_id = ?1 AND id NOT IN (
               SELECT id FROM automation_runs WHERE task_id = ?1 ORDER BY ran_at DESC, id DESC LIMIT 50
             )",
            params![run.task_id],
        )
        .map_err(|e| format!("裁剪运行记录失败: {e}"))?;
        Ok(())
    }

    /// 读运行记录（新→旧，最多 limit 条）。
    pub fn automation_runs_load(&self, limit: i64) -> Result<Vec<AutomationRunDto>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT id, task_id, name, status, detail, session_id, mode, ran_at
                 FROM automation_runs ORDER BY ran_at DESC, id DESC LIMIT ?1",
            )
            .map_err(|e| format!("准备运行记录查询失败: {e}"))?;
        let rows = stmt
            .query_map(params![limit], |row| {
                Ok(AutomationRunDto {
                    id: row.get(0)?,
                    task_id: row.get(1)?,
                    name: row.get(2)?,
                    status: row.get(3)?,
                    detail: row.get(4)?,
                    session_id: row.get(5)?,
                    mode: row.get(6)?,
                    ran_at: row.get(7)?,
                })
            })
            .map_err(|e| format!("查询运行记录失败: {e}"))?;
        let mut items = Vec::new();
        for row in rows {
            items.push(row.map_err(|e| format!("读取运行记录行失败: {e}"))?);
        }
        Ok(items)
    }

    /* ===== 本地 RAG 索引（rag.rs 消费） =====
     *
     * 向量以 float32 小端 BLOB 存；暴力余弦在内存里算，故这里只负责存取与增量维护。
     * root 是授权工作区根的规范路径字符串，同一个文件按 (root, path) 定位。 */
}
