//! ACP 后端目录：load / sync 与「启用程序名」派生。

use rusqlite::{params, OptionalExtension};

use super::dto::AgentProviderDto;
use super::Db;

impl Db {
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
            .prepare(
                "SELECT id, name, kind, command, enabled, env FROM agent_providers ORDER BY rowid",
            )
            .map_err(|e| format!("准备后端目录查询失败: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(AgentProviderDto {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    kind: row.get(2)?,
                    command: row.get(3)?,
                    enabled: row.get::<_, i64>(4)? != 0,
                    env: row.get(5)?,
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
                "INSERT INTO agent_providers (id, name, kind, command, enabled, env)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(id) DO UPDATE SET name = ?2, kind = ?3, command = ?4, enabled = ?5, env = ?6",
                params![
                    provider.id,
                    provider.name,
                    provider.kind,
                    provider.command,
                    provider.enabled as i64,
                    provider.env
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
}
