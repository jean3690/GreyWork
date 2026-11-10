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

export interface AgentProvider {
  id: string;
  name: string;
  kind: string;
  command: string;
  enabled: boolean;
  env?: string | null;
}

export interface AutomationTask {
  id: string;
  name: string;
  schedule: string;
  cron: string | null;
  /** 展示用调度描述之外的可选字段：与 Rust 的 camelCase 输出一致。 */
  target: string;
  intent: string;
  enabled: boolean;
  lastRun: number | null;
  acpProviderId: string | null;
  onceAt: number | null;
}

interface AutomationTaskRow {
  id: string;
  name: string;
  schedule: string;
  cron: string | null;
  target: string;
  intent: string;
  enabled: number;
  last_run: number | null;
  acp_provider_id: string | null;
  once_at: number | null;
}

export interface AutomationDue {
  id: number;
  taskId: string;
  name: string;
  target: string;
  intent: string;
  acpProviderId: string | null;
  dueAt: number;
}

export interface AutomationRun {
  id: number;
  taskId: string;
  name: string;
  status: string;
  detail: string | null;
  sessionId: string | null;
  mode: string;
  ranAt: number;
}

export interface AutomationRunInput {
  taskId: string;
  name: string;
  status: string;
  detail?: string | null;
  sessionId?: string | null;
  mode: string;
  ranAt: number;
}

