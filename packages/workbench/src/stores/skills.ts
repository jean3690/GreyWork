import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { isTauriRuntime } from "@greywork/core";
import { createSkillsShSource, createSkillsTransport, type MarketSkillEntry, type SkillsMarketTransport } from "@greywork/plugins";
import { resolveWorkspaceRoot, type WorkspaceRootResolution } from "../lib/workspace-dir";
import { listDir, readTextFile } from "../state/workspaceFiles";

/**
 * 技能设置面板的数据面：两块各自独立 ——
 *
 * 1. 已安装：扫描工作区 `.agents/skills/*` 磁盘真源（兼容外部 ACP agent 手动
 *    放进来的技能），读各 SKILL.md frontmatter 拿 name/description；
 * 2. 发现：skills.sh 官方市场搜索 → 下载快照 → 宿主写盘（install 覆盖即更新）。
 *
 * 安装目标是 ACP agent（opencode / claude-code / codex 等）的原生技能目录，
 * 装完新开会话即被识别。浏览器态（无宿主）只读不写。
 */

/** 磁盘上已安装的一个技能。 */
export interface InstalledSkill {
  id: string;
  name: string;
  description?: string;
  /** 技能目录绝对路径。 */
  dir: string;
}

/** 本应用经市场装过的记录（localStorage；磁盘真源以 listInstalled 扫描为准）。 */
export interface SkillInstallRecord {
  ref: string;
  skillId: string;
  hash: string;
  installedAt: number;
}

export interface SkillsWorkspace {
  root: WorkspaceRootResolution;
  /** 技能目录 `<root>/.agents/skills`（不存在时为空目录）。 */
  dir: string;
}

const RECORDS_KEY = "greywork.skills.installed";

/** 解析技能目录所在工作区（未绑定则回落设置项/主目录，bound=false 由 UI 提示）。 */
export async function resolveSkillsRoot(): Promise<SkillsWorkspace> {
  const root = await resolveWorkspaceRoot();
  return { root, dir: `${root.dir}/.agents/skills` };
}

