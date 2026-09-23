import type { CommitResult, FileEntry, GitChange, GitService, GitStatusEntry, WorkspaceFileSystem } from "./types";

/** 内存虚拟文件系统：path → content 平铺表；目录是路径推导出的虚拟节点。
 * 二进制文件（xlsx 等产物）存独立表，不参与 snapshot（git/diff 基于文本快照）。 */
export function createMemoryFileSystem(initialFiles: Record<string, string> = {}): WorkspaceFileSystem {
  const files = new Map<string, string>(Object.entries(initialFiles));
  const binaryFiles = new Map<string, Uint8Array>();
  return {
    async readFile(path) {
      const content = files.get(path);
      if (content === undefined) throw new Error(`File not found: ${path}`);
      return content;
    },
    async writeFile(path, content) {
      files.set(path, content);
    },
    async writeBinary(path, data) {
      binaryFiles.set(path, data);
      files.delete(path);
    },
    async readBinary(path) {
      const data = binaryFiles.get(path);
      if (data === undefined) throw new Error(`Binary file not found: ${path}`);
      return data;
    },
    async delete(path) {
      if (!files.has(path) && !binaryFiles.has(path)) throw new Error(`File not found: ${path}`);
      files.delete(path);
      binaryFiles.delete(path);
    },
    async rename(from, to) {
      if (binaryFiles.has(from)) {
        const data = binaryFiles.get(from)!;
        binaryFiles.delete(from);
        binaryFiles.set(to, data);
        return;
      }
      const content = files.get(from);
      if (content === undefined) throw new Error(`File not found: ${from}`);
      files.delete(from);
      files.set(to, content);
    },
    async list(dir = "") {
      const entries = new Map<string, FileEntry>();
      for (const [path, content] of files) {
        if (dir && !path.startsWith(dir + "/")) continue;
        const rel = path.slice(dir ? dir.length + 1 : 0);
        const first = rel.split("/")[0];
        const isDir = rel.includes("/");
        const key = dir ? `${dir}/${first}` : first;
        if (!entries.has(key)) {
          entries.set(key, {
            path: key,
            kind: isDir ? "directory" : "file",
            size: isDir ? undefined : content.length,
            language: first.split(".")[1],
          });
        }
      }
      for (const [path, data] of binaryFiles) {
        if (dir && !path.startsWith(dir + "/")) continue;
        const rel = path.slice(dir ? dir.length + 1 : 0);
        const first = rel.split("/")[0];
        const isDir = rel.includes("/");
        const key = dir ? `${dir}/${first}` : first;
        if (!entries.has(key)) {
          entries.set(key, {
            path: key,
            kind: isDir ? "directory" : "file",
            size: isDir ? undefined : data.byteLength,
            language: first.split(".")[1],
          });
        }
      }
      return Array.from(entries.values()).sort((a, b) => a.path.localeCompare(b.path));
    },
    async exists(path) {
      return files.has(path) || binaryFiles.has(path);
    },
    snapshot() {
      return Object.fromEntries(files);
    },
  };
}

/**
 * 多重集行差集：统计 baseline → current 的增删行（O(n+m)，够用于内存 git 面板）。
 *
 * 按 `\r\n|\n|\r` 拆行：Windows 上写出的内容（CRLF）与基线（LF）如果只按 `\n` 拆，
 * 每一行都会多一个尾随 `\r`，于是「只改了行尾」被判成整篇改动。
 */
function diffLines(baseline: string, current: string): { add: number; del: number; added: string[]; deleted: string[] } {
  const counts = new Map<string, number>();
  for (const line of baseline.split(/\r\n|\n|\r/)) counts.set(line, (counts.get(line) ?? 0) + 1);
  const added: string[] = [];
  for (const line of current.split(/\r\n|\n|\r/)) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else added.push(line);
  }
  const deleted: string[] = [];
  for (const [line, left] of counts) for (let i = 0; i < left; i += 1) deleted.push(line);
  return { add: added.length, del: deleted.length, added, deleted };
}

function buildPatch(path: string, baseline: string, current: string, cap = 200): { add: number; del: number; patch: string } {
  const { add, del, added, deleted } = diffLines(baseline, current);
  const body = [...deleted.slice(0, cap).map((line) => `- ${line}`), ...added.slice(0, cap).map((line) => `+ ${line}`)];
  const patch = [`--- a/${path}`, `+++ b/${path}`, ...body].join("\n");
  return { add, del, patch };
}

/** 基于虚拟文件系统的内存 git：创建时快照为基线，commit 将当前快照设为新基线。 */
export function createMemoryGitService(fs: WorkspaceFileSystem): GitService {
  const branches = ["main", "feature/plugin-market"];
  let baseline = fs.snapshot();
  let commits = 0;

  return {
    async status() {
      const now = fs.snapshot();
      const statuses: GitStatusEntry[] = [];
      for (const [path, content] of Object.entries(now)) {
        if (!(path in baseline)) statuses.push({ path, status: "untracked" });
        else if (baseline[path] !== content) statuses.push({ path, status: "modified" });
      }
      for (const path of Object.keys(baseline)) {
        if (!(path in now)) statuses.push({ path, status: "deleted" });
      }
      return statuses.sort((a, b) => a.path.localeCompare(b.path));
    },
    async changes() {
      const now = fs.snapshot();
      const result: GitChange[] = [];
      // 内存工作区没有 index（暂存区）概念：所有改动一律记在 worktree 侧，index 恒为 null。
      const entry = (path: string, status: GitChange["worktree"], add: number, del: number): GitChange => ({
        path,
        oldPath: null,
        index: null,
        worktree: status,
        stagedAdd: 0,
        stagedDel: 0,
        add,
        del,
      });
      for (const [path, content] of Object.entries(now)) {
        const base = baseline[path];
        if (base === undefined) {
          result.push(entry(path, "untracked", diffLines("", content).add, 0));
        } else if (base !== content) {
          const stats = diffLines(base, content);
          result.push(entry(path, "modified", stats.add, stats.del));
        }
      }
      for (const path of Object.keys(baseline)) {
        if (!(path in now)) {
          result.push(entry(path, "deleted", 0, diffLines(baseline[path], "").del));
        }
      }
      return result.sort((a, b) => a.path.localeCompare(b.path));
    },
    async diff(path) {
      const now = fs.snapshot();
      const targets = path
        ? [path]
        : Object.keys({ ...baseline, ...now }).filter((candidate) => (baseline[candidate] ?? null) !== (now[candidate] ?? null));
      const chunks: string[] = [];
      let add = 0;
      let del = 0;
      for (const target of targets) {
        const { patch, add: a, del: d } = buildPatch(target, baseline[target] ?? "", now[target] ?? "");
        if (!a && !d) continue;
        add += a;
        del += d;
        chunks.push(patch);
      }
      return chunks.length ? `${chunks.join("\n\n")}\n（${add} 增 / ${del} 删）` : "无变更。";
    },
    async commit(message) {
      baseline = fs.snapshot();
      commits += 1;
      const result: CommitResult = {
        hash: `a1f${String(commits).padStart(11, "0")}`,
        message,
        timestamp: new Date().toISOString(),
      };
      return result;
    },
    async currentBranch() {
      return "feature/plugin-market";
    },
    async branches() {
      return [...branches];
    },
  };
}
