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
  /** 实际目录地址；宿主搜索返回默认 Java 地址，自定义源显式给出，下载与更新保持同源。 */
  origin?: string;
}

export interface SkillSnapshotFile {
  path: string;
  contents: string;
}

export interface SkillSnapshot {
  files: SkillSnapshotFile[];
  hash: string;
  /** 宿主盖章的实际下载地址（第三方快照自身的同名字段不作为路由依据）。 */
  origin?: string;
}

/** 随宿主二进制发布的内置技能条目（内容已编译进宿主，不联网）。 */
export interface BundledSkillMeta {
  id: string;
  name: string;
  description: string;
  /** 该技能包含的文件相对路径（含 SKILL.md）。 */
  files: string[];
}

/** 技能市场传输抽象（Web 预览经 Vite 代理；桌面/headless 经宿主命令）。 */
export interface SkillsMarketTransport {
  available(): boolean;
  /** 安装/卸载是否可用（Web 预览无宿主文件写入通道）。 */
  installable(): boolean;
  /** origin 为空时走默认 Java 后端目录。 */
  search(query: string, origin?: string): Promise<unknown>;
  /** origin 为空时走默认 Java 后端目录。 */
  download(entryRef: string, origin?: string): Promise<unknown>;
  install(workspaceRoot: string, skillId: string, files: SkillSnapshotFile[]): Promise<{ dir: string; filesWritten: number }>;
  uninstall(workspaceRoot: string, skillId: string): Promise<void>;
  /** 内置技能目录。无宿主时返回空数组（不报错，UI 直接不显示该区）。 */
  bundledList(): Promise<BundledSkillMeta[]>;
  /** 安装一份内置技能（宿主按 id 从内置清单取内容写盘）。 */
  installBundled(workspaceRoot: string, skillId: string): Promise<{ dir: string; filesWritten: number }>;
}

export interface SkillSourceAdapter {
  id: string;
  label: string;
  description: string;
  search(query: string): Promise<MarketSkillEntry[]>;
  download(entry: MarketSkillEntry): Promise<SkillSnapshot>;
}
