/**
 * ACP 后端目录三态后端（Agent 管理面）。
 *
 * - 桌面 / 服务端：SQLite agent_providers 真源（db_agents_load / db_agents_sync）；
 *   enabled 启停由宿主持久化——渲染端内置缺省只做首次 seed。
 * - 服务端另有一条限制：db_agents_sync 通常被服务端禁用（启动命令属于不可信输入，
 *   不能由浏览器改写），目录在服务端**只读**。是否可写由调用方先问命令能力表判定
 *   （stores/agent 的 providers 切片，unknown 按不可写）—— 本门面不内嵌策略，这样
 *   服务端放开禁用时前端零改动自动恢复同步；即便调用方漏判，服务端也会 403 兜底。
 * - 浏览器预览：无后端 → load null / save no-op，agent store 以 localStorage 缓存兜底。
 */

import { hasHostCommands, invoke } from "@greywork/host-ipc";

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

  /** 全量替换目录（事务幂等；启停切换驱动）。写路径是否可用由调用方经命令能力表先行判定。 */
  async save(providers: AgentProviderRow[]): Promise<void> {
    if (!hasHostCommands()) return;
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
