/**
 * 路径授权面：移植 `crates/greywork-host/src/infra/workspace_fs/`（mod + resolve + read 的核心）。
 *
 * 不变量（与 Rust 逐条对齐）：
 * - 授权只来自「宿主可验证的用户动作」（配置预置根 / 授权命令），普通命令只能消费；
 * - 解析一律 canonicalize，越界判定按**路径分量**前缀（`/a/bc` 不算在 `/a/b` 内）；
 * - 授权账本落 `<dataDir>/workspace-path-access.json`，文件权限 0600，原子写。
 *
 * 只用于 P1 的读面（列目录 / 读文本）。写面（新建 / 改名 / 删除）在 P1 后半段搬，
 * 届时复用同一份 `requireAuthorizedRoot`。
 */
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";

const MAX_TEXT_BYTES = 10 * 1024 * 1024;

export interface DirEntryInfo {
  name: string;
  kind: "directory" | "file";
  /** 目录为 null（与 Rust 的 Option<u64> 序列化一致）。 */
  size: number | null;
  path: string;
}

interface Ledger {
  roots: string[];
  files: string[];
}

function validateAbsolute(raw: string): string {
  if (!path.isAbsolute(raw)) {
    throw new Error("只接受绝对路径");
  }
  if (raw.split(/[\\/]/).includes("..")) {
    throw new Error("路径不得包含 ..");
  }
  return raw;
}

function canonicalExisting(raw: string): string {
  validateAbsolute(raw);
  try {
    return realpathSync(raw);
  } catch (error) {
    throw new Error(`路径不可访问: ${(error as Error).message}`, { cause: error });
  }
}

/** 分量级前缀：与 Rust 的 `Path::starts_with` 同语义。 */
function isWithin(parent: string, child: string): boolean {
  if (child === parent) return true;
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export class WorkspaceAccess {
  private roots: string[] = [];
  private files: string[] = [];
  private readonly defaultRoot: string;

  constructor(
    defaultRoot: string,
    private readonly ledgerPath: string,
  ) {
    mkdirSync(defaultRoot, { recursive: true });
    this.defaultRoot = canonicalExisting(defaultRoot);
    this.roots.push(this.defaultRoot);
    this.loadLedger();
  }

  /** 启动时绑定的默认根（工具省略路径时锚在这里，不是「排序最小的授权根」）。 */
  get root(): string {
    return this.defaultRoot;
  }

  authorizedRoots(): string[] {
    return [...this.roots];
  }

  /** 授权一个目录（仅可信宿主路径会调用到）：必须已存在，canonicalize 后入账并落盘。 */
  authorizeSelectedPath(raw: string): string {
    const canonical = canonicalExisting(raw);
    if (!statSync(canonical).isDirectory()) {
      throw new Error("只能授权文件夹");
    }
    if (!this.roots.includes(canonical)) {
      this.roots.push(canonical);
      this.persist();
    }
    return canonical;
  }

  /** 解析已有路径：canonicalize + 必须落在某个授权根内（或被单独授权的文件）。 */
  resolveExisting(raw: string): string {
    const canonical = canonicalExisting(raw);
    if (!this.files.includes(canonical) && !this.roots.some((root) => isWithin(root, canonical))) {
      throw new Error(`路径未获用户授权: ${canonical}`);
    }
    return canonical;
  }

  /** 浅层列目录：越界或断链的符号链接项直接不出现（与 Rust 一致）。 */
  listDir(raw: string): DirEntryInfo[] {
    const dir = this.resolveExisting(raw);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (error) {
      throw new Error(`打开目录失败: ${(error as Error).message}`, { cause: error });
    }
    const out: DirEntryInfo[] = [];
    for (const name of names) {
      const entryPath = path.join(dir, name);
      let resolved = entryPath;
      // lstat 看条目本身（stat 会跟随链接）；断链的 lstat 也能成功，交给 resolve 决定是否剔除。
      const isLink = lstatSync(entryPath).isSymbolicLink();
      if (isLink) {
        try {
          resolved = this.resolveExisting(entryPath);
        } catch {
          continue;
        }
      }
      let metadata;
      try {
        metadata = statSync(resolved);
      } catch (error) {
        throw new Error(`读取目录项元数据失败: ${(error as Error).message}`, { cause: error });
      }
      out.push({
        name,
        kind: metadata.isDirectory() ? "directory" : "file",
        size: metadata.isFile() ? metadata.size : null,
        path: resolved,
      });
    }
    return out;
  }

  /** 读文本文件（10MB 上限）：UTF-8 优先，带 BOM 剥掉，非 UTF-8 按 GB18030 兜底。 */
  readTextFile(raw: string): string {
    const file = this.resolveExisting(raw);
    const metadata = statSync(file);
    if (metadata.size > MAX_TEXT_BYTES) {
      throw new Error("文件超过 10MB 上限");
    }
    const buffer = readFileSync(file);
    return decodeText(buffer);
  }

  private loadLedger(): void {
    let raw: string;
    try {
      raw = readFileSync(this.ledgerPath, "utf8");
    } catch {
      return;
    }
    let saved: Partial<Ledger>;
    try {
      saved = JSON.parse(stripBom(raw)) as Partial<Ledger>;
    } catch {
      return;
    }
    for (const root of saved.roots ?? []) {
      try {
        if (statSync(root).isDirectory()) this.roots.push(canonicalExisting(root));
      } catch {
        // 账本里已消失的目录：忽略（与 Rust 的 is_dir 过滤一致）。
      }
    }
    for (const file of saved.files ?? []) {
      try {
        if (statSync(file).isFile()) this.files.push(canonicalExisting(file));
      } catch {
        // 同上。
      }
    }
    this.roots = [...new Set(this.roots)];
    this.files = [...new Set(this.files)];
  }

  /** 原子写 + 0600：账本损坏等于授权丢失，写一半比不写更糟。 */
  private persist(): void {
    const payload = JSON.stringify({ roots: this.roots, files: this.files }, null, 2);
    const temp = `${this.ledgerPath}.${process.pid}.tmp`;
    mkdirSync(path.dirname(this.ledgerPath), { recursive: true });
    const fd = openSync(temp, "w", 0o600);
    try {
      writeSync(fd, payload);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(temp, this.ledgerPath);
    } catch (error) {
      try {
        unlinkSync(temp);
      } catch {
        // 清理失败不影响主流程。
      }
      throw error;
    }
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 解码顺序与 Rust 的 decode_text_file 同目标：UTF-8（含 BOM）→ UTF-16（BOM）→ GB18030。 */
export function decodeText(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(buffer.subarray(2));
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(buffer.subarray(2));
  }
  const body = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? buffer.subarray(3) : buffer;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    // 非 UTF-8：简中 Windows 的「ANSI」多为 GBK 系，GB18030 是其超集。
    return new TextDecoder("gb18030").decode(body);
  }
}

export { MAX_TEXT_BYTES };
