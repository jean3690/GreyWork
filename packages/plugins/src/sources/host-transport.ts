import { invoke } from "@tauri-apps/api/core";
import type { SkillSnapshotFile, SkillsMarketTransport } from "./types";

/**
 * 桌面宿主通道：搜索/下载/安装/卸载全部经 Tauri IPC 走 Rust 宿主
 * （skills_market.rs）。宿主承担网络转发与写盘安全校验，渲染端不直连外网。
 *
 * Rust 返回形状与 Web 不同（serde 蛇形键、search 直接是数组），这里归一为
 * Web 通道同款形状，下游 `mapSearchResponse` / `parseSnapshot` 无感复用。
 */

/** Rust skills_market::MarketSkillEntry 的 serde 序列化形状（snake_case + ref）。 */
interface HostSkillEntry {
  ref: string;
  skill_id: string;
  name: string;
  installs: number;
  source: string;
  downloadable: boolean;
}

/** Rust SkillSnapshot 形状；files/hash 键名与 Web 一致，可直接透传。 */
interface HostSkillSnapshot {
  files: SkillSnapshotFile[];
  hash: string;
}

/** Rust 数组 → `{ skills: [...] }`（补 Web 侧期望的 id 键，skillId 归一为驼峰）。 */
export function wrapHostSearch(items: HostSkillEntry[]): { skills: unknown[] } {
  return {
    skills: items.map((item) => ({
      id: item.ref,
      skillId: item.skill_id,
      name: item.name,
      installs: item.installs,
      source: item.source,
      downloadable: item.downloadable,
    })),
  };
}

/** Tauri 桌面态（存在宿主命令）的 skills.sh 通道。 */
export class HostSkillsTransport implements SkillsMarketTransport {
  available(): boolean {
    return true;
  }

  installable(): boolean {
    return true;
  }

  async search(query: string): Promise<unknown> {
    const items = await invoke<HostSkillEntry[]>("skills_search", { query });
    return wrapHostSearch(items);
  }

  async download(entryRef: string): Promise<unknown> {
    return invoke<HostSkillSnapshot>("skills_download", { entryRef });
  }

  async install(workspaceRoot: string, skillId: string, files: SkillSnapshotFile[]): Promise<{ dir: string; filesWritten: number }> {
    return invoke("skills_install", { workspaceRoot, skillId, files });
  }

  async uninstall(workspaceRoot: string, skillId: string): Promise<void> {
    await invoke("skills_uninstall", { workspaceRoot, skillId });
  }
}
