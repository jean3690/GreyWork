//! 建库与生命周期：打开连接、PRAGMA、迁移推进、schema 版本查询。

use parking_lot::Mutex;
use rusqlite::Connection;
use std::path::Path;

use super::schema::migrate;
use super::Db;

impl Db {
    pub fn open_at(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建数据目录失败: {e}"))?;
        }
        let conn = Connection::open(path).map_err(|e| format!("打开数据库失败: {e}"))?;
        Self::with_connection(conn)
    }

    /// 内存库：WAL 对 memory 库退化为 memory 模式，不报错。
    ///
    /// 供各 crate 的测试使用（桌面壳的 `#[cfg(test)]` 看不到本 crate 的 `cfg(test)` 项，
    /// 故不门控）。生产路径一律走 `open_at`。
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

    pub fn schema_version(&self) -> Result<i64, String> {
        let conn = self.conn.lock();
        conn.query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|e| format!("读取 schema 版本失败: {e}"))
    }
}
