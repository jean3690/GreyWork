import { fetchJson, isTauriRuntime } from "@greywork/core";
import type { SkillSnapshotFile, SkillsMarketTransport } from "./types";
import { HostSkillsTransport } from "./host-transport";

/**
 * 市场通道：浏览器直连外部市场被 CORS 拦截（两端均无
 * Access-Control-Allow-Origin），统一走 Vite dev 代理（apps/desktop/vite.config.ts）。
 * Web 态仅搜索/下载可用；安装/卸载需要宿主写文件系统，Web 下明确报错。
 * 桌面态（Tauri）由 HostSkillsTransport 接管：搜索/下载/安装/卸载全部经宿主。
 */
export const MARKET_API_BASE = "/market-api";

/** Web 预览环境（浏览器，无 Tauri IPC）的 skills.sh 通道。 */
export class WebSkillsTransport implements SkillsMarketTransport {
  available(): boolean {
    return typeof window !== "undefined" && typeof window.fetch === "function";
  }

  /** Web 无法写用户文件系统；安装/卸载仅桌面端。 */
  installable(): boolean {
    return false;
  }

  async search(query: string, origin?: string): Promise<unknown> {
    const base = origin ? origin.replace(/\/+$/, "") : MARKET_API_BASE;
    const prefix = origin ? "" : "/skills";
    return fetchJson(`${base}${prefix}/api/search?q=${encodeURIComponent(query)}`, "skills market");
  }

  async download(entryRef: string, origin?: string): Promise<unknown> {
    const parts = entryRef.split("/");
    if (parts.length !== 3) throw new Error(`ref is not a downloadable repo skill (expect owner/repo/skill): ${entryRef}`);
    const encoded = parts.map((part) => encodeURIComponent(part)).join("/");
    if (origin) {
      return fetchJson(`${origin.replace(/\/+$/, "")}/api/download/${encoded}`, "skills market");
    }
    return fetchJson(`${MARKET_API_BASE}/skills/api/download/${encoded}`, "skills market");
  }

  install(workspaceRoot: string, skillId: string, _files: SkillSnapshotFile[]): Promise<{ dir: string; filesWritten: number }> {
    return Promise.reject(new Error(`skills install requires the desktop host (Tauri): ${workspaceRoot.trim()}/.agents/skills/${skillId}`));
  }

  uninstall(workspaceRoot: string, skillId: string): Promise<void> {
    return Promise.reject(
      new Error(`skills uninstall requires the desktop host (Tauri): ${workspaceRoot.trim()}/.agents/skills/${skillId}`),
    );
  }
}

/** 运行时自适应工厂：桌面态走宿主 IPC（搜索/下载/安装/卸载全可用），浏览器态退回 Web 直连通道。 */
export function createSkillsTransport(): SkillsMarketTransport {
  return isTauriRuntime() ? new HostSkillsTransport() : new WebSkillsTransport();
}
