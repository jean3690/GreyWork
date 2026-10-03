//! 迁移链：`PRAGMA user_version` 顺序推进，只追加不回头改历史项。

use rusqlite::Connection;

/// 迁移链：下标 = 目标 user_version。只追加不修改历史项。
pub(crate) const MIGRATIONS: [&str; 10] = [
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
    "
ALTER TABLE automation_tasks ADD COLUMN acp_provider_id TEXT;
ALTER TABLE automation_due ADD COLUMN acp_provider_id TEXT;
-- 周字段语义修正：v5 及以前匹配器把周字段当「周一=0」用（非标准 cron）。
-- 界面上此前没有 cron 输入，能落库的只有三个内置种子，其中仅「每周五 18:00」
-- 带周字段（值 4 表示周五）。标准 cron 里周五是 5，故就地改写；其余种子
-- 只用分/时，语义不受影响。
UPDATE automation_tasks SET cron = '0 18 * * 5' WHERE cron = '0 18 * * 4';
",
    // 一次性任务（「指定日期时间跑一次」）：cron 没有年份字段，表达不了单次触发，
    // 因此单开一列存触发时刻（epoch ms）；宿主调度器据 (once_at, last_run) 判定。
    "
ALTER TABLE automation_tasks ADD COLUMN once_at INTEGER;
",
    // ACP 后端的启动环境变量（如各家 API key）：与 command 同属启动契约，进列而不是
    // 留在渲染端。JSON 对象文本；旧行为 NULL = 继承宿主环境。
    "
ALTER TABLE agent_providers ADD COLUMN env TEXT;
",
    // 运行记录（宿主 + 渲染端两条执行路径共写）：无外键（渲染端 fire-and-forget
    // 记录可能先于任务 sync 落库），孤儿行由 sync_automations 全量替换时清理。
    "
CREATE TABLE automation_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id     TEXT NOT NULL,
    name        TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL,
    detail      TEXT,
    session_id  TEXT,
    mode        TEXT NOT NULL DEFAULT 'llm',
    ran_at      INTEGER NOT NULL
);
CREATE INDEX idx_automation_runs_task ON automation_runs(task_id, ran_at);
",
    // 本地 RAG 索引：按「授权工作区根 + 文件」存分块与向量。
    // 向量以 float32 小端 BLOB 存（dim 冗余一列便于校验模型是否换过）；mtime/size 用于增量重建。
    // 整根重建时按 root 删行，故 root 建索引；path 组合查询走同一索引前缀。
    "
CREATE TABLE rag_chunks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    root        TEXT NOT NULL,
    path        TEXT NOT NULL,
    mtime       INTEGER NOT NULL,
    size        INTEGER NOT NULL,
    chunk_index INTEGER NOT NULL,
    text        TEXT NOT NULL,
    dim         INTEGER NOT NULL,
    vec         BLOB NOT NULL
);
CREATE INDEX idx_rag_chunks_root_path ON rag_chunks(root, path);
CREATE TABLE rag_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
",
];

/// 顺序推进 user_version 到 MIGRATIONS.len()。
pub(crate) fn migrate(conn: &mut Connection) -> rusqlite::Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    for (index, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
        conn.execute_batch(sql)?;
        let next = (index + 1) as i64;
        conn.execute_batch(&format!("PRAGMA user_version = {next}"))?;
    }
    Ok(())
}
