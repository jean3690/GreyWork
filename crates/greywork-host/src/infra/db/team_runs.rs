//! 编排运行存档：load / sync。

use rusqlite::{params, OptionalExtension};

use super::dto::TeamRunDto;
use super::Db;

impl Db {
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
}
