/**
 * 隔离工作树（runMode=worktree）的完整生命周期：provision / list / release /
 * snapshot / restore。移植 `crates/greywork-host/src/infra/worktree/`。
 *
 * 语义（与 Rust 一致）：
 * - provision：git 仓库走真实 `git worktree add -b greywork/<slug>-<fp>`（命名分支进源仓库
 *   共享 refs，提交 release 后仍可达）；非 git 源整目录复制（跳过 .git / .greyWork / 链接）；
 *   源就是数据根时直通（direct）。目标目录与分支名对同一源**确定性**（slug + sha256 指纹前 12 位）。
 * - `.agents/linked`：被 git 忽略的共享文件以符号链接挂进快照（源读清单、逐条校验，
 *   失败只告警）；`.agents/skills` 同理（可选 id 子集）；`.agents/prepare` 仅新建时跑，30s 上限。
 * - snapshot / restore：临时索引（GIT_INDEX_FILE）在 `refs/greywork/snap/<id>` 上写整树 commit，
 *   回退 = read-tree --reset -u + clean -fdq + reset（严格等于快照，.gitignore 忽略的产物保留）。
 *   只对 kind=git 的自有快照生效。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { WorkspaceAccess } from "./workspace-access.js";

const WORKTREES_SUB_DIR = "worktrees";
const MARKER_FILE = ".greywork-worktree.json";

export interface WorktreeEntry {
  root: string;
  kind: string;
  source: string;
  bytes: number;
}

interface Marker {
  kind: string;
  source: string;
}

/** 分量级前缀：/a/bc 不算在 /a/b 内（与 Rust 的 Path::starts_with 一致）。 */
function isWithin(parent: string, child: string): boolean {
  if (path.resolve(child) === path.resolve(parent)) return true;
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function hasMarker(target: string): boolean {
  return existsSync(path.join(target, MARKER_FILE));
}

function writeMarker(target: string, marker: Marker): void {
  writeFileSync(path.join(target, MARKER_FILE), JSON.stringify(marker));
}

function readMarker(target: string): Marker | null {
  try {
    const parsed = JSON.parse(readFileSync(path.join(target, MARKER_FILE), "utf8")) as Partial<Marker>;
    if (typeof parsed.kind !== "string" || typeof parsed.source !== "string") return null;
    return { kind: parsed.kind, source: parsed.source };
  } catch {
    return null;
  }
}

/** 目录占用字节（递归累加普通文件；链接不跟随，避免环与越界）。 */
function dirBytes(target: string): number {
  let total = 0;
  let stat;
  try {
    stat = lstatSync(target);
  } catch {
    return 0;
  }
  if (stat.isSymbolicLink()) return 0;
  if (!stat.isDirectory()) return stat.size;
  for (const name of readdirSync(target)) total += dirBytes(path.join(target, name));
  return total;
}

export function listWorktrees(access: WorkspaceAccess): WorktreeEntry[] {
  const base = path.join(access.root, WORKTREES_SUB_DIR);
  if (!existsSync(base)) return [];
  const found: WorktreeEntry[] = [];
  for (const name of readdirSync(base)) {
    const target = path.join(base, name);
    if (!statSync(target).isDirectory()) continue;
    const marker = readMarker(target);
    if (!marker) continue;
    found.push({ root: target, kind: marker.kind, source: marker.source, bytes: dirBytes(target) });
  }
  return found.sort((left, right) => left.root.localeCompare(right.root));
}

export async function releaseWorktree(
  access: WorkspaceAccess,
  rootRaw: string,
  runGit: (repo: string, args: string[]) => Promise<string>,
): Promise<void> {
  const root = access.resolveExisting(rootRaw);
  const base = path.join(access.root, WORKTREES_SUB_DIR);
  const relative = path.relative(base, root);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("只允许释放 ~/.greyWork/worktrees 下的隔离快照");
  }
  if (!existsSync(root)) return; // 幂等：已回收视为成功
  const marker = readMarker(root);
  if (marker?.kind === "git" && existsSync(marker.source)) {
    try {
      // 必须在源仓库内执行：git 不允许移除「当前工作树」。
      await runGit(marker.source, ["worktree", "remove", "--force", "--force", root]);
    } catch {
      // 退回整目录删除（快照本就是可丢弃的）。
    }
  }
  if (!existsSync(root)) return;
  try {
    rmSync(root, { recursive: true });
  } catch (error) {
    throw new Error(`删除快照目录失败: ${(error as Error).message}`, { cause: error });
  }
}

