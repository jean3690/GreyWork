import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { hasHostCommands } from "@greywork/host-ipc";
import { joinPath } from "@greywork/core";
import {
  createSkillsShSource,
  createSkillsTransport,
  parseSnapshot,
  SKILLS_SH_DEFAULT_ORIGIN,
  type BundledSkillMeta,
  type MarketSkillEntry,
  type SkillSourceAdapter,
  type SkillSnapshot,
  type SkillsMarketTransport,
} from "@greywork/plugins";
import { useSettingsStore } from "./settings";
import { resolveWorkspaceRoot, type WorkspaceRootResolution } from "../lib/workspace-dir";
import { listDir, readTextFile } from "../state/workspaceFiles";

/**
 * 技能设置面板的数据面：三块各自独立 ——
 *
 * 1. 已安装：扫描工作区 `.agents/skills/*` 磁盘真源（兼容外部 ACP agent 手动
 *    放进来的技能），读各 SKILL.md frontmatter 拿 name/description；
 * 2. 内置：随宿主二进制发布的技能目录（`skills_bundled_list`），不联网，
 *    装进同一目录（内容由宿主按 id 取，渲染端不传文件）；
 * 3. 发现：Java 后端（默认）及已启用第三方源 → 下载快照 → 宿主写盘。
 *
 * 安装目标都是 ACP agent（opencode / claude-code / codex 等）的原生技能目录，
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
  /** 下载来源随记录保留，更新不能回落到另一台服务器的同名技能。 */
  origin?: string;
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
  return { root, dir: joinPath(root.dir, ".agents", "skills") };
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

/** 读某技能目录 SKILL.md 的 frontmatter（读不到回落空对象）。 */
async function readSkillMeta(skillDir: string): Promise<{ name?: string; description?: string }> {
  try {
    const text = await readTextFile(joinPath(skillDir, "SKILL.md"));
    return parseSkillFrontmatter(text.slice(0, 32 * 1024));
  } catch {
    return {};
  }
}

/**
 * 扫描任意 `<skillsDir>` 下的一层目录，读各 SKILL.md frontmatter 得到已安装技能清单。
 *
 * 抽成独立函数（而非 store 私有）：团队页要按**协作运行的工作区**列技能，
 * 与设置页用的 `resolveWorkspaceRoot()` 不一定是同一个目录，不能让两边共用一份缓存。
 * 目录不存在时返回空清单而不是报错。
 */
export async function scanSkills(dir: string): Promise<InstalledSkill[]> {
  const entries = await listDir(dir);
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
  return skills;
}

