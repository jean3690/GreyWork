/**
 * 本地 RAG：授权工作区文本 → 分块 → 本地 embedding → SQLite 持久化 → 暴力余弦检索。
 * 移植 `crates/greywork-host/src/services/rag/`。
 *
 * 与 Rust 同一套口径：
 * - 只索引授权根内的文本文件（扩展名白名单 + 二进制嗅探双保险），不跟随符号链接；
 * - 向量以 float32 小端 BLOB 存 SQLite；检索在内存缓存上暴力余弦（首次懒加载，
 *   构建 / 清空后失效）；
 * - 单文件失败只跳过并清掉旧分块，不中断整次构建；进度经 `rag://event` 广播。
 */
import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { embed } from "./llm.js";
import type { Db } from "./db.js";
import type { WorkspaceAccess } from "./workspace-access.js";
import { looksBinary, readPrefix } from "./text-probe.js";
import type { EventBus } from "./events.js";

const MAX_FILE_BYTES = 1024 * 1024;
const CHUNK_CHARS = 1200;
const CHUNK_OVERLAP = 200;
const EMBED_BATCH = 32;
const MAX_DIRS = 4096;
const MAX_FILES = 20_000;
const META_MODEL = "rag.embedding.model";

const IGNORE_DIRS = new Set([
  "node_modules",
  "target",
  "dist",
  "build",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".nuxt",
  "vendor",
  "coverage",
  ".git",
  ".idea",
  ".vscode",
  ".gradle",
  ".cache",
  ".pnpm-store",
]);
const TEXT_FILENAMES = new Set(["dockerfile", "makefile", "cmakelists.txt", "procfile", "license", "readme"]);
const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "rst",
  "adoc",
  "log",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "env",
  "properties",
  "xml",
  "html",
  "htm",
  "css",
  "scss",
  "sass",
  "less",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "mts",
  "cts",
  "vue",
  "svelte",
  "astro",
  "py",
  "pyi",
  "rb",
  "php",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "bat",
  "cmd",
  "sql",
  "graphql",
  "proto",
  "toml",
  "hcl",
  "dockerfile",
  "gitignore",
  "editorconfig",
]);

interface FileEntry {
  path: string;
  size: number;
  mtime: number;
}

export interface RagHit {
  path: string;
  chunkIndex: number;
  text: string;
  score: number;
}

function isIndexableName(name: string): boolean {
  const lower = name.toLowerCase();
  if (TEXT_FILENAMES.has(lower)) return true;
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return false;
  return TEXT_EXTENSIONS.has(lower.slice(dot + 1));
}

function tailChars(value: string, n: number): string {
  const chars = [...value];
  if (chars.length <= n) return "";
  return chars.slice(chars.length - n).join("");
}

/** 按行聚合分块：每块目标 1200 字符，相邻块重叠 200 字符（不足则不重叠）。 */
export function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let current = "";
  // 与 Rust 的 str::lines() 同语义：按 \n 切、剥行尾 \r，且丢弃「以 \n 结尾」产生的末尾空行。
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const lineLen = [...line].length;
    if (current !== "" && [...current].length + lineLen + 1 > CHUNK_CHARS) {
      const finished = current;
      current = tailChars(finished, CHUNK_OVERLAP);
      chunks.push(finished);
    }
    current += line + "\n";
  }
  if (current.trim() !== "") chunks.push(current);
  return chunks;
}

/** 递归收集可索引文本文件：不跟随符号链接，跳过黑名单目录 / 空文件 / 超大文件 / 二进制。 */
export function collectFiles(root: string): FileEntry[] {
  const out: FileEntry[] = [];
  const stack = [root];
  let dirs = 0;
  while (stack.length > 0) {
    if (dirs >= MAX_DIRS || out.length >= MAX_FILES) break;
    const dir = stack.pop() as string;
    dirs += 1;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (out.length >= MAX_FILES) break;
      const filePath = path.join(dir, name);
      let lstat;
      try {
        lstat = lstatSync(filePath);
      } catch {
        continue;
      }
      if (lstat.isSymbolicLink()) continue;
      if (lstat.isDirectory()) {
        if (name.startsWith(".") || [...IGNORE_DIRS].some((ignored) => ignored.toLowerCase() === name.toLowerCase())) {
          continue;
        }
        stack.push(filePath);
        continue;
      }
      if (!lstat.isFile() || !isIndexableName(name)) continue;
      if (lstat.size === 0 || lstat.size > MAX_FILE_BYTES) continue;
      try {
        if (looksBinary(readPrefix(filePath, 1024))) continue;
      } catch {
        continue;
      }
      const mtime = Math.floor(lstat.mtimeMs / 1000);
      out.push({ path: filePath, size: lstat.size, mtime });
    }
  }
  return out;
}

/** 检索索引缓存：首次从库懒加载，向量 L2 归一化后按行主序拼进一块 arena（点积即余弦）。 */
export class RagIndexHost {
  private cache: { rows: { path: string; chunkIndex: number; text: string; unit: number[] }[]; dim: number } | null = null;

  constructor(private readonly db: Db) {}

  invalidate(): void {
    this.cache = null;
  }