/** 解析 SKILL.md 的 YAML frontmatter（宽松单行提取；带 BOM/无 frontmatter 均容错）。 */
export function parseSkillFrontmatter(text: string): { name?: string; description?: string } {
  const body = text.replace(/^\uFEFF/, "");
  if (!body.startsWith("---")) return {};
  const end = body.indexOf("\n---", 3);
  const front = end < 0 ? body.slice(3) : body.slice(3, end);
  const out: { name?: string; description?: string } = {};
  for (const line of front.split("\n")) {
    const match = /^\s*(name|description)\s*:\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    const value = match[2].trim().replace(/^["']|["']$/g, "");
    if (value) out[match[1] as "name" | "description"] = value;
  }
  return out;
}

function isRecord(value: { ref?: unknown; skillId?: unknown; hash?: unknown; installedAt?: unknown }): boolean {
  return (
    typeof value?.ref === "string" &&
    typeof value?.skillId === "string" &&
    typeof value?.hash === "string" &&
    typeof value?.installedAt === "number"
  );
}

function loadRecords(): SkillInstallRecord[] {
  try {
    const raw = localStorage.getItem(RECORDS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
  } catch {
    return [];
  }
}

function saveRecords(records: SkillInstallRecord[]): void {
  try {
    localStorage.setItem(RECORDS_KEY, JSON.stringify(records));
  } catch {
    // localStorage 满/不可用时不阻断安装主流程（磁盘已是真源）
  }
}

function upsertRecord(records: SkillInstallRecord[], record: SkillInstallRecord): SkillInstallRecord[] {
  const rest = records.filter((existing) => existing.skillId !== record.skillId);
  return [...rest, record];
}

export const useSkillsStore = defineStore("skills", () => {
  /** 运行时自适应的市场传输（桌面 = 宿主 IPC；浏览器 = Web 直连/仅浏览）。 */
  const transport: SkillsMarketTransport = createSkillsTransport();
  const market = createSkillsShSource(transport, {
    id: "skills-sh",
    label: "Skills Directory",
    description: "skills.sh 全量聚合索引",
  });

  const hostAvailable = isTauriRuntime();
  const workspace = ref<SkillsWorkspace | null>(null);
  const workspaceResolved = ref(false);

  /** 已安装列表（磁盘扫描结果）。 */
  const installed = ref<InstalledSkill[]>([]);
  const installedLoading = ref(false);
  const installedError = ref("");

  /** 市场搜索。 */
  const searching = ref(false);
  const discoverResults = ref<MarketSkillEntry[]>([]);
  const discoverError = ref("");
  /** 当前正在安装/卸载的 skillId（按钮 loading 态）。 */
  const busyId = ref<string | null>(null);

  const records = ref<SkillInstallRecord[]>(loadRecords());
  const recordBySkillId = computed(() => new Map(records.value.map((record) => [record.skillId, record])));

  /** 工作区解析延迟到首次需要（设置面板打开/刷新时触发）。 */
  async function ensureWorkspace(): Promise<SkillsWorkspace | null> {
    if (workspace.value) return workspace.value;
    if (workspaceResolved.value) return null;
    workspaceResolved.value = true;
    try {
      workspace.value = await resolveSkillsRoot();
    } catch (error) {
      installedError.value = String(error);
      return null;
    }
    return workspace.value;
  }

  /** 扫描 `<root>/.agents/skills/*`，读各 SKILL.md frontmatter（读不到回落目录名）。 */
  async function refreshInstalled(): Promise<void> {
    installedError.value = "";
    if (!hostAvailable) {
      installed.value = [];
      return;
    }
    const ws = await ensureWorkspace();
    if (!ws) {
      installed.value = [];
      return;
    }
    installedLoading.value = true;
    try {
      const entries = await listDir(ws.dir);
      const skills: InstalledSkill[] = [];
      for (const entry of entries) {
        if (entry.kind !== "directory" || !entry.origin) continue;
        const meta = await readSkillMeta(entry.origin);
        skills.push({
          id: entry.name,
          name: meta.name ?? entry.name,
          description: meta.description,
          dir: entry.origin,
        });
      }
      skills.sort((a, b) => a.id.localeCompare(b.id));
      installed.value = skills;
    } catch (error) {
      // .agents/skills 尚不存在时 listDir 报错，视为空清单而不是故障
      installed.value = [];
      if (!String(error).includes("NotFound") && !String(error).includes("not found")) {
        installedError.value = String(error);
      }
    } finally {
      installedLoading.value = false;
    }
  }

  async function readSkillMeta(skillDir: string): Promise<{ name?: string; description?: string }> {
    try {
      const text = await readTextFile(`${skillDir}/SKILL.md`);
      return parseSkillFrontmatter(text.slice(0, 32 * 1024));
    } catch {
      return {};
    }
  }

  /** 市场搜索（Web/宿主共用，宿主态搜索经 skills.sh 宿主命令转发）。 */
  async function searchDiscover(query: string): Promise<void> {
    const trimmed = query.trim();
    discoverError.value = "";
    if (!trimmed) {
      discoverResults.value = [];
      return;
    }
    searching.value = true;
    try {
      discoverResults.value = await market.search(trimmed);
    } catch (error) {
      discoverResults.value = [];
      discoverError.value = String(error);
    } finally {
      searching.value = false;
    }
  }

  /** 安装（skillId 已存在 = 覆盖更新）。浏览器态直接拒绝。 */
  async function installFromMarket(entry: MarketSkillEntry): Promise<void> {
    const ws = await requireHostWorkspace();
    busyId.value = entry.skillId;
    try {
      const snapshot = await market.download(entry);
      await transport.install(ws.root.dir, entry.skillId, snapshot.files);
      records.value = upsertRecord(records.value, {
        ref: entry.ref,
        skillId: entry.skillId,
        hash: snapshot.hash,
        installedAt: Date.now(),
      });
      saveRecords(records.value);
      await refreshInstalled();
    } finally {
      busyId.value = null;
    }
  }

  /** 卸载已安装技能（只删技能根目录，宿主侧有 skillId 白名单收敛）。 */
  async function uninstallSkill(skillId: string): Promise<void> {
    const ws = await requireHostWorkspace();
    busyId.value = skillId;
    try {
      await transport.uninstall(ws.root.dir, skillId);
      records.value = records.value.filter((record) => record.skillId !== skillId);
      saveRecords(records.value);
      installed.value = installed.value.filter((skill) => skill.id !== skillId);
    } finally {
      busyId.value = null;
    }
  }

  /** 更新经市场安装过的技能：按安装记录重新下载并覆盖（磁盘 hash 与本地记录一并刷新）。 */
  async function updateInstalled(skillId: string): Promise<void> {
    const record = recordBySkillId.value.get(skillId);
    if (!record) throw new Error(`skill has no market record to update: ${skillId}`);
    await installFromMarket({
      ref: record.ref,
      skillId: record.skillId,
      name: record.skillId,
      installs: 0,
      source: "",
      downloadable: true,
    });
  }

  async function requireHostWorkspace(): Promise<SkillsWorkspace> {
    if (!hostAvailable) throw new Error("skills install/uninstall requires the desktop host");
    const ws = await ensureWorkspace();
    if (!ws) throw new Error(installedError.value || "workspace root unavailable");
    return ws;
  }

  /** 已知的已安装 id 集合（市场结果标注「已安装/可更新」用）。 */
  const installedIds = computed(() => new Set(installed.value.map((skill) => skill.id)));

  return {
    transport,
    market,
    hostAvailable,
    workspace,
    workspaceResolved,
    installed,
    installedLoading,
    installedError,
    searching,
    discoverResults,
    discoverError,
    busyId,
    records,
    recordBySkillId,
    installedIds,
    ensureWorkspace,
    refreshInstalled,
    searchDiscover,
    installFromMarket,
    updateInstalled,
    uninstallSkill,
  };
});
