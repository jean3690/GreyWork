/**
 * ACP 后端目录双态后端（Agent 管理面）。
 *
 * - Tauri 桌面态：SQLite agent_providers 真源（db_agents_load / db_agents_sync）；
 *   enabled 启停由宿主持久化——渲染端内置缺省只做首次 seed。
 * - 浏览器态：无后端 → load null / save no-op，agent store 以 localStorage 缓存兜底。
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@greywork/core";

/** 与 Rust AgentProviderDto 对齐（camelCase）。 */
export interface AgentProviderRow {
  id: string;
  name: string;
  kind: "acp";
  command: string;
  enabled: boolean;
  /** 启动环境变量（JSON 对象文本）；null = 继承宿主环境。 */
  env: string | null;
}

/** 单个入口程序的 PATH 探测结果。 */
export interface AgentProgramProbe {
  program: string;
  installed: boolean;
  path: string | null;
}

export const agentsBackend = {
  /** 当前运行时是否有后端真源（Tauri 桌面）。 */
  active(): boolean {
    return isTauriRuntime();
  },

  /** 读目录；库未接管 → null（store 以内置缺省 seed 并首落库）。 */
  async load(): Promise<AgentProviderRow[] | null> {
    if (!isTauriRuntime()) return null;
    return await invoke<AgentProviderRow[] | null>("db_agents_load");
  },

  /** 全量替换目录（事务幂等；启停切换驱动）。 */
  async save(providers: AgentProviderRow[]): Promise<void> {
    if (!isTauriRuntime()) return;
    await invoke("db_agents_sync", { providers });
  },

  /**
   * PATH 探测各后端 CLI 是否已安装（纯 stat，不起进程）。
   * 浏览器态无宿主 → null，UI 按「未知」处理不显示状态。
   */
  async detect(programs: string[]): Promise<AgentProgramProbe[] | null> {
    if (!isTauriRuntime() || programs.length === 0) return null;
    const probes = await invoke<AgentProgramProbe[]>("acp_detect_programs", { programs });
    return Array.isArray(probes) ? probes : null;
  },
};
