//! 本地 RAG 索引的库侧读写：按「授权工作区根 + 文件」存分块与向量。

use rusqlite::{params, OptionalExtension};
use std::collections::HashMap;

use super::dto::{RagChunkDto, RagChunkRow};
use super::Db;

impl Db {
    pub fn rag_file_stats(&self, root: &str) -> Result<HashMap<String, (i64, i64)>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT path, MAX(mtime), MAX(size) FROM rag_chunks WHERE root = ?1 GROUP BY path",
            )
            .map_err(|e| format!("准备 RAG 文件统计失败: {e}"))?;
        let rows = stmt
            .query_map(params![root], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .map_err(|e| format!("查询 RAG 文件统计失败: {e}"))?;
        let mut stats = HashMap::new();
        for row in rows {
            let (path, mtime, size) = row.map_err(|e| format!("读取 RAG 统计行失败: {e}"))?;
            stats.insert(path, (mtime, size));
        }
        Ok(stats)
    }

    /// 用一个文件的新分块整体替换它在库里的行（事务；先删后插保证原子）。
    pub fn rag_replace_file(
        &self,
        root: &str,
        path: &str,
        mtime: i64,
        size: i64,
        chunks: &[RagChunkDto],
    ) -> Result<(), String> {
        let mut conn = self.conn.lock();
        let tx = conn
            .transaction()
            .map_err(|e| format!("开启 RAG 事务失败: {e}"))?;
        tx.execute(
            "DELETE FROM rag_chunks WHERE root = ?1 AND path = ?2",
            params![root, path],
        )
        .map_err(|e| format!("清理旧 RAG 分块失败: {e}"))?;
        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO rag_chunks (root, path, mtime, size, chunk_index, text, dim, vec)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                )
                .map_err(|e| format!("准备 RAG 插入失败: {e}"))?;
            for chunk in chunks {
                stmt.execute(params![
                    root,
                    path,
                    mtime,
                    size,
                    chunk.chunk_index,
                    chunk.text,
                    chunk.vec.len() as i64,
                    f32s_to_blob(&chunk.vec),
                ])
                .map_err(|e| format!("写入 RAG 分块失败: {e}"))?;
            }
        }
        tx.commit().map_err(|e| format!("提交 RAG 事务失败: {e}"))
    }

    /// 删掉某根下**不在 keep 集合里**的文件行（清理已删除 / 改名的文件）。返回删除的路径数。
    pub fn rag_prune_files(&self, root: &str, keep: &[String]) -> Result<usize, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT DISTINCT path FROM rag_chunks WHERE root = ?1")
            .map_err(|e| format!("准备 RAG 清理查询失败: {e}"))?;
        let rows = stmt
            .query_map(params![root], |row| row.get::<_, String>(0))
            .map_err(|e| format!("查询 RAG 待清理路径失败: {e}"))?;
        let mut stale = Vec::new();
        for row in rows {
            let path = row.map_err(|e| format!("读取 RAG 路径失败: {e}"))?;
            if !keep.iter().any(|kept| kept == &path) {
                stale.push(path);
            }
        }
        for path in &stale {
            conn.execute(
                "DELETE FROM rag_chunks WHERE root = ?1 AND path = ?2",
                params![root, path],
            )
            .map_err(|e| format!("清理 RAG 过期文件失败: {e}"))?;
        }
        Ok(stale.len())
    }

    /// 清空整张 RAG 索引与元信息（换 embedding 模型时用）。
    pub fn rag_clear(&self) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM rag_chunks", [])
            .map_err(|e| format!("清空 RAG 索引失败: {e}"))?;
        conn.execute("DELETE FROM rag_meta", [])
            .map_err(|e| format!("清空 RAG 元信息失败: {e}"))?;
        Ok(())
    }

    /// 载入全部块（可选按根过滤），供内存索引缓存。
    pub fn rag_load_chunks(&self, root: Option<&str>) -> Result<Vec<RagChunkRow>, String> {
        let conn = self.conn.lock();
        let (sql, filter) = match root {
            Some(_) => (
                "SELECT path, chunk_index, text, vec FROM rag_chunks WHERE root = ?1",
                Some(root.unwrap_or_default().to_string()),
            ),
            None => ("SELECT path, chunk_index, text, vec FROM rag_chunks", None),
        };
        let mut stmt = conn
            .prepare(sql)
            .map_err(|e| format!("准备 RAG 载入失败: {e}"))?;
        let map_row = |row: &rusqlite::Row<'_>| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Vec<u8>>(3)?,
            ))
        };
        let mut items = Vec::new();
        let mut push = |row: (String, i64, String, Vec<u8>)| {
            items.push(RagChunkRow {
                path: row.0,
                chunk_index: row.1,
                text: row.2,
                vec: blob_to_f32s(&row.3),
            });
        };
        match filter {
            Some(root) => {
                let rows = stmt
                    .query_map(params![root], map_row)
                    .map_err(|e| format!("查询 RAG 分块失败: {e}"))?;
                for row in rows {
                    push(row.map_err(|e| format!("读取 RAG 分块失败: {e}"))?);
                }
            }
            None => {
                let rows = stmt
                    .query_map([], map_row)
                    .map_err(|e| format!("查询 RAG 分块失败: {e}"))?;
                for row in rows {
                    push(row.map_err(|e| format!("读取 RAG 分块失败: {e}"))?);
                }
            }
        }
        Ok(items)
    }

    /// (分块数, 文件数)。
    pub fn rag_stats(&self) -> Result<(i64, i64), String> {
        let conn = self.conn.lock();
        let chunks: i64 = conn
            .query_row("SELECT COUNT(*) FROM rag_chunks", [], |row| row.get(0))
            .map_err(|e| format!("统计 RAG 分块失败: {e}"))?;
        let files: i64 = conn
            .query_row(
                "SELECT COUNT(DISTINCT root || '/' || path) FROM rag_chunks",
                [],
                |row| row.get(0),
            )
            .map_err(|e| format!("统计 RAG 文件失败: {e}"))?;
        Ok((chunks, files))
    }

    pub fn rag_meta_get(&self, key: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT value FROM rag_meta WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("读取 RAG 元信息失败: {e}"))
    }

    pub fn rag_meta_set(&self, key: &str, value: &str) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO rag_meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )
        .map_err(|e| format!("写入 RAG 元信息失败: {e}"))?;
        Ok(())
    }
}
/// f32 slice → 小端 BLOB。
fn f32s_to_blob(values: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(values.len() * 4);
    for value in values {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
}

/// 小端 BLOB → f32。尾部不足 4 字节的残片丢弃（写入侧不会产生，纯防御）。
fn blob_to_f32s(bytes: &[u8]) -> Vec<f32> {
    bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|chunk| f32::from_le_bytes(*chunk))
        .collect()
}