export interface TeamRun {
  id: string;
  payload: unknown;
}

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

  /** ACP 后端目录：未接管（无 marker）→ null，与 Rust 的 Option<Vec<_>> 一致。 */
  loadAgentProviders(): AgentProvider[] | null {
    const marker = this.conn.prepare("SELECT value FROM meta WHERE key = 'agent_providers_initialized'").get() as
      { value?: string } | undefined;
    if (!marker) return null;
    const rows = this.conn.prepare("SELECT id, name, kind, command, enabled, env FROM agent_providers ORDER BY rowid").all() as {
      id: string;
      name: string;
      kind: string;
      command: string;
      enabled: number;
      env: string | null;
    }[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      command: row.command,
      enabled: row.enabled !== 0,
      env: row.env,
    }));
  }

  /**
   * 已启用 ACP 后端的启动程序名（spawn 白名单扩展面）。
   *
   * 取每条启用后端命令首 token 的 basename（`npx -y pkg` → `npx`，`/usr/bin/x --acp` → `x`），
   * 供 `acp_start` 在内置白名单之外放行用户自配的 agent。未接管目录 / 无启用项 → 空数组。
   * 与 Rust `infra/db/agents.rs::enabled_agent_programs` 同语义：只收敛「能被启动的程序面」，
   * shell 元字符拒绝仍由 validateSpawnCommand 生效。
   */
  enabledAgentPrograms(): string[] {
    const providers = this.loadAgentProviders();
    if (!providers) return [];
    const programs: string[] = [];
    for (const provider of providers) {
      if (!provider.enabled) continue;
      const program = provider.command.trim().split(/\s+/)[0] ?? "";
      const base = path.basename(program);
      if (base !== "") programs.push(base);
    }
    return programs;
  }

  /** 全量替换 ACP 后端目录（事务；首次写接管标记）。 */
  syncAgentProviders(providers: AgentProvider[]): void {
    this.conn.exec("BEGIN");
    try {
      this.conn.prepare("INSERT INTO meta (key, value) VALUES ('agent_providers_initialized', '1') ON CONFLICT(key) DO NOTHING").run();
      const existing = this.conn.prepare("SELECT id FROM agent_providers").all() as { id: string }[];
      const kept = new Set(providers.map((provider) => provider.id));
      const remove = this.conn.prepare("DELETE FROM agent_providers WHERE id = ?1");
      for (const row of existing) {
        if (!kept.has(row.id)) remove.run(row.id);
      }
      const upsert = this.conn.prepare(
        `INSERT INTO agent_providers (id, name, kind, command, enabled, env)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET name = ?2, kind = ?3, command = ?4, enabled = ?5, env = ?6`,
      );
      for (const provider of providers) {
        upsert.run(provider.id, provider.name, provider.kind, provider.command, provider.enabled ? 1 : 0, provider.env ?? null);
      }
      this.conn.exec("COMMIT");
    } catch (error) {
      this.conn.exec("ROLLBACK");
      throw new Error(`写入后端目录失败: ${(error as Error).message}`, { cause: error });
    }
  }

  /** 自动化任务：未接管 → null；否则按 rowid 顺序返回。 */
  loadAutomations(): AutomationTask[] | null {
    if (!this.marker("automation_initialized")) return null;
    const rows = this.conn
      .prepare(
        `SELECT id, name, schedule, cron, target, intent, enabled, last_run, acp_provider_id, once_at
         FROM automation_tasks ORDER BY rowid`,
      )
      .all() as unknown as AutomationTaskRow[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      schedule: row.schedule,
      cron: row.cron,
      target: row.target,
      intent: row.intent,
      enabled: row.enabled !== 0,
      // last_run 是 NOT NULL DEFAULT 0（非 Option）：与 Rust 的 i64 一致，回 0 而不是 null。
      lastRun: row.last_run ?? 0,
      acpProviderId: row.acp_provider_id,
      onceAt: row.once_at,
    }));
  }

  /** 全量替换自动化任务；同时清掉孤儿运行记录（无外键，需显式删）。 */
  syncAutomations(tasks: AutomationTask[]): void {
    this.conn.exec("BEGIN");
    try {
      this.conn.prepare("INSERT INTO meta (key, value) VALUES ('automation_initialized', '1') ON CONFLICT(key) DO NOTHING").run();
      const existing = this.conn.prepare("SELECT id FROM automation_tasks").all() as { id: string }[];
      const kept = new Set(tasks.map((task) => task.id));
      const remove = this.conn.prepare("DELETE FROM automation_tasks WHERE id = ?1");
      for (const row of existing) {
        if (!kept.has(row.id)) remove.run(row.id);
      }
      const upsert = this.conn.prepare(
        `INSERT INTO automation_tasks (id, name, schedule, cron, target, intent, enabled, last_run, acp_provider_id, once_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(id) DO UPDATE SET
           name = ?2, schedule = ?3, cron = ?4, target = ?5,
           intent = ?6, enabled = ?7, last_run = ?8, acp_provider_id = ?9, once_at = ?10`,
      );
      for (const task of tasks) {
        upsert.run(
          task.id,
          task.name,
          task.schedule,
          task.cron ?? null,
          task.target,
          task.intent,
          task.enabled ? 1 : 0,
          task.lastRun ?? 0,
          task.acpProviderId ?? null,
          task.onceAt ?? null,
        );
      }
      this.conn.prepare("DELETE FROM automation_runs WHERE task_id NOT IN (SELECT id FROM automation_tasks)").run();
      this.conn.exec("COMMIT");
    } catch (error) {
      this.conn.exec("ROLLBACK");
      throw new Error(`写入自动化失败: ${(error as Error).message}`, { cause: error });
    }
  }

  /** 可执行到期队列：pending 且 due_at 在最近 60 分钟内（更早的由 sweep 清掉，不执行）。 */
  automationDueList(): AutomationDue[] {
    const cutoff = Date.now() - 3_600_000;
    const rows = this.conn
      .prepare(
        `SELECT id, task_id, name, target, intent, acp_provider_id, due_at FROM automation_due
         WHERE status = 'pending' AND due_at >= ?1 ORDER BY due_at, id`,
      )
      .all(cutoff) as {
      id: number;
      task_id: string;
      name: string;
      target: string;
      intent: string;
      acp_provider_id: string | null;
      due_at: number;
    }[];
    return rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      name: row.name,
      target: row.target,
      intent: row.intent,
      acpProviderId: row.acp_provider_id,
      dueAt: row.due_at,
    }));
  }

  /** 认领完成：pending → 终态（原子条件更新，防双执行者双跑）；返回是否认领成功。 */
  automationDueFinish(id: number, status: string): boolean {
    const result = this.conn
      .prepare("UPDATE automation_due SET status = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'pending'")
      .run(id, status, Date.now());
    return Number(result.changes) > 0;
  }

  /** 运行记录：新→旧，最多 limit 条。 */
  automationRunsLoad(limit: number): AutomationRun[] {
    const rows = this.conn
      .prepare(
        `SELECT id, task_id, name, status, detail, session_id, mode, ran_at
         FROM automation_runs ORDER BY ran_at DESC, id DESC LIMIT ?1`,
      )
      .all(limit) as {
      id: number;
      task_id: string;
      name: string;
      status: string;
      detail: string | null;
      session_id: string | null;
      mode: string;
      ran_at: number;
    }[];
    return rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      name: row.name,
      status: row.status,
      detail: row.detail,
      sessionId: row.session_id,
      mode: row.mode,
      ranAt: row.ran_at,
    }));
  }

  /** 记一条运行结果；写入后按 task 裁剪，只留最近 50 条。 */
  automationRunRecord(run: AutomationRunInput): void {
    this.conn
      .prepare(
        `INSERT INTO automation_runs (task_id, name, status, detail, session_id, mode, ran_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .run(run.taskId, run.name, run.status, run.detail ?? null, run.sessionId ?? null, run.mode, run.ranAt);
    this.conn
      .prepare(
        `DELETE FROM automation_runs WHERE task_id = ?1 AND id NOT IN (
           SELECT id FROM automation_runs WHERE task_id = ?1 ORDER BY ran_at DESC, id DESC LIMIT 50
         )`,
      )
      .run(run.taskId);
  }

  loadTeamRuns(): TeamRun[] | null {
    if (!this.marker("team_runs_initialized")) return null;
    const rows = this.conn.prepare("SELECT id, payload FROM team_runs ORDER BY rowid").all() as {
      id: string;
      payload: string;
    }[];
    return rows.map((row) => ({ id: row.id, payload: JSON.parse(row.payload) }));
  }

  syncTeamRuns(runs: TeamRun[]): void {
    this.conn.exec("BEGIN");
    try {
      this.conn.prepare("INSERT INTO meta (key, value) VALUES ('team_runs_initialized', '1') ON CONFLICT(key) DO NOTHING").run();
      const existing = this.conn.prepare("SELECT id FROM team_runs").all() as { id: string }[];
      const kept = new Set(runs.map((run) => run.id));
      const remove = this.conn.prepare("DELETE FROM team_runs WHERE id = ?1");
      for (const row of existing) {
        if (!kept.has(row.id)) remove.run(row.id);
      }
      const upsert = this.conn.prepare("INSERT INTO team_runs (id, payload) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET payload = ?2");
      for (const run of runs) upsert.run(run.id, JSON.stringify(run.payload));
      this.conn.exec("COMMIT");
    } catch (error) {
      this.conn.exec("ROLLBACK");
      throw new Error(`写入存档失败: ${(error as Error).message}`, { cause: error });
    }
  }

  /** 按根统计每文件最新 mtime/size（增量索引用）。 */
  ragFileStats(root: string): Map<string, { mtime: number; size: number }> {
    const rows = this.conn
      .prepare("SELECT path, MAX(mtime) AS mtime, MAX(size) AS size FROM rag_chunks WHERE root = ?1 GROUP BY path")
      .all(root) as { path: string; mtime: number; size: number }[];
    return new Map(rows.map((row) => [row.path, { mtime: Number(row.mtime), size: Number(row.size) }]));
  }

  /** 替换某文件的分块（事务内先删后插）；空数组 = 该文件没有可索引内容。 */
  ragReplaceFile(
    root: string,
    filePath: string,
    mtime: number,
    size: number,
    chunks: { chunkIndex: number; text: string; vec: Buffer }[],
  ): void {
    this.conn.exec("BEGIN");
    try {
      this.conn.prepare("DELETE FROM rag_chunks WHERE root = ?1 AND path = ?2").run(root, filePath);
      const insert = this.conn.prepare(
        `INSERT INTO rag_chunks (root, path, mtime, size, chunk_index, text, dim, vec)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      );
      for (const chunk of chunks) {
        const dim = chunk.vec.byteLength / 4;
        insert.run(root, filePath, mtime, size, chunk.chunkIndex, chunk.text, dim, chunk.vec);
      }
      this.conn.exec("COMMIT");
    } catch (error) {
      this.conn.exec("ROLLBACK");
      throw new Error(`写入 RAG 分块失败: ${(error as Error).message}`, { cause: error });
    }
  }

  /** 清理不在 keep 集合里的路径（文件被删 / 改名）；返回清理条数。 */
  ragPruneFiles(root: string, keep: string[]): number {
    const kept = new Set(keep);
    const rows = this.conn.prepare("SELECT DISTINCT path FROM rag_chunks WHERE root = ?1").all(root) as { path: string }[];
    const stale = rows.map((row) => row.path).filter((filePath) => !kept.has(filePath));
    if (stale.length === 0) return 0;
    this.conn.exec("BEGIN");
    try {
      const remove = this.conn.prepare("DELETE FROM rag_chunks WHERE root = ?1 AND path = ?2");
      for (const filePath of stale) remove.run(root, filePath);
      this.conn.exec("COMMIT");
    } catch (error) {
      this.conn.exec("ROLLBACK");
      throw new Error(`清理 RAG 过期文件失败: ${(error as Error).message}`, { cause: error });
    }
    return stale.length;
  }

  /** 载入全部块（可选按根过滤），vec 是 float32 小端 BLOB。 */
  ragLoadChunks(root: string | null): { path: string; chunkIndex: number; text: string; vec: Buffer }[] {
    const rows = (
      root !== null
        ? this.conn.prepare("SELECT path, chunk_index, text, vec FROM rag_chunks WHERE root = ?1").all(root)
        : this.conn.prepare("SELECT path, chunk_index, text, vec FROM rag_chunks").all()
    ) as { path: string; chunk_index: number; text: string; vec: Buffer }[];
    return rows.map((row) => ({ path: row.path, chunkIndex: row.chunk_index, text: row.text, vec: Buffer.from(row.vec) }));
  }

  ragMetaSet(key: string, value: string): void {
    this.conn
      .prepare("INSERT INTO rag_meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  ragStats(): { chunks: number; files: number } {
    const chunks = this.conn.prepare("SELECT COUNT(*) AS n FROM rag_chunks").get() as { n: number };
    const files = this.conn.prepare("SELECT COUNT(DISTINCT root || '/' || path) AS n FROM rag_chunks").get() as { n: number };
    return { chunks: Number(chunks.n), files: Number(files.n) };
  }

  ragMetaGet(key: string): string | null {
    const row = this.conn.prepare("SELECT value FROM rag_meta WHERE key = ?1").get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  ragClear(): void {
    this.conn.prepare("DELETE FROM rag_chunks").run();
    this.conn.prepare("DELETE FROM rag_meta").run();
  }

  private marker(key: string): boolean {
    const row = this.conn.prepare("SELECT value FROM meta WHERE key = ?1").get(key) as { value?: string } | undefined;
    return row !== undefined;
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