/* ==================== provision / snapshot / restore ==================== */

const AGENTS_DIR = ".agents";
/** Claude Code 只读自己的技能目录；安装/带入时在它下面建指向 .agents/skills 的链接。 */
const CLAUDE_DIR = ".claude";
const SNAPSHOT_REF_PREFIX = "refs/greywork/snap";
let snapshotSeq = 0;

function gitRun(cwd: string, args: string[], envs: Record<string, string> = {}): string {
  try {
    return execFileSync("git", ["-c", "core.quotepath=false", ...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...envs },
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
  } catch (error) {
    const err = error as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
    const stderr = typeof err.stderr === "string" ? err.stderr : Buffer.from(err.stderr ?? "").toString();
    const stdout = typeof err.stdout === "string" ? err.stdout : Buffer.from(err.stdout ?? "").toString();
    throw new Error(stderr.trim() === "" ? (stdout.trim() === "" ? (err.message ?? "git failed") : stdout.trimEnd()) : stderr.trimEnd(), {
      cause: error,
    });
  }
}

function isGitRepo(source: string): boolean {
  return existsSync(path.join(source, ".git"));
}

/** 净名 slug：只留字母数字 _ -，其余压成 -，空则回落 ws。 */
function slug(source: string): string {
  const raw = path.basename(source);
  const cleaned = [...raw].map((ch) => (/[A-Za-z0-9_-]/.test(ch) ? ch : "-")).join("");
  const trimmed = cleaned.replace(/^-+|-+$/g, "");
  return trimmed === "" ? "ws" : trimmed;
}

/** 源路径指纹：sha256(可比路径) 前 12 位（Linux 区分大小写；Windows / macOS 折叠）。 */
function sourceFingerprint(source: string): string {
  const comparable = process.platform === "linux" ? source : source.replace(/\\/g, "/").toLowerCase();
  return createHash("sha256").update(comparable).digest("hex").slice(0, 12);
}

function deterministicTarget(base: string, source: string): string {
  return path.join(base, `${slug(source)}-${sourceFingerprint(source)}`);
}

function worktreeBranch(source: string): string {
  return `greywork/${slug(source)}-${sourceFingerprint(source)}`;
}

function isSafeRelative(entry: string): boolean {
  if (path.isAbsolute(entry)) return false;
  return !entry.split(/[\\/]/).includes("..");
}

function readLinkedEntries(source: string): string[] {
  try {
    return readFileSync(path.join(source, AGENTS_DIR, "linked"), "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
  } catch {
    return [];
  }
}

/** 递归复制目录快照：跳过 .git / .greyWork / 符号链接（不追随，避免逃出源树）。 */
function copyDir(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    if (name === ".git" || name === ".greyWork") continue;
    const from = path.join(src, name);
    const to = path.join(dst, name);
    const stat = lstatSync(from);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      copyDir(from, to);
    } else if (stat.isFile()) {
      writeFileSync(to, readFileSync(from));
    }
  }
}

function applyLinked(source: string, target: string): void {
  for (const entry of readLinkedEntries(source)) {
    if (!isSafeRelative(entry)) continue;
    try {
      // 必须被 git 忽略：链接出现在 git status 里会污染 agent 的变更视图。
      execFileSync("git", ["check-ignore", "-q", "--", entry], { cwd: source, stdio: "ignore" });
    } catch {
      console.warn(`[host-node] .agents/linked 条目未被 git 忽略，已跳过: ${entry}`);
      continue;
    }
    const src = path.join(source, entry);
    if (!existsSync(src)) continue;
    const dst = path.join(target, entry);
    if (existsSync(dst)) continue;
    try {
      mkdirSync(path.dirname(dst), { recursive: true });
      symlinkSync(src, dst);
    } catch (error) {
      console.warn(`[host-node] .agents/linked 创建符号链接失败 ${entry}: ${(error as Error).message}`);
    }
  }
}

