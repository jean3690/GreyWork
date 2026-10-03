//! 设置快照：meta.settings 单对象 upsert。

use rusqlite::{params, OptionalExtension};

use super::Db;

impl Db {
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
}
