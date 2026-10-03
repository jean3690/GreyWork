//! 会话快照：load / sync 与消息读取。

use rusqlite::{params, Connection, OptionalExtension};

use super::dto::*;
use super::Db;

impl Db {
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
    /// 生产只读旧库（load_snapshot 供文件面迁移）；写侧仅测试模拟旧库用，
    /// 但桌面壳的 `#[cfg(test)]` 看不到本 crate 的 `cfg(test)` 项，故不门控。
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