function applySkills(source: string, target: string, sourceIsGit: boolean, selected: string[] | null): void {
  const sourceSkills = path.join(source, AGENTS_DIR, "skills");
  if (!existsSync(sourceSkills)) return;
  const targetSkills = path.join(target, AGENTS_DIR, "skills");
  if (existsSync(targetSkills)) return;
  try {
    mkdirSync(targetSkills, { recursive: true });
  } catch (error) {
    console.warn(`[host-node] 创建 .agents/skills 目录失败，跳过技能带入: ${(error as Error).message}`);
    return;
  }
  for (const name of readdirSync(sourceSkills)) {
    if (!isSafeRelative(name)) continue;
    if (selected !== null && !selected.includes(name)) continue;
    const rel = `.agents/skills/${name}`;
    if (sourceIsGit) {
      try {
        execFileSync("git", ["check-ignore", "-q", "--", rel], { cwd: source, stdio: "ignore" });
      } catch {
        console.warn(`[host-node] .agents/skills 条目未被 git 忽略，已跳过: ${name}`);
        continue;
      }
    }
    const dst = path.join(targetSkills, name);
    if (existsSync(dst)) continue;
    try {
      symlinkSync(path.join(sourceSkills, name), dst);
    } catch (error) {
      console.warn(`[host-node] .agents/skills 创建符号链接失败 ${name}: ${(error as Error).message}`);
      continue;
    }
    // Claude Code 只读 .claude/skills：也在工作树里建一条相对链接。它同样会出现在变更视图里，
    // 所以只在该路径已被 git 忽略时创建（与 .agents/skills 的守卫同一目的）；否则跳过并告警。
    const compatRel = `${CLAUDE_DIR}/skills/${name}`;
    if (sourceIsGit) {
      try {
        execFileSync("git", ["check-ignore", "-q", "--", compatRel], { cwd: target, stdio: "ignore" });
      } catch {
        console.warn(`[host-node] .claude/skills 未被 git 忽略，跳过 Claude 兼容链接: ${name}`);
        continue;
      }
    }
    const compatDst = path.join(target, compatRel);
    try {
      mkdirSync(path.dirname(compatDst), { recursive: true });
      if (!existsSync(compatDst)) {
        symlinkSync(path.join("..", "..", AGENTS_DIR, "skills", name), compatDst);
      }
    } catch (error) {
      console.warn(`[host-node] 创建 .claude/skills 兼容链接失败 ${name}: ${(error as Error).message}`);
    }
  }
}

