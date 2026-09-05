import {
  createMemoryFileSystem,
  createMemoryGitService,
  type GitService,
  type GitStatusEntry,
  type WorkspaceFileSystem,
} from "@greywork/editor";
import { defineStore } from "pinia";
import { computed, ref } from "vue";

/** 种子工作区：虚拟文件系统的初始快照，同时是内存 git 的首个基线。 */
export const WORKSPACE_SEED: Record<string, string> = {
  "src/plugins/index.ts": [
    "import { createPluginRegistry } from '@greywork/plugins';",
    "import { createCommandGuard } from '@greywork/plugins';",
    "",
    "const registry = createPluginRegistry();",
    "const guard = createCommandGuard();",
    "",
    "registry.register({",
    "  id: 'skill-gis',",
    "  kind: 'skill',",
    "  name: 'GIS 分析 Skill',",
    "  entry: 'skills/gis.md',",
    "});",
    "",
    "export const gw = { registry, guard };",
    "",
  ].join("\n"),
  "packages/shell/src/reasoning.ts": [
    "/** 推理等级 → 采样参数（宿主接入前为静态映射）。 */",
    "export const REASONING_PRESET = {",
    "  low: { temperature: 0.7 },",
    "  medium: { temperature: 0.4 },",
    "  high: { temperature: 0.2 },",
    "  xhigh: { temperature: 0.1 },",
    "} as const;",
    "",
  ].join("\n"),
  "reports/城市态势报告.md": [
    "# 城市态势报告",
    "",
    "GreyWork 自动从 GeoJSON 与 MBTiles 中提取空间统计。",
    "",
    "> 百万级点云已在 DuckDB-WASM 中完成聚合。",
    "",
  ].join("\n"),
  "data/stations.csv": [
    "id,name,lon,lat,value",
    "pt-001,北京站,116.3913,39.9075,1284",
    "pt-002,上海站,121.4737,31.2304,2231",
    "pt-003,深圳站,114.0579,22.5431,876",
    "pt-004,新加坡站,103.8198,1.3521,542",
    "",
  ].join("\n"),
};

/** 模块级共享单例：编辑器 / Diff / 状态栏 / chat 管线全部读写同一份虚拟文件系统。 */
export const workspaceFs: WorkspaceFileSystem = createMemoryFileSystem(WORKSPACE_SEED);
export const workspaceGit: GitService = createMemoryGitService(workspaceFs);
/** 磁盘写回钩子：工作区绑定存放文件夹后，编辑器保存同步写回真实磁盘（未命中注册路径时为空操作）。 */
type DiskWriter = (path: string, content: string) => Promise<void>;
let diskWriter: DiskWriter | null = null;
export function setDiskWriter(writer: DiskWriter | null): void {
  diskWriter = writer;
}

const STATUS_LETTER: Record<GitStatusEntry["status"], string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "U",
};

export function statusLetter(status: GitStatusEntry["status"]): string {
  return STATUS_LETTER[status];
}

interface VfsTreeNode {
  name: string;
  /** 从根起的完整路径（目录无尾斜杠）。 */
  path: string;
  kind: "file" | "directory";
  children?: VfsTreeNode[];
}

/** 目录节点：children 必在（区别于尚未展开的树节点），Map 登记用。 */
interface VfsDirNode extends VfsTreeNode {
  kind: "directory";
  children: VfsTreeNode[];
}

/**
 * 平铺路径清单 → 目录树（目录在前、同层按名排序），供右栏 OS 风格文件列表。
 * 目录按前缀登记进 Map，每段 O(1) 下钻 —— 原先每段都在兄弟列表里 find() 线性扫，
 * 单个目录上千子项时是 O(n²)。排序只在末尾做一次整树递归。
 */
export function buildFileTree(paths: string[]): VfsTreeNode[] {
  const root: VfsTreeNode[] = [];
  const dirByPath = new Map<string, VfsDirNode>();
  for (const path of paths) {
    const parts = path.split("/");
    let level: VfsTreeNode[] = root;
    let prefix = "";
    for (let depth = 0; depth < parts.length; depth += 1) {
      const name = parts[depth];
      prefix = prefix ? `${prefix}/${name}` : name;
      const isFile = depth === parts.length - 1;
      if (isFile) {
        level.push({ name, path: prefix, kind: "file" });
        break;
      }
      let node = dirByPath.get(prefix);
      if (!node) {
        node = { name, path: prefix, kind: "directory", children: [] };
        dirByPath.set(prefix, node);
        level.push(node);
      }
      level = node.children;
    }
  }
  const sortLevel = (nodes: VfsTreeNode[]): VfsTreeNode[] => {
    nodes.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1));
    for (const node of nodes) if (node.children) sortLevel(node.children);
    return nodes;
  };
  return sortLevel(root);
}

/** 活动工作区：路径清单 + 当前打开文件 + 相对 git 基线的变更（带行级增删统计）。 */
export const useVfsStore = defineStore("vfs", () => {
  const paths = ref<string[]>(Object.keys(WORKSPACE_SEED).sort());
  const activePath = ref("src/plugins/index.ts");
  const activeContent = ref(WORKSPACE_SEED[activePath.value] ?? "");
  const savedContent = ref(activeContent.value);
  /** git 变更（status + 行级统计，来自内存 git 的真实基线）。 */
  const changes = ref<Awaited<ReturnType<typeof workspaceGit.changes>>>([]);

  const dirty = computed(() => activeContent.value !== savedContent.value);

  async function refreshStatus(): Promise<void> {
    changes.value = await workspaceGit.changes();
  }

  /** 打开文件到编辑器（内容读自虚拟文件系统）。 */
  async function open(path: string): Promise<void> {
    activePath.value = path;
    activeContent.value = await workspaceFs.readFile(path);
    savedContent.value = activeContent.value;
  }

  /** 保存当前打开文件并刷新变更；绑定工作区存放文件夹时同步写回磁盘。 */
  async function saveActive(): Promise<void> {
    await workspaceFs.writeFile(activePath.value, activeContent.value);
    savedContent.value = activeContent.value;
    await refreshStatus();
    await diskWriter?.(activePath.value, activeContent.value);
  }

  /** 管线 / 面板写入任意文件（新文件自动入清单）。 */
  async function write(path: string, content: string): Promise<void> {
    await workspaceFs.writeFile(path, content);
    if (!paths.value.includes(path)) paths.value = [...paths.value, path].sort();
    if (path === activePath.value) {
      activeContent.value = content;
      savedContent.value = content;
    }
    await refreshStatus();
  }

  /** 写入二进制产物（xlsx 等）：入文件清单，不参与文本编辑与 git diff。 */
  async function writeBinary(path: string, data: Uint8Array): Promise<void> {
    await workspaceFs.writeBinary(path, data);
    if (!paths.value.includes(path)) paths.value = [...paths.value, path].sort();
  }

  async function readBinary(path: string): Promise<Uint8Array> {
    return workspaceFs.readBinary(path);
  }

  /** 读取任意文本文件（不改动编辑态）。 */
  async function readFile(path: string): Promise<string> {
    return workspaceFs.readFile(path);
  }

  async function remove(path: string): Promise<void> {
    await workspaceFs.delete(path);
    paths.value = paths.value.filter((candidate) => candidate !== path);
    await refreshStatus();
  }

  void refreshStatus();

  return {
    paths,
    activePath,
    activeContent,
    savedContent,
    changes,
    dirty,
    open,
    saveActive,
    write,
    writeBinary,
    readBinary,
    readFile,
    remove,
    refreshStatus,
  };
});
