/**
 * 宿主命令目录：`GET /api/commands` 的薄封装。
 *
 * 服务端把「哪条命令在本宿主真的可调」暴露出来（desktopOnly / 服务端黑名单），
 * 渲染端据此决定「调之前就别调」或「灰显并说明」—— 与其调了 403 再解释，不如
 * 先知道。
 *
 * **只服务服务端态**：桌面态的命令可用性由 `isTauriRuntime()` 表达（桌面专属命令
 * 全在它后面），不重复建模；浏览器预览态没有宿主。两种情况都返回 `null`，调用方
 * 以 null 为「无目录」处理（fail-open，不误禁）。
 */

import { API_BASE } from "./error";
import { runtimeMode } from "./runtime";

/** 单条命令的能力描述（camelCase，与 `/api/commands` 逐字对齐）。 */
export interface CommandCatalogEntry {
  name: string;
  auth: "required" | "none";
  /** 任何宿主都没有这条命令（原生对话框 / 托盘 / 系统浏览器等）。 */
  desktopOnly: boolean;
  /** 返回值是原始字节（`application/octet-stream`）。 */
  binary: boolean;
  /** 在本宿主是否可调用 —— 桌面专属与服务端黑名单都是 false。 */
  available: boolean;
}

/**
 * 拉取宿主命令目录。
 *
 * 非 `server` 态返回 `null`（不发请求）；HTTP 失败也返回 `null` 而不抛 —— 目录是
 * 增强的元信息，拉不到不该让调用点失败（调用真失败时命令端点自己会报错）。
 */
export async function loadCommandCatalog(): Promise<CommandCatalogEntry[] | null> {
  if (runtimeMode() !== "server") return null;
  try {
    const response = await fetch(`${API_BASE}/commands`, { credentials: "same-origin" });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    return parseCatalog(body);
  } catch {
    return null;
  }
}

/** 宽进解析：条目缺字段/类型不对的丢弃，整包不是数组返回 null。 */
function parseCatalog(body: unknown): CommandCatalogEntry[] | null {
  if (!Array.isArray(body)) return null;
  const entries: CommandCatalogEntry[] = [];
  for (const item of body) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (
      typeof record.name !== "string" ||
      (record.auth !== "required" && record.auth !== "none") ||
      typeof record.desktopOnly !== "boolean" ||
      typeof record.binary !== "boolean" ||
      typeof record.available !== "boolean"
    ) {
      continue;
    }
    entries.push({
      name: record.name,
      auth: record.auth,
      desktopOnly: record.desktopOnly,
      binary: record.binary,
      available: record.available,
    });
  }
  return entries;
}