function isRecord(value: { ref?: unknown; skillId?: unknown; hash?: unknown; installedAt?: unknown; origin?: unknown }): boolean {
  return (
    typeof value?.ref === "string" &&
    typeof value?.skillId === "string" &&
    typeof value?.hash === "string" &&
    typeof value?.installedAt === "number" &&
    (value.origin === undefined || typeof value.origin === "string")
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

/** 默认后端不传地址，由宿主实时解析；第三方必须显式指定，不能误走当前后端。 */
function buildSourceAdapters(settings: ReturnType<typeof useSettingsStore>, transport: SkillsMarketTransport): SkillSourceAdapter[] {
  return settings.skillSources
    .filter((source) => source.enabled)
    .map((entry) =>
      createSkillsShSource(transport, {
        id: entry.id,
        label: entry.label,
        description:
          entry.type === "backend"
            ? "跟随 Java 后端地址"
            : entry.type === "api"
              ? (entry.url ?? entry.id)
              : `GitHub 仓库：${entry.repo ?? entry.id}`,
        origin: entry.type === "api" ? entry.url : entry.type === "github" ? SKILLS_SH_DEFAULT_ORIGIN : undefined,
        scopeSource: entry.type === "github" && entry.repo ? entry.repo : undefined,
      }),
    );
}

export const useSkillsStore = defineStore("skills", () => {
  /** 运行时自适应的市场传输（桌面 = 宿主 IPC；浏览器 = Web 直连/仅浏览）。 */
  const transport: SkillsMarketTransport = createSkillsTransport();
  const settings = useSettingsStore();

  const hostAvailable = hasHostCommands();
  const workspace = ref<SkillsWorkspace | null>(null);
  const workspaceResolved = ref(false);

  /** 已安装列表（磁盘扫描结果）。 */
  const installed = ref<InstalledSkill[]>([]);
  const installedLoading = ref(false);
  const installedError = ref("");

  /** 内置技能目录（随宿主二进制发布，不联网）。 */
  const bundled = ref<BundledSkillMeta[]>([]);
  const bundledLoading = ref(false);
  const bundledError = ref("");

  /** 市场搜索。 */
  const searching = ref(false);
  const discoverResults = ref<MarketSkillEntry[]>([]);
  const discoverError = ref("");
  let discoverRevision = 0;
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
      installed.value = await scanSkills(ws.dir);
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

  /** 拉取内置技能目录（无宿主时宿主通道返回空数组，不算故障）。 */
  async function refreshBundled(): Promise<void> {
    bundledError.value = "";
    bundledLoading.value = true;
    try {
      bundled.value = await transport.bundledList();
    } catch (error) {
      bundled.value = [];
      bundledError.value = String(error);
    } finally {
      bundledLoading.value = false;
    }
  }

  /** 安装一份内置技能（内容由宿主按 id 取，已装即覆盖更新）。 */
  async function installBundled(skillId: string): Promise<void> {
    if (busyId.value !== null) throw new Error("技能安装或卸载正在进行，请稍后重试");
    busyId.value = skillId;
    try {
      const ws = await requireHostWorkspace();
      await transport.installBundled(ws.root.dir, skillId);
      await refreshInstalled();
    } finally {
      busyId.value = null;
    }
  }

  /** 市场搜索（跨所有启用源并行搜索，结果合并去重）。 */
  async function searchDiscover(query: string): Promise<void> {
    const revision = ++discoverRevision;
    const trimmed = query.trim();
    discoverError.value = "";
    if (!trimmed) {
      discoverResults.value = [];
      searching.value = false;
      return;
    }
    searching.value = true;
    try {
      const adapters = buildSourceAdapters(settings, transport);
      if (adapters.length === 0) {
        // 用户停用了所有来源，不偷偷重新启用任何市场。
        discoverResults.value = [];
        return;
      }
      const batches = await Promise.allSettled(adapters.map((adapter) => adapter.search(trimmed)));
      if (revision !== discoverRevision) return;
      discoverError.value = batches
        .flatMap((batch, index) => (batch.status === "rejected" ? [`${adapters[index].label}: ${String(batch.reason)}`] : []))
        .join("\n");
      const seen = new Set<string>();
      const merged: MarketSkillEntry[] = [];
      for (const batch of batches) {
        if (batch.status !== "fulfilled") continue;
        for (const entry of batch.value) {
          const key = `${entry.origin ?? ""}\n${entry.ref}`;
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(entry);
        }
      }
      discoverResults.value = merged;
    } catch (error) {
      if (revision !== discoverRevision) return;
      discoverResults.value = [];
      discoverError.value = String(error);
    } finally {
      if (revision === discoverRevision) searching.value = false;
    }
  }

  /** 市场/云端共用安装事务：下载、落盘、记录和 busy 状态不能各自维护。 */
  async function installMarketSnapshot(entry: MarketSkillEntry, download: () => Promise<SkillSnapshot>): Promise<void> {
    if (busyId.value !== null) throw new Error("技能安装或卸载正在进行，请稍后重试");
    busyId.value = entry.skillId;
    try {
      const ws = await requireHostWorkspace();
      const snapshot = await download();
      const origin = entry.origin || snapshot.origin;
      await transport.install(ws.root.dir, entry.skillId, snapshot.files);
      records.value = upsertRecord(records.value, {
        ref: entry.ref,
        skillId: entry.skillId,
        hash: snapshot.hash,
        installedAt: Date.now(),
        ...(origin ? { origin } : {}),
      });
      saveRecords(records.value);
      await refreshInstalled();
    } finally {
      busyId.value = null;
    }
  }

  /** 已下载的云端快照仍走同一安装/记账入口，宿主继续执行两阶段文件校验。 */
  function installFromSnapshot(entry: MarketSkillEntry, snapshot: SkillSnapshot): Promise<void> {
    return installMarketSnapshot(entry, async () => snapshot);
  }

  function installFromMarket(entry: MarketSkillEntry): Promise<void> {
    return installMarketSnapshot(entry, async () => parseSnapshot(await transport.download(entry.ref, entry.origin)));
  }

  /** 卸载已安装技能（只删技能根目录，宿主侧有 skillId 白名单收敛）。 */
  async function uninstallSkill(skillId: string): Promise<void> {
    if (busyId.value !== null) throw new Error("技能安装或卸载正在进行，请稍后重试");
    busyId.value = skillId;
    try {
      const ws = await requireHostWorkspace();
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
    if (!record.origin) throw new Error("旧安装记录未保存下载来源，请从原市场重新安装一次后再更新，避免误从当前 Java 后端下载同名技能");
    await installFromMarket({
      ref: record.ref,
      skillId: record.skillId,
      name: record.skillId,
      installs: 0,
      source: "",
      downloadable: true,
      origin: record.origin,
    });
  }

  async function requireHostWorkspace(): Promise<SkillsWorkspace> {
    if (!hostAvailable) throw new Error("skills install/uninstall requires the desktop host");
    // 操作发生时重新解析，不能把首次打开设置页的缓存当成当前工作区。
    const ws = await resolveSkillsRoot();
    workspace.value = ws;
    workspaceResolved.value = true;
    return ws;
  }

  /** 已知的已安装 id 集合（市场结果标注「已安装/可更新」用）。 */
  const installedIds = computed(() => new Set(installed.value.map((skill) => skill.id)));

  /** 内置技能 id 集合（市场结果里同名条目标注「内置」用）。 */
  const bundledIds = computed(() => new Set(bundled.value.map((skill) => skill.id)));

  return {
    transport,
    hostAvailable,
    workspace,
    workspaceResolved,
    installed,
    installedLoading,
    installedError,
    bundled,
    bundledLoading,
    bundledError,
    searching,
    discoverResults,
    discoverError,
    busyId,
    records,
    recordBySkillId,
    installedIds,
    bundledIds,
    ensureWorkspace,
    refreshInstalled,
    refreshBundled,
    searchDiscover,
    installFromMarket,
    installFromSnapshot,
    installBundled,
    updateInstalled,
    uninstallSkill,
  };
});