function runPrepare(target: string): void {
  const script = path.join(target, AGENTS_DIR, "prepare");
  const stat = statSync(script, { throwIfNoEntry: false });
  if (!stat?.isFile()) return;
  try {
    execFileSync(script, {
      cwd: target,
      timeout: 30_000,
      stdio: "ignore",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  } catch {
    try {
      execFileSync("sh", [script], { cwd: target, timeout: 30_000, stdio: "ignore" });
    } catch (error) {
      console.warn(`[host-node] .agents/prepare 执行失败: ${(error as Error).message}`);
    }
  }
}

export function provisionWorktree(
  access: WorkspaceAccess,
  sourceRaw: string,
  prepare: boolean,
  skills: string[] | null,
): { root: string; kind: string; source: string } {
  const source = access.resolveExisting(sourceRaw);
  if (!statSync(source).isDirectory()) throw new Error("worktree 源必须是目录");
  const base = path.join(access.root, "worktrees");
  // 源就是数据根：直通，不做隔离。
  if (path.resolve(source) === path.resolve(access.root)) {
    return { root: source, kind: "direct", source };
  }
  const target = deterministicTarget(base, source);
  if (isWithin(source, target)) throw new Error(`快照目录会落在源目录内部，无法隔离: ${target}`);
  if (hasMarker(target)) {
    const kind = readMarker(target)?.kind ?? "copy";
    return { root: target, kind, source };
  }
  if (existsSync(target)) {
    throw new Error(`快照目录已存在但没有 provision 标记，请先 worktree_release 再重试: ${target}`);
  }
  mkdirSync(base, { recursive: true });

  const sourceIsGit = isGitRepo(source);
  let kind: string;
  if (sourceIsGit) {
    const branch = worktreeBranch(source);
    try {
      // 命名分支检出（绝不 -B：不重置用户已有的同名分支，提交 release 后仍可达）。
      gitRun(source, ["worktree", "add", "-b", branch, target]);
      kind = "git";
    } catch {
      try {
        // 分支已存在（上次 release 留下）：挂到既有分支复用其提交。
        gitRun(source, ["worktree", "add", target, branch]);
        kind = "git";
      } catch (error) {
        console.warn(`[host-node] git worktree add 失败（回落复制兜底）: ${(error as Error).message}`);
        copyDir(source, target);
        kind = "copy";
      }
    }
  } else {
    copyDir(source, target);
    kind = "copy";
  }
  if (sourceIsGit) applyLinked(source, target);
  applySkills(source, target, sourceIsGit, skills);
  if (prepare) runPrepare(target);
  writeMarker(target, { kind, source });
  return { root: target, kind, source };
}

function ownGitSnapshot(access: WorkspaceAccess, rootRaw: string): string {
  const root = access.resolveExisting(rootRaw);
  const base = path.join(access.root, "worktrees");
  if (!isWithin(base, root)) {
    throw new Error("只允许对 ~/.greyWork/worktrees 下的隔离快照做快照/回退");
  }
  if (readMarker(root)?.kind !== "git") {
    throw new Error("只有 git 隔离快照支持快照与回退");
  }
  return root;
}

/** 记一次工作区快照：临时索引（GIT_INDEX_FILE）构建整树 tree，写成 refs/greywork/snap/<id>。 */
export function snapshotWorktree(access: WorkspaceAccess, rootRaw: string): string {
  const root = ownGitSnapshot(access, rootRaw);
  const indexFile = path.join(process.env.TMPDIR ?? "/tmp", `greywork-idx-${Date.now().toString(16)}-${process.pid}-${snapshotSeq++}`);
  rmSync(indexFile, { force: true });
  let commit: string;
  try {
    gitRun(root, ["read-tree", "HEAD"], { GIT_INDEX_FILE: indexFile });
    gitRun(root, ["add", "-A"], { GIT_INDEX_FILE: indexFile });
    const tree = gitRun(root, ["write-tree"], { GIT_INDEX_FILE: indexFile }).trim();
    const parent = gitRun(root, ["rev-parse", "HEAD"]).trim();
    commit = gitRun(root, [
      "-c",
      "user.name=greywork",
      "-c",
      "user.email=greywork@localhost",
      "commit-tree",
      tree,
      "-p",
      parent,
      "-m",
      "greywork snapshot",
    ]).trim();
  } finally {
    rmSync(indexFile, { force: true });
  }
  const reference = `${SNAPSHOT_REF_PREFIX}/${Date.now().toString(16)}-${process.pid}-${snapshotSeq++}`;
  gitRun(root, ["update-ref", reference, commit]);
  return reference;
}

/** 硬回退：read-tree --reset -u → clean -fdq → reset（工作区 := 快照，gitignore 产物保留）。 */
export function restoreWorktree(access: WorkspaceAccess, rootRaw: string, reference: string): void {
  const root = ownGitSnapshot(access, rootRaw);
  if (!reference.startsWith(`${SNAPSHOT_REF_PREFIX}/`)) {
    throw new Error(`只允许回退到 ${SNAPSHOT_REF_PREFIX}/* 下的快照`);
  }
  gitRun(root, ["rev-parse", "--verify", `${reference}^{commit}`]);
  gitRun(root, ["read-tree", "--reset", "-u", reference]);
  gitRun(root, ["clean", "-fdq"]);
  gitRun(root, ["reset", "-q"]);
}
