/**
 * 数据面：SQLite（`node:sqlite`，Node 22+ 内置，免原生编译）。
 *
 * 迁移链与 `crates/greywork-host/src/infra/db/schema.rs` **逐条一致**（10 版、只追加不回头改），
 * PRAGMA 也同为 WAL / foreign_keys / busy_timeout=2000。这样两个宿主可以先后打开同一个
 * `greywork.db` 而不会互相把 schema 版本拽回去 —— 迁移期最怕的就是这个。
 *
 * P1 只迁 setttings 的两条命令（meta 表单键值），其余表先建好、留给后续阶段读写。
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** 迁移链：下标 = 目标 user_version，只追加不修改历史项。 */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE conversations (
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
);`,
  `CREATE TABLE automation_tasks (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL DEFAULT '',
    schedule  TEXT NOT NULL DEFAULT '',
    cron      TEXT,
    target    TEXT NOT NULL DEFAULT '',
    intent    TEXT NOT NULL DEFAULT '',
    enabled   INTEGER NOT NULL DEFAULT 0,
    last_run  INTEGER NOT NULL DEFAULT 0
);`,
  `CREATE TABLE team_runs (
    id       TEXT PRIMARY KEY,
    payload  TEXT NOT NULL
);`,
  `CREATE TABLE agent_providers (
    id       TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    kind     TEXT NOT NULL,
    command  TEXT NOT NULL,
    enabled  INTEGER NOT NULL DEFAULT 0
);`,
  `CREATE TABLE automation_due (
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
CREATE INDEX idx_automation_due_pending ON automation_due(status, due_at);`,
  `ALTER TABLE automation_tasks ADD COLUMN acp_provider_id TEXT;
ALTER TABLE automation_due ADD COLUMN acp_provider_id TEXT;
UPDATE automation_tasks SET cron = '0 18 * * 5' WHERE cron = '0 18 * * 4';`,
  `ALTER TABLE automation_tasks ADD COLUMN once_at INTEGER;`,
  `ALTER TABLE agent_providers ADD COLUMN env TEXT;`,
  `CREATE TABLE automation_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id     TEXT NOT NULL,
    name        TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL,
    detail      TEXT,
    session_id  TEXT,
    mode        TEXT NOT NULL DEFAULT 'llm',
    ran_at      INTEGER NOT NULL
);
CREATE INDEX idx_automation_runs_task ON automation_runs(task_id, ran_at);`,
  `CREATE TABLE rag_chunks (
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
);`,
];

export class Db {
  private readonly conn: DatabaseSync;

  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.conn = new DatabaseSync(file);
    this.conn.exec(`PRAGMA journal_mode = WAL;
                    PRAGMA foreign_keys = ON;
                    PRAGMA busy_timeout = 2000;`);
    this.migrate();
  }

  private migrate(): void {
    const version = Number(this.conn.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    for (let index = version; index < MIGRATIONS.length; index += 1) {
      this.conn.exec(MIGRATIONS[index]);
      this.conn.exec(`PRAGMA user_version = ${index + 1}`);
    }
  }

  schemaVersion(): number {
    return Number(this.conn.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  }

  /** 设置快照：整对象读写；没有记录时回 null（与 Rust 的 Option<Value> 一致）。 */
  loadSettings(): unknown | null {
    const row = this.conn.prepare("SELECT value FROM meta WHERE key = 'settings'").get() as { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch (error) {
      throw new Error(`解析设置 JSON 失败: ${(error as Error).message}`, { cause: error });
    }
  }

  /** 全量替换设置快照：upsert，没有接管标记语义（空对象也合法）。 */
  syncSettings(settings: unknown): void {
    const payload = JSON.stringify(settings);
    this.conn.prepare("INSERT INTO meta (key, value) VALUES ('settings', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").run(payload);
  }

  close(): void {
    this.conn.close();
  }
}