  load(): { rows: { path: string; chunkIndex: number; text: string; unit: number[] }[]; dim: number } {
    if (this.cache) return this.cache;
    const rows = this.db.ragLoadChunks(null).map((row) => {
      const floats = new Float32Array(row.vec.buffer, row.vec.byteOffset, row.vec.byteLength / 4);
      let norm = 0;
      for (const value of floats) norm += value * value;
      norm = Math.sqrt(norm);
      const unit = norm > 0 ? [...floats].map((value) => value / norm) : [];
      return { path: row.path, chunkIndex: row.chunkIndex, text: row.text, unit };
    });
    this.cache = { rows, dim: rows[0]?.unit.length ?? 0 };
    return this.cache;
  }
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** 构建指定授权根的向量索引（增量：mtime/size 未变跳过）。 */
export async function ragIndexBuild(
  bus: EventBus,
  access: WorkspaceAccess,
  db: Db,
  rag: RagIndexHost,
  args: {
    root: string;
    baseUrl: string;
    model: string;
    apiKeyEnv?: string | null;
    headers?: Record<string, string>;
    force?: boolean;
  },
): Promise<{ files: number; chunks: number; skipped: number }> {
  const rootPath = access.resolveExisting(args.root);
  if (!statSync(rootPath).isDirectory()) throw new Error("索引根必须是目录");
  if (args.baseUrl.trim() === "" || args.model.trim() === "") {
    throw new Error("base_url and model are required");
  }
  const root = rootPath;
  const model = args.model.trim();

  // embedding 模型换过 → 整库失效（不同模型的向量不可比）。
  const storedModel = db.ragMetaGet(META_MODEL);
  const force = args.force === true || (storedModel !== null && storedModel !== model);
  if (force) {
    db.ragClear();
    rag.invalidate();
  }
  db.ragMetaSet(META_MODEL, model);

  const files = collectFiles(rootPath);
  const existing = force ? new Map<string, { mtime: number; size: number }>() : db.ragFileStats(root);
  const total = files.length;
  const progress = (done: number) => bus.broadcast("rag://event", { kind: "progress", done, total });

  const kept: string[] = [];
  let chunkCount = 0;
  let skipped = 0;
  let dim: number | null = null;
  let done = 0;
  progress(0);

  for (const file of files) {
    kept.push(file.path);
    done += 1;
    const unchanged = !force && existing.get(file.path)?.mtime === file.mtime && existing.get(file.path)?.size === file.size;
    if (unchanged) {
      skipped += 1;
      progress(done);
      continue;
    }
    try {
      const bytes = readFileSync(file.path);
      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      const chunks = chunkText(text);
      if (chunks.length === 0) {
        db.ragReplaceFile(root, file.path, file.mtime, file.size, []);
        progress(done);
        continue;
      }
      let fileDim: number | null = null;
      const rows: { chunkIndex: number; text: string; vec: Buffer }[] = [];
      for (let batchIndex = 0; batchIndex < chunks.length; batchIndex += EMBED_BATCH) {
        const batch = chunks.slice(batchIndex, batchIndex + EMBED_BATCH);
        const result = await embed({
          baseUrl: args.baseUrl,
          model,
          apiKeyEnv: args.apiKeyEnv ?? null,
          headers: args.headers,
          input: batch,
        });
        if (result.embeddings.length !== batch.length) {
          throw new Error(`embedding 返回数量与输入不符：${result.embeddings.length} vs ${batch.length}`);
        }
        fileDim = result.dim;
        batch.forEach((textChunk, offset) => {
          const vec = result.embeddings[batchIndex === 0 ? offset : (batchIndex / EMBED_BATCH) * EMBED_BATCH + offset];
          rows.push({
            chunkIndex: batchIndex + offset,
            text: textChunk,
            vec: Buffer.from(new Float32Array(vec).buffer),
          });
        });
      }
      chunkCount += rows.length;
      if (fileDim !== null) dim = fileDim;
      db.ragReplaceFile(root, file.path, file.mtime, file.size, rows);
    } catch (error) {
      // 失败即视为未索引：清掉旧行，避免检索命中过期内容。
      console.warn(`[host-node] rag 跳过文件 ${file.path}: ${(error as Error).message}`);
      db.ragReplaceFile(root, file.path, 0, 0, []);
    }
    progress(done);
  }

  const pruned = db.ragPruneFiles(root, kept);
  if (dim !== null) db.ragMetaSet("rag.embedding.dim", String(dim));
  rag.invalidate();
  bus.broadcast("rag://event", { kind: "done", files: total, chunks: chunkCount, skipped, pruned });
  return { files: total, chunks: chunkCount, skipped };
}

/** 检索：query 取向量，与内存索引暴力余弦，top-K。 */
export async function ragSearch(
  rag: RagIndexHost,
  args: {
    query: string;
    baseUrl: string;
    model: string;
    apiKeyEnv?: string | null;
    headers?: Record<string, string>;
    topK?: unknown;
  },
): Promise<RagHit[]> {
  const query = args.query.trim();
  if (query === "") return [];
  if (args.baseUrl.trim() === "" || args.model.trim() === "") {
    throw new Error("base_url and model are required");
  }
  const result = await embed({
    baseUrl: args.baseUrl,
    model: args.model,
    apiKeyEnv: args.apiKeyEnv ?? null,
    headers: args.headers,
    input: [query],
  });
  const queryVec = result.embeddings[0];
  if (!queryVec) return [];

  const index = rag.load();
  const topK = Math.min(Math.max(typeof args.topK === "number" ? args.topK : 6, 1), 50);
  const norm = Math.sqrt(queryVec.reduce((acc, value) => acc + value * value, 0));
  const unitQuery = norm > 0 ? queryVec.map((value) => value / norm) : queryVec;
  const scored = index.rows.map((row, idx) => {
    let score = 0;
    if (row.unit.length === unitQuery.length && norm > 0) {
      for (let i = 0; i < unitQuery.length; i += 1) score += unitQuery[i] * row.unit[i];
    } else {
      score = cosine(unitQuery, row.unit);
    }
    return { score, idx };
  });
  scored.sort((left, right) => right.score - left.score);
  return scored.slice(0, topK).map(({ score, idx }) => {
    const row = index.rows[idx];
    return { path: row.path, chunkIndex: row.chunkIndex, text: row.text, score };
  });
}
