/** 技能市场源适配层类型。发现（search）与分发（download）分离， */
/** 传输实现可注入（桌面 = Tauri IPC 宿主代理；测试 = 假传输）。 */

export interface MarketSkillEntry {
  /** 完整引用："owner/repo/skillId"；site 源（如 open.feishu.cn/lark-doc）不可下载 */
  ref: string;
  skillId: string;
  name: string;
  installs: number;
  source: string;
  downloadable: boolean;
  /** 条目所属源的自定义 origin（覆盖默认 skills.sh 时设置；下载走该源）。 */
  origin?: string;
}

export interface SkillSnapshotFile {
  path: string;
  contents: string;
}

export interface SkillSnapshot {
  files: SkillSnapshotFile[];
  hash: string;
}

/** 技能市场传输抽象（Web 通道经 vite 代理；宿主命令已移除）。 */
export interface SkillsMarketTransport {
  available(): boolean;
  /** 安装/卸载是否可用（Web 预览无宿主文件写入通道）。 */
  installable(): boolean;
  /** origin 为空时走默认市场（skills.sh）。 */
  search(query: string, origin?: string): Promise<unknown>;
  /** origin 为空时走默认市场（skills.sh）。 */
  download(entryRef: string, origin?: string): Promise<unknown>;
  install(workspaceRoot: string, skillId: string, files: SkillSnapshotFile[]): Promise<{ dir: string; filesWritten: number }>;
  uninstall(workspaceRoot: string, skillId: string): Promise<void>;
}

export interface SkillSourceAdapter {
  id: string;
  label: string;
  description: string;
  search(query: string): Promise<MarketSkillEntry[]>;
  download(entry: MarketSkillEntry): Promise<SkillSnapshot>;
}
