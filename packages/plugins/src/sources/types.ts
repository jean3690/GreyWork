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
}

export interface SkillSnapshotFile {
  path: string;
  contents: string;
}

export interface SkillSnapshot {
  files: SkillSnapshotFile[];
  hash: string;
}

/** 对宿主命令的传输抽象（skills_market.rs 的四个命令）。 */
export interface SkillsMarketTransport {
  available(): boolean;
  search(query: string): Promise<unknown>;
  download(entryRef: string): Promise<unknown>;
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
