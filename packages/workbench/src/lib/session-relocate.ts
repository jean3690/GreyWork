/**
 * 工作区改绑文件夹时的会话文件搬迁。
 *
 * 只有桌面文件面才按工作区分目录落盘（`<工作区>/.greyWork/sessions/`），所以搬迁
 * 也只在桌面态有意义；浏览器态（含 WebDAV 远端）所有会话平铺在一个目录里，归属靠
 * 会话内的 workspaceId 字段表达，无需搬文件。
 */

import { invoke } from "@tauri-apps/api/core";
import { sessionBackend } from "./session-backend";
import { useSessionStore } from "../stores/session";

export interface RelocateResult {
  moved: number;
  /** 源侧本来就没有文件的会话 id（新建后还没落盘过）。 */
  missing: string[];
  /** 目标侧已有更新版本、两边都保留的会话 id。 */
  conflicts: string[];
}

const NOTHING_TO_DO: RelocateResult = { moved: 0, missing: [], conflicts: [] };

export async function relocateWorkspaceSessions(
  workspaceId: string,
  fromFolder: string | undefined,
  toFolder: string | undefined,
): Promise<RelocateResult> {
  if (!sessionBackend.hasWorkspaceDirs()) return NOTHING_TO_DO;
  const sessionStore = useSessionStore();
  const sessionIds = sessionStore.sessionsOf(workspaceId).map((session) => session.id);
  if (!sessionIds.length) return NOTHING_TO_DO;
  const report = await invoke<RelocateResult>("store_sessions_relocate", {
    request: { sessionIds, fromFolder: fromFolder ?? null, toFolder: toFolder ?? null },
  });
  // 搬完再落一次盘：新目录里补齐 active.json / .ready，并让后续增量比对基于新位置
  sessionStore.persist();
  return report;
}
