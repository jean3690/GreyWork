import { invoke } from "@tauri-apps/api/core";
import { isAbsolutePath, isTauriRuntime, joinPath } from "@greywork/core";
import { useWorkspaceStore } from "../stores/workspace";
import { ensureDir, writeBinaryFile, writeTextFile } from "../state/workspaceFiles";

/**
 * AI 产物默认落盘（桌面端）：
 * - 当前激活工作区绑定了磁盘文件夹 → <工作区>/artifacts/
 * - 未绑定工作区 → ~/.greyWork/artifacts/
 * 浏览器态无磁盘通道 → null（不落盘，查看器内 VFS 照常）。
 */

let defaultRootPromise: Promise<string | null> | null = null;

function defaultArtifactsRoot(): Promise<string | null> {
  if (!isTauriRuntime()) return Promise.resolve(null);
  defaultRootPromise ??= invoke<string>("store_default_root").catch(() => null);
  return defaultRootPromise;
}

/** 当前激活工作区的磁盘文件夹（绝对路径；未绑定 → null）。 */
export function activeWorkspaceFolder(): string | null {
  const id = useWorkspaceStore().activeWorkspaceId;
  const folder = id ? useWorkspaceStore().workspaceById(id)?.folder : undefined;
  return folder && isAbsolutePath(folder) ? folder : null;
}

/** 产物目标目录（不存在则创建）；浏览器态返回 null。 */
export async function resolveArtifactsDir(): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const bound = activeWorkspaceFolder();
  const root = bound ?? (await defaultArtifactsRoot());
  if (!root) return null;
  const dir = joinPath(root, "artifacts");
  await ensureDir(dir);
  return dir;
}

/**
 * 文件名净化（去路径分隔与控制字符）。
 *
 * 控制字符用 `\p{Cc}` 而不是字面量 `[\u0000-\u001f]`：字面量会触发 `no-control-regex`
 * （规则只认字面控制字符），而 Unicode 属性还顺带盖住 C1 区 U+0080–U+009F，
 * 那一段同样能把文件名写成宿主看不懂的东西。
 */
function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[/\\]/g, "_")
    .replace(/\p{Cc}/gu, "_")
    .trim();
  return cleaned || "artifact";
}

/**
 * 把 AI 产物写入默认目录并返回磁盘路径；失败/浏览器态 → null。
 * 文本与二进制共用同一入口（Uint8Array 走 base64 通道）。
 */
export async function saveArtifactToDisk(fileName: string, data: string | Uint8Array): Promise<string | null> {
  try {
    const dir = await resolveArtifactsDir();
    if (!dir) return null;
    const path = joinPath(dir, safeFileName(fileName));
    if (typeof data === "string") await writeTextFile(path, data);
    else await writeBinaryFile(path, data);
    return path;
  } catch (error) {
    console.warn("[artifact] 产物默认落盘失败（不影响查看器内登记）", error);
    return null;
  }
}
