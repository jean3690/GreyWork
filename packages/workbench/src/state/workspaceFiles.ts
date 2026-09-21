import { invoke } from "@tauri-apps/api/core";
import { basename, isTauriRuntime } from "@greywork/core";
import type { SheetTable } from "../lib/tabular";

/** 可读取的本地文件源：统一 Tauri 磁盘文件与浏览器 File 对象。 */
export interface WorkspaceFileSource {
  name: string;
  size?: number;
  /** 磁盘绝对路径（仅 Tauri 宿主）。 */
  origin?: string;
  readText(): Promise<string>;
}

/** 目录条目（选择存放文件夹后扫描）。 */
export interface WorkspaceDirEntry {
  name: string;
  kind: "file" | "directory";
  size?: number;
  /** 磁盘绝对路径（仅 Tauri 宿主）。 */
  origin?: string;
  readText(): Promise<string>;
}

export interface WorkspaceDirSource {
  /** 存放文件夹：Tauri 为磁盘路径，浏览器为所选文件夹名。 */
  path: string;
  entries: WorkspaceDirEntry[];
}

const TEXT_EXT = /\.(?:txt|md|json|csv|ts|tsx|js|jsx|vue|html|css|scss|py|rs|go|java|kt|yml|yaml|toml|xml|sh|ini|sql|log|cpp|c|h|hpp)$/i;
const MAX_TEXT_BYTES = 1024 * 1024;
/** 单次导入文本文件数量上限（避免浏览器大目录导入卡死）。 */
export const MAX_IMPORT_FILES = 50;

/** 文本候选：扩展名白名单 + 大小上限（1MB）；二进制记录但不预载内容。 */
export function isTextFile(name: string, size?: number): boolean {
  return TEXT_EXT.test(name) && (size === undefined || size <= MAX_TEXT_BYTES);
}

/** 打开文件选择器（多选）。Tauri = 宿主对话框；浏览器 = input[type=file]。 */
export function pickWorkspaceFiles(multiple: boolean): Promise<WorkspaceFileSource[]> {
  if (isTauriRuntime()) {
    return pickTauriFiles(multiple);
  }
  return pickBrowserFiles(multiple);
}

async function pickTauriFiles(multiple: boolean): Promise<WorkspaceFileSource[]> {
  const paths = await invoke<string[]>("fs_pick_files", { purpose: "workspace", multiple });
  return paths.map((path) => ({
    name: basename(path),
    origin: path,
    readText: () => invokeReadText(path),
  }));
}

function pickBrowserFiles(multiple: boolean): Promise<WorkspaceFileSource[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = multiple;
    let settled = false;
    const settle = (files: WorkspaceFileSource[]): void => {
      if (settled) return;
      settled = true;
      resolve(files);
      window.removeEventListener("focus", onFocus);
    };
    /** 取消对话框（窗口重新聚焦且未选择）时归零，避免挂起的 Promise。 */
    const onFocus = (): void => {
      setTimeout(() => settle([]), 300);
    };
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []);
      settle(
        files.map((file) => ({
          name: file.name,
          size: file.size,
          readText: () => file.text(),
        })),
      );
    });
    window.addEventListener("focus", onFocus);
    input.click();
  });
}

/** 选择存放文件夹：Tauri = 宿主目录对话框 + fs_list_dir；浏览器 = webkitdirectory。 */
export function pickWorkspaceDirectory(): Promise<WorkspaceDirSource | null> {
  if (isTauriRuntime()) {
    return pickTauriDirectory();
  }
  return pickBrowserDirectory();
}

async function pickTauriDirectory(): Promise<WorkspaceDirSource | null> {
  const selected = await invoke<string | null>("pick_workspace_folder");
  if (!selected) return null;
  const raw =
    (await invoke<{ name: string; kind: string; size?: number; path: string }[]>("fs_list_dir", {
      path: selected,
    })) ?? [];
  const entries: WorkspaceDirEntry[] = raw.map((entry) => {
    const isDir = entry.kind === "directory";
    return {
      name: entry.name,
      kind: isDir ? "directory" : "file",
      size: entry.size,
      origin: entry.path,
      readText: () => invokeReadText(entry.path),
    };
  });
  return { path: selected, entries };
}

