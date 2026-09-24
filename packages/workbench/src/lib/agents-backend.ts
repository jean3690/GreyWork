/**
 * ACP 后端目录三态后端（Agent 管理面）。
 *
 * - 桌面 / 服务端：SQLite agent_providers 真源（db_agents_load / db_agents_sync）；
 *   enabled 启停由宿主持久化——渲染端内置缺省只做首次 seed。
 * - 服务端另有一条限制：db_agents_sync 在服务端被禁用（启动命令属于不可信输入，
 *   不能由浏览器改写），所以目录在服务端是**只读**的，save 会明确抛错而不是静默丢弃。
 * - 浏览器预览：无后端 → load null / save no-op，agent store 以 localStorage 缓存兜底。
 */

import { hasHostCommands, invoke, runtimeMode } from "@greywork/host-ipc";

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
  /** 当前运行时是否有后端真源（桌面 / 服务端宿主）。 */
  active(): boolean {
    return hasHostCommands();
  },

  /** 读目录；库未接管 → null（store 以内置缺省 seed 并首落库）。 */
  async load(): Promise<AgentProviderRow[] | null> {
    if (!hasHostCommands()) return null;
    return await invoke<AgentProviderRow[] | null>("db_agents_load");
  },

  /** 全量替换目录（事务幂等；启停切换驱动）。服务端为只读，抛错而非静默丢弃改动。 */
  async save(providers: AgentProviderRow[]): Promise<void> {
    if (!hasHostCommands()) return;
    if (runtimeMode() === "server") {
      throw new Error("服务端模式下 agent 目录只读：db_agents_sync 已被服务端禁用");
    }
    await invoke("db_agents_sync", { providers });
  },

  /**
   * PATH 探测各后端 CLI 是否已安装（纯 stat，不起进程）。
   * 浏览器预览无宿主 → null，UI 按「未知」处理不显示状态。
   */
  async detect(programs: string[]): Promise<AgentProgramProbe[] | null> {
    if (!hasHostCommands() || programs.length === 0) return null;
    const probes = await invoke<AgentProgramProbe[]>("acp_detect_programs", { programs });
    return Array.isArray(probes) ? probes : null;
  },
};
