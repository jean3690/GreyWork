/**
 * 技能安装/卸载（市场与内置技能共用同一条净化路径）。
 * 移植 `services/skills_market.rs`：两阶段落盘（先全部过审再写入，可疑快照整体拒绝）。
 *
 * `skills_search` / `skills_download` / `skills_bundled_list` 尚未迁移（联网与内置数据面），
 * 调用回 501。
 */
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { isSafePathSegment } from "./workspace-access.js";

const MAX_FILES_PER_SKILL = 128;
const MAX_FILE_BYTES = 256 * 1024;
const SKILL_ID_MAX_CHARS = 64;
const MAX_REL_DEPTH = 16;

export interface SkillSnapshotFile {
  path: string;
  contents: string;
}

export interface InstallReport {
  dir: string;
  filesWritten: number;
}

export function validateWorkspaceRoot(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "" || !path.isAbsolute(trimmed)) {
    throw new Error(`workspace root must be an absolute path, got: ${JSON.stringify(raw)}`);
  }
  if (path.parse(trimmed).root === trimmed) {
    throw new Error("workspace root must not be a filesystem root");
  }
  if (!existsDir(trimmed)) throw new Error(`workspace root does not exist: ${trimmed}`);
  return trimmed;
}

export function validateSkillId(raw: string): string {
  const id = raw.trim();
  const chars = [...id];
  const valid =
    id !== "" &&
    id.length <= SKILL_ID_MAX_CHARS &&
    chars.length > 0 &&
    /[a-z0-9]/.test(chars[0]) &&
    chars.every((ch) => /[a-z0-9-]/.test(ch));
  if (!valid) throw new Error(`invalid skill id (expect lowercase slug): ${JSON.stringify(raw)}`);
  return id;
}

/** 净化远端声明的相对路径：仅允许正斜杠分隔的非空普通段（深度 ≤16，逐段过安全检查）。 */
function sanitizeRelPath(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.startsWith("/") || trimmed.includes("\\")) return null;
  const parts: string[] = [];
  let depth = 0;
  for (const segment of trimmed.split("/")) {
    if (segment === "" || segment === ".") continue;
    depth += 1;
    if (depth > MAX_REL_DEPTH || !isSafePathSegment(segment)) return null;
    parts.push(segment);
  }
  return parts.length > 0 ? path.join(...parts) : null;
}

function existsDir(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

export function writeSkillSnapshot(root: string, id: string, files: SkillSnapshotFile[]): InstallReport {
  if (files.length === 0) throw new Error("snapshot has no files");
  if (files.length > MAX_FILES_PER_SKILL) {
    throw new Error(`too many files: ${files.length} (max ${MAX_FILES_PER_SKILL})`);
  }
  // 两阶段：全部路径与体积先过审，再落盘 —— 可疑快照整体拒绝，不产生部分写入。
  const sanitized: { rel: string; file: SkillSnapshotFile }[] = [];
  for (const file of files) {
    const rel = sanitizeRelPath(file.path);
    if (rel === null) throw new Error(`unsafe file path rejected: ${JSON.stringify(file.path)}`);
    if (Buffer.byteLength(file.contents, "utf8") > MAX_FILE_BYTES) {
      throw new Error(`file too large: ${JSON.stringify(file.path)} (max ${MAX_FILE_BYTES} bytes)`);
    }
    sanitized.push({ rel, file });
  }
  const target = path.join(root, ".agents", "skills", id);
  mkdirSync(target, { recursive: true });
  let written = 0;
  for (const { rel, file } of sanitized) {
    const dest = path.join(target, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    try {
      writeFileSync(dest, file.contents);
    } catch (error) {
      throw new Error(`write ${JSON.stringify(file.path)} failed: ${(error as Error).message}`, { cause: error });
    }
    written += 1;
  }
  return { dir: target, filesWritten: written };
}

export function skillsInstall(workspaceRoot: string, skillId: string, files: SkillSnapshotFile[]): InstallReport {
  const root = validateWorkspaceRoot(workspaceRoot);
  const id = validateSkillId(skillId);
  return writeSkillSnapshot(root, id, files);
}

export function skillsUninstall(workspaceRoot: string, skillId: string): void {
  const root = validateWorkspaceRoot(workspaceRoot);
  const id = validateSkillId(skillId);
  const target = path.join(root, ".agents", "skills", id);
  if (!existsSync(target)) throw new Error(`skill not installed: ${id}`);
  rmSync(target, { recursive: true });
}
