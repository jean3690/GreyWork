/**
 * 工作区 Git（只读四条：status / changes / diff / current_branch）。
 *
 * 与 `crates/greywork-host/src/infra/git/` 同边界：
 * - 先经授权面 `resolveExisting` 解析根目录，渲染端不能拿任意路径跑 `git -C`；
 * - 参数一律 argv 数组（无 shell 拼接），根目录经 `cwd` 指定；
 * - `GIT_TERMINAL_PROMPT=0`（绝不挂起等输入）+ `GIT_OPTIONAL_LOCKS=0`（只读不搬锁文件）；
 * - `-c core.quotepath=false`（路径按 UTF-8 原样输出）与 `-c color.ui=never`（前端自行着色）；
 * - 30s 上限，到点杀进程组 —— 巨型仓库里卡死的 git 不能把 UI 变成永久转圈。
 */
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";

import type { WorkspaceAccess } from "./workspace-access.js";

const GIT_TIMEOUT_MS = 30_000;

export interface GitStatusItem {
  path: string;
  status: string;
  staged: boolean;
}

export interface GitChangeItem {
  path: string;
  oldPath: string | null;
  index: string | null;
  worktree: string | null;
  stagedAdd: number;
  stagedDel: number;
  add: number;
  del: number;
}

interface StatusRecord {
  path: string;
  oldPath: string | null;
  index: string;
  worktree: string;
}

/** 在授权根内跑 git；非零退出回 stderr（去尾空白），空则回 stdout。 */
export async function runGit(root: string, args: string[]): Promise<string> {
  const full = ["-c", "core.quotepath=false", "-c", "color.ui=never", ...args];
  return new Promise((resolve, reject) => {
    const child = spawn("git", full, {
      cwd: root,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === "win32") child.kill();
        else process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill();
      }
    }, GIT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`无法启动 git: ${error.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`命令超时（超过 ${GIT_TIMEOUT_MS / 1000} 秒未返回），已中止执行`));
        return;
      }
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8").trimEnd();
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr === "" ? stdout.trimEnd() : stderr));
    });
  });
}

/** 根目录必须是授权面内的目录（与 Rust 的 `resolve_root` 同规则）。 */
function resolveRoot(access: WorkspaceAccess, raw: string): string {
  const resolved = access.resolveExisting(raw);
  const stat = statSync(resolved);
  if (!stat.isDirectory()) throw new Error("git 根必须是目录");
  return resolved;
}

/** 仓库相对路径：必须相对、不含 ..、不以 - 开头（防被 git 当选项 / 越出仓库）。 */
function validateRelPath(rel: string): void {
  if (rel === "") throw new Error("路径不能为空");
  if (rel.startsWith("-")) throw new Error(`非法路径: ${rel}`);
  const segments = rel.split(/[\\/]/);
  if (path.isAbsolute(rel) || segments.includes("..") || /^[a-zA-Z]:/.test(rel)) {
    throw new Error(`非法路径: ${rel}`);
  }
}

function letterToStatus(letter: string): string | null {
  switch (letter) {
    case "M":
    case "m":
      return "modified";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
    case "r":
    case "C":
    case "c":
      return "renamed";
    case "T":
      return "modified";
    case "U":
    case "?":
      return "untracked";
    default:
      return null;
  }
}

function parseStatusRecord(record: string): { index: string; worktree: string; path: string } | null {
  if (record.length < 3 || record[2] !== " ") return null;
  const filePath = record.slice(3);
  if (filePath === "") return null;
  return { index: record[0], worktree: record[1], path: filePath };
}

async function collectRecords(root: string): Promise<StatusRecord[]> {
  const output = await runGit(root, ["status", "--porcelain", "-z"]);
  const records = output.split("\0");
  const entries: StatusRecord[] = [];
  let index = 0;
  while (index < records.length) {
    const record = records[index];
    index += 1;
    if (record === "") continue;
    // 重命名 / 复制：旧路径是紧随其后的独立记录，必须先吃掉再解析状态。
    let oldPath: string | null = null;
    if (record.startsWith("R") || record.startsWith("C")) {
      oldPath = records[index] ?? null;
      index += 1;
    }
    const parsed = parseStatusRecord(record);
    if (!parsed) continue;
    entries.push({ ...parsed, oldPath });
  }
  return entries;
}

/** 行式 `--numstat` 的路径 → 新路径（处理 `dir/{old => new}.txt` 这种花括号缩写）。 */
function renameTarget(raw: string): string {
  const split = raw.split(" => ");
  if (split.length !== 2) return raw;
  const [before, after] = split;
  const open = before.lastIndexOf("{");
  if (open < 0) return after.trim();
  const close = after.indexOf("}");
  if (close < 0) return after.trim();
  return before.slice(0, open) + after.slice(0, close) + after.slice(close + 1);
}

function parseNumstatLine(line: string): { add: number; del: number; path: string } | null {
  const [addRaw, delRaw, ...rest] = line.split("\t");
  const add = Number(addRaw);
  const del = Number(delRaw);
  const rawPath = rest.join("\t").trim();
  if (!Number.isFinite(add) || !Number.isFinite(del) || rawPath === "") return null;
  return { add, del, path: renameTarget(rawPath) };
}

async function collectNumstat(root: string, cached: boolean): Promise<Map<string, { add: number; del: number }>> {
  const output = await runGit(root, cached ? ["diff", "--cached", "--numstat"] : ["diff", "--numstat"]);
  const map = new Map<string, { add: number; del: number }>();
  for (const line of output.split("\n")) {
    if (line.trim() === "") continue;
    const parsed = parseNumstatLine(line);
    if (parsed) map.set(parsed.path, { add: parsed.add, del: parsed.del });
  }
  return map;
}

export async function gitStatus(access: WorkspaceAccess, root: string): Promise<GitStatusItem[]> {
  const records = await collectRecords(resolveRoot(access, root));
  const out: GitStatusItem[] = [];
  for (const record of records) {
    const status = letterToStatus(record.index) ?? letterToStatus(record.worktree);
    if (status === null) continue;
    out.push({
      path: record.path,
      status,
      staged: ![" ", "?", "!"].includes(record.index),
    });
  }
  return out;
}

export async function gitChanges(access: WorkspaceAccess, root: string): Promise<GitChangeItem[]> {
  const resolved = resolveRoot(access, root);
  const records = await collectRecords(resolved);
  const unstaged = await collectNumstat(resolved, false);
  const staged = await collectNumstat(resolved, true);
  return records.map((record) => {
    const work = unstaged.get(record.path) ?? { add: 0, del: 0 };
    const index = staged.get(record.path) ?? { add: 0, del: 0 };
    return {
      path: record.path,
      oldPath: record.oldPath,
      // '??'（未跟踪）只在 worktree 侧有意义：index 侧的 '?' 不是「已暂存」。
      index: record.index === "?" ? null : letterToStatus(record.index),
      worktree: letterToStatus(record.worktree),
      stagedAdd: index.add,
      stagedDel: index.del,
      add: work.add,
      del: work.del,
    };
  });
}

export async function gitDiff(access: WorkspaceAccess, root: string, filePath: string | null, staged: boolean): Promise<string> {
  const resolved = resolveRoot(access, root);
  const args = ["diff"];
  if (staged) args.push("--cached");
  if (filePath !== null) {
    validateRelPath(filePath);
    args.push("--", filePath);
  }
  return runGit(resolved, args);
}

export async function gitCurrentBranch(access: WorkspaceAccess, root: string): Promise<string> {
  const output = await runGit(resolveRoot(access, root), ["branch", "--show-current"]);
  return output.trim();
}
