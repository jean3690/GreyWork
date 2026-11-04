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
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import { PROBE_PREFIX_BYTES, probeBytes, readPrefix, type FileProbe } from "./text-probe.js";

const MAX_TEXT_BYTES = 10 * 1024 * 1024;
const MAX_BINARY_BYTES = 20 * 1024 * 1024;
/** 媒体专用的硬顶：真实视频与带贴图的模型普遍超过 20MB，按预览口径卡死等于这类文件打不开。 */
const MAX_MEDIA_BYTES = 128 * 1024 * 1024;

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

/** 离开宿主的路径一律不带 verbatim 前缀（与 Rust `path_safety::strip_verbatim_prefix` 对齐）。 */
function stripVerbatimPrefix(target: string): string {
  return target.startsWith("\\\\?\\") ? target.slice(4) : target;
}

/**
 * 新建条目的名字安全：与 `core/path_safety.rs::is_safe_path_segment` 同一套规则 ——
 * 拒绝结尾的 `.` / 空格（Windows 会静默剥掉，导致两个名字落到同一个文件）、控制字符、
 * 分隔符与通配符，以及 Windows 设备名（CON / PRN / AUX / NUL / COM1-9 / LPT1-9，带扩展名也算）。
 */
export function isSafePathSegment(segment: string): boolean {
  if (segment === "" || segment === "." || segment === "..") return false;
  if (/[. ]$/.test(segment)) return false;
  // 控制字符（NUL / DEL / C1）逐码点判断：正则字面量写控制字符会被 lint 判为可疑模式。
  for (const ch of segment) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false;
  }
  if (/[/\\<>"|?*:]/.test(segment)) return false;
  const base = segment.split(".")[0]?.toUpperCase() ?? "";
  if (["CON", "PRN", "AUX", "NUL"].includes(base)) return false;
  const match = /^(?:COM|LPT)(\d)$/.exec(base);
  return match === null;
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

  /**
   * 系统选择器单条授权（Rust `authorize_selected_path` 同名语义）：文件与目录都收 ——
   * 目录入 roots、文件入 files，其它形态（socket 等）拒绝。
   */
  authorizePickedPath(raw: string): string {
    const canonical = canonicalExisting(raw);
    const stat = statSync(canonical);
    if (stat.isDirectory()) {
      if (!this.roots.includes(canonical)) {
        this.roots.push(canonical);
        this.persist();
      }
    } else if (stat.isFile()) {
      if (!this.files.includes(canonical)) {
        this.files.push(canonical);
        this.persist();
      }
    } else {
      throw new Error("只允许授权普通文件或目录");
    }
    return canonical;
  }

  /**
   * `fs_authorize_picked_paths`：逐条走单条语义（与 Rust 一致：某条失败即中断，
   * 之前的条目保持已授权 —— 与桌面壳 `pick_workspace_folder` 的返回同形态）。
   */
  authorizePickedPaths(paths: string[]): string[] {
    return paths.map((raw) => stripVerbatimPrefix(this.authorizePickedPath(raw)));
  }

  /** OS 拖放：只认普通文件，目录被忽略（不让整批失败）。 */
  authorizeDropPaths(paths: string[]): void {
    const files: string[] = [];
    for (const raw of paths) {
      const canonical = canonicalExisting(raw);
      if (statSync(canonical).isFile()) files.push(canonical);
    }
    if (files.length === 0) return;
    for (const file of files) {
      if (!this.files.includes(file)) this.files.push(file);
    }
    this.persist();
  }

  /** 解析已有路径：canonicalize + 必须落在某个授权根内（或被单独授权的文件）。 */
  resolveExisting(raw: string): string {
    const canonical = canonicalExisting(raw);
    if (!this.files.includes(canonical) && !this.roots.some((root) => isWithin(root, canonical))) {
      throw new Error(`路径未获用户授权: ${canonical}`);
    }
    return canonical;
  }

  /**
   * 写路径解析：已存在 → 按读规则；不存在 → 找最近的已存在祖先，canonicalize 后要求它
   * 在授权根内，再把剩余后缀拼回去（与 Rust 的 `resolve_write` 同一套规则）。
   */
  resolveWrite(raw: string): string {
    const requested = validateAbsolute(raw);
    if (existsSync(requested)) return this.resolveExisting(raw);
    let ancestor = path.dirname(requested);
    for (;;) {
      if (existsSync(ancestor)) break;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new Error("写入路径没有可访问的父目录");
      ancestor = parent;
    }
    const canonicalAncestor = canonicalExisting(ancestor);
    if (!this.roots.some((root) => isWithin(root, canonicalAncestor))) {
      throw new Error(`写入目录未获用户授权: ${canonicalAncestor}`);
    }
    return path.join(canonicalAncestor, path.relative(ancestor, requested));
  }

  /** 新建条目的公共前置：绝对路径、名字安全、父目录存在且在授权根内。 */
  resolveNewEntry(raw: string): string {
    const requested = validateAbsolute(raw);
    const name = path.basename(requested);
    if (!isSafePathSegment(name)) throw new Error(`名称不可用: ${name}`);
    const parent = path.dirname(requested);
    if (!existsSync(parent)) throw new Error("父目录不存在");
    const canonicalParent = canonicalExisting(parent);
    if (!this.roots.some((root) => isWithin(root, canonicalParent))) {
      throw new Error(`写入目录未获用户授权: ${canonicalParent}`);
    }
    if (!statSync(canonicalParent).isDirectory()) throw new Error("父目录不是文件夹");
    return path.join(canonicalParent, name);
  }

  /** 写文本（单次 ≤10MB）。 */
  writeTextFile(raw: string, content: string): void {
    if (Buffer.byteLength(content, "utf8") > MAX_TEXT_BYTES) {
      throw new Error("文件超过 10MB 上限");
    }
    const target = this.resolveWrite(raw);
    try {
      writeFileSync(target, content);
    } catch (error) {
      throw new Error(`写入文件失败: ${(error as Error).message}`, { cause: error });
    }
  }

  /** 确保目录存在（产物目录等工作区落盘前置）。 */
  ensureDir(raw: string): void {
    const target = this.resolveWrite(raw);
    try {
      mkdirSync(target, { recursive: true });
    } catch (error) {
      throw new Error(`创建目录失败: ${(error as Error).message}`, { cause: error });
    }
  }

  /** 新建空文件：O_EXCL 语义，撞名失败而不是覆盖。 */
  createFile(raw: string): void {
    const target = this.resolveNewEntry(raw);
    try {
      writeFileSync(target, "", { flag: "wx" });
    } catch (error) {
      throw new Error(`新建文件失败: ${(error as Error).message}`, { cause: error });
    }
  }

  /** 新建文件夹（父目录必须已存在）。 */
  createDir(raw: string): void {
    const target = this.resolveNewEntry(raw);
    try {
      mkdirSync(target);
    } catch (error) {
      throw new Error(`新建文件夹失败: ${(error as Error).message}`, { cause: error });
    }
  }

  /**
   * 解析**条目本身**（不跟随符号链接），要求父目录在授权根内。
   * 删除 / 改名 / 复制走这条：`resolveExisting` 会把链接解成目标，对「操作这个条目」是错的。
   */
  resolveEntry(raw: string): string {
    const requested = validateAbsolute(raw);
    const parent = path.dirname(requested);
    const canonicalParent = canonicalExisting(parent);
    if (!this.roots.some((root) => isWithin(root, canonicalParent))) {
      throw new Error(`路径未获用户授权: ${path.join(canonicalParent, path.basename(requested))}`);
    }
    return path.join(canonicalParent, path.basename(requested));
  }

  /** 可删除 / 可改名 / 可复制的源条目：不能是文件系统根，也不能是已授权工作区根。 */
  private movableSource(raw: string): string {
    const requested = validateAbsolute(raw);
    if (path.parse(requested).root === requested) {
      throw new Error("不能操作文件系统根目录");
    }
    const canonical = canonicalExisting(requested);
    if (this.roots.includes(canonical)) {
      throw new Error("不能移动或删除已授权的工作区根目录");
    }
    const entry = this.resolveEntry(raw);
    let exists = true;
    try {
      lstatSync(entry);
    } catch {
      exists = false;
    }
    if (!exists) throw new Error(`路径不存在: ${entry}`);
    return entry;
  }

  /** 删除：目录递归删（删的是条目本身，不跟随链接）。 */
  deletePath(raw: string): void {
    const entry = this.movableSource(raw);
    try {
      if (lstatSync(entry).isDirectory()) {
        rmSync(entry, { recursive: true });
      } else {
        unlinkSync(entry);
      }
    } catch (error) {
      throw new Error(`删除失败: ${(error as Error).message}`, { cause: error });
    }
  }

  /** 改名 / 移动：撞名显式失败（Unix rename 会静默覆盖），跨设备降级为复制 + 删源。 */
  renamePath(from: string, to: string): void {
    const source = this.movableSource(from);
    const target = this.resolveNewEntry(to);
    if (comparable(source) === comparable(target)) throw new Error("新名称与原名称相同");
    if (isWithin(source, target)) throw new Error("不能把文件夹移动到它自己内部");
    if (existsSync(target)) throw new Error(`目标已存在: ${target}`);
    try {
      renameSync(source, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EXDEV") {
        this.moveAcrossDevices(source, target);
        return;
      }
      throw new Error(`移动失败: ${(error as Error).message}`, { cause: error });
    }
  }

  /** 跨挂载点：先复制、成功后再删源（中途失败最多多个副本，不会丢数据）。 */
  private moveAcrossDevices(source: string, target: string): void {
    if (hasLinkInside(source)) {
      throw new Error("条目内含符号链接，跨磁盘分区移动会丢失这些链接；请改用复制后手动删除");
    }
    try {
      copyEntry(source, target);
    } catch (error) {
      rmSync(target, { recursive: true, force: true });
      throw new Error(`跨磁盘分区移动失败（复制阶段）: ${(error as Error).message}`, { cause: error });
    }
    try {
      rmSync(source, { recursive: true });
    } catch (error) {
      throw new Error(`已复制到目标，但删除源失败: ${(error as Error).message} —— 请手动删除 ${source}`, { cause: error });
    }
  }

  /** 复制（目录递归）：源不能是符号链接，目标必须不存在，且不能复制进自身内部。 */
  copyPath(from: string, to: string): void {
    const source = this.movableSource(from);
    if (lstatSync(source).isSymbolicLink()) throw new Error("不支持复制符号链接");
    const target = this.resolveNewEntry(to);
    if (isWithin(source, target)) throw new Error("不能把文件夹复制到它自己内部");
    if (existsSync(target)) throw new Error(`目标已存在: ${target}`);
    try {
      copyEntry(source, target);
    } catch (error) {
      rmSync(target, { recursive: true, force: true });
      throw new Error(`复制失败: ${(error as Error).message}`, { cause: error });
    }
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

  /** 读二进制（≤20MB，原始字节；超限报错而不是截断）。 */
  readBinary(raw: string): Buffer {
    const file = this.resolveExisting(raw);
    const metadata = statSync(file);
    if (metadata.size > MAX_BINARY_BYTES) {
      throw new Error("文件超过 20MB 上限");
    }
    try {
      return readFileSync(file);
    } catch (error) {
      throw new Error(`读取文件失败: ${(error as Error).message}`, { cause: error });
    }
  }

  /** 读媒体（视频 / 3D / GIS）：上限由调用方给并夹到 128MB（缺省 20MB）。 */
  readMedia(raw: string, maxBytes: unknown): Buffer {
    const requested = typeof maxBytes === "number" && Number.isFinite(maxBytes) ? Math.floor(maxBytes) : MAX_BINARY_BYTES;
    const limit = Math.min(Math.max(requested, 0), MAX_MEDIA_BYTES);
    const file = this.resolveExisting(raw);
    const metadata = statSync(file);
    if (metadata.size > limit) {
      throw new Error(`文件超过 ${Math.floor(limit / (1024 * 1024))}MB 上限`);
    }
    return readFileSync(file);
  }

  /** 写二进制（base64 载荷，≤20MB）；上限以**解码后**字节数为准。 */
  writeBinary(raw: string, dataBase64: string): void {
    // base64 会把载荷撑大约 4/3：先按编码串长度粗筛，避免为一个超大字符串白分配缓冲。
    const maxEncoded = (MAX_BINARY_BYTES / 3) * 4 + 8;
    if (dataBase64.length > maxEncoded) throw new Error("文件超过 20MB 上限");
    const data = Buffer.from(dataBase64, "base64");
    if (data.length > MAX_BINARY_BYTES) throw new Error("文件超过 20MB 上限");
    const target = this.resolveWrite(raw);
    try {
      writeFileSync(target, data);
    } catch (error) {
      throw new Error(`写入文件失败: ${(error as Error).message}`, { cause: error });
    }
  }

  /** 探测文件能否按文本预览 / 编辑（只读前 8KB，不把大文件整个读进来）。 */
  probeFile(raw: string): FileProbe {
    const file = this.resolveExisting(raw);
    const metadata = statSync(file);
    const prefix = readPrefix(file, PROBE_PREFIX_BYTES);
    return probeBytes(prefix, metadata.size);
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

/** 路径比较：Linux 区分大小写；Windows / macOS 折叠大小写与分隔符（与 Rust 的 same_path 一致）。 */
function comparable(value: string): string {
  return process.platform === "linux" ? value : value.replace(/\\/g, "/").toLowerCase();
}

/** 递归复制：目录内的符号链接一律跳过（跟随会把根外内容搬进来，环状链接会无限展开）。 */
function copyEntry(source: string, target: string): void {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    mkdirSync(target);
    for (const name of readdirSync(source)) {
      copyEntry(path.join(source, name), path.join(target, name));
    }
    return;
  }
  copyFileSync(source, target);
}

/** 条目自身或（目录递归地）其内任一条目是否含符号链接；读不到按「有」处理（保守拒绝）。 */
function hasLinkInside(entry: string): boolean {
  let stat;
  try {
    stat = lstatSync(entry);
  } catch {
    return true;
  }
  if (stat.isSymbolicLink()) return true;
  if (!stat.isDirectory()) return false;
  try {
    return readdirSync(entry).some((name) => hasLinkInside(path.join(entry, name)));
  } catch {
    return true;
  }
}

export { MAX_TEXT_BYTES };