function pickBrowserDirectory(): Promise<WorkspaceDirSource | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.setAttribute("webkitdirectory", "");
    let settled = false;
    const settle = (source: WorkspaceDirSource | null): void => {
      if (settled) return;
      settled = true;
      resolve(source);
      window.removeEventListener("focus", onFocus);
    };
    const onFocus = (): void => {
      setTimeout(() => settle(null), 300);
    };
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []);
      const rootName = files[0]?.webkitRelativePath.split("/")[0] ?? "";
      if (!rootName) {
        settle(null);
        return;
      }
      const entries: WorkspaceDirEntry[] = files.map((file) => {
        const rel = file.webkitRelativePath.slice(rootName.length + 1);
        return {
          name: rel,
          kind: "file",
          size: file.size,
          readText: () => file.text(),
        };
      });
      settle({ path: rootName, entries });
    });
    window.addEventListener("focus", onFocus);
    input.click();
  });
}

/** 读取磁盘文本文件（Rust fs_read_text_file，10MB 上限）。 */
export function readTextFile(origin: string): Promise<string> {
  return invokeReadText(origin);
}

/** 把文件内容「存放」进选择的工作区文件夹（Rust fs_write_text_file，10MB 上限）。 */
export function writeTextFile(path: string, content: string): Promise<void> {
  return invoke("fs_write_text_file", { path, content });
}

/** 确保目录存在（产物默认目录等落盘前置）。 */
export function ensureDir(path: string): Promise<void> {
  return invoke("fs_ensure_dir", { path });
}

/** 把二进制内容写入磁盘（Rust fs_write_binary，base64 载荷 ≤20MB）。 */
export function writeBinaryFile(path: string, data: Uint8Array): Promise<void> {
  return invoke("fs_write_binary", { path, dataBase64: bytesToBase64(data) });
}

/**
 * Uint8Array → base64（分块，避免大文件一次 apply 撑爆调用栈）。
 * 附件落库与产物落盘共用同一份实现，避免第二份分块逻辑各自出边界问题。
 */
export function bytesToBase64(data: Uint8Array): string {
  const bytes = new Uint8Array(data);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** base64 → Uint8Array（与 bytesToBase64 对称）。 */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * 读取磁盘二进制文件（Rust fs_read_binary，**原始字节**回传，≤20MB）。
 *
 * 走原始字节而不是 base64：base64 会把载荷撑大 33%，还要经 JSON 转义、由前端再解码一遍 ——
 * 打开预览的每一次都付这份开销。Rust 侧用 `tauri::ipc::Response`，这里拿到的是 ArrayBuffer，
 * 直接建视图，不做拷贝。
 *
 * 与 `readTextFile` 分成两个函数而不是一个「读文件」：走错通道会让 xlsx/pdf
 * 经 utf-8 解码后不可逆损坏，所以通道由调用侧按 kind 明确选定。
 */
export async function readBinaryFile(path: string): Promise<Uint8Array> {
  const raw = await invoke<ArrayBuffer | Uint8Array>("fs_read_binary", { path });
  // 视图直接复用（零拷贝）；ArrayBuffer 建视图。**其余形状直接报错而不是强转** ——
  // 契约真被改坏时，一个空的/错位的缓冲区会让 docx/xlsx 报「文件已损坏」，
  // 排查方向全在文件上，不如在这里就说清楚。
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  throw new Error(`fs_read_binary 返回了非二进制载荷：${Object.prototype.toString.call(raw)}`);
}

/**
 * 读取表格文件（Rust fs_read_sheet，calamine 解析，≤20MB）。
 *
 * 只对 `.xls` 这类渲染端读不了的老格式使用：命令按**路径**读取并走同一套授权，
 * 因此只适用于磁盘来源 —— VFS 里的内存产物没有磁盘路径，走不通这条通道。
 * 返回值已归一成字符串网格，与 xlsx / csv 两条前端通道同形。
 */
export function readSheet(path: string, sheet?: string, maxRows?: number): Promise<SheetTable> {
  return invoke<SheetTable>("fs_read_sheet", { path, sheet, maxRows });
}

/** 浅层列目录（Rust fs_list_dir）。目录树按需逐层展开，不做递归扫描 —— 大仓库一次递归会卡死。 */ export async function listDir(
  path: string,
): Promise<WorkspaceDirEntry[]> {
  const raw = (await invoke<{ name: string; kind: string; size?: number; path: string }[]>("fs_list_dir", { path })) ?? [];
  return raw.map((entry) => ({
    name: entry.name,
    kind: entry.kind === "directory" ? "directory" : "file",
    size: entry.size,
    origin: entry.path,
    readText: () => invokeReadText(entry.path),
  }));
}

function invokeReadText(path: string): Promise<string> {
  return invoke<string>("fs_read_text_file", { path });
}
