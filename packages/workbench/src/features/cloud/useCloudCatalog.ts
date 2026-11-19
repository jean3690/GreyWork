import { computed, shallowRef, watch } from "vue";
import { parseSnapshot, type MarketSkillEntry } from "@greywork/plugins";
import { cloudError, cloudRequest } from "@/lib/cloud-api";
import { useUserAccountStore } from "@/stores/user-account";
import { useSkillsStore } from "@/stores/skills";
import { searchMcpRegistry, type McpRegistryEntry } from "@/lib/mcp-registry";

interface SkillRow {
  ref: string;
  skill_id: string;
  name: string;
  installs: number;
  source: string;
  downloadable: boolean;
}
export function useCloudCatalog() {
  const account = useUserAccountStore();
  const skillsStore = useSkillsStore();
  const kind = shallowRef<"skills" | "mcp">("skills");
  const query = shallowRef("");
  const skills = shallowRef<MarketSkillEntry[]>([]);
  const mcps = shallowRef<McpRegistryEntry[]>([]);
  const loading = shallowRef(false);
  const acting = shallowRef(false);
  const busy = computed(() => acting.value || skillsStore.busyId !== null);
  const error = shallowRef("");
  const notice = shallowRef("");
  const origin = computed(() => account.status?.baseUrl ?? "");
  let revision = 0;
  async function search(): Promise<void> {
    const current = ++revision;
    loading.value = true;
    error.value = "";
    const base = origin.value;
    try {
      if (kind.value === "skills") {
        const rows = await cloudRequest<SkillRow[]>("GET", `/api/skills?q=${encodeURIComponent(query.value.trim())}`);
        if (current === revision) skills.value = rows.map((row) => ({ ...row, skillId: row.skill_id, origin: base }));
      } else {
        const rows = await searchMcpRegistry(query.value, 100, `${base}/api/market/mcp`);
        if (current === revision) mcps.value = rows;
      }
    } catch (cause) {
      if (current === revision) error.value = cloudError(cause);
    } finally {
      if (current === revision) loading.value = false;
    }
  }
  watch(
    [kind, origin, () => account.session?.user.id],
    () => {
      skills.value = [];
      mcps.value = [];
      if (account.session) void search();
      else revision += 1;
    },
    { immediate: true },
  );
  async function action(run: () => Promise<void>): Promise<void> {
    if (busy.value) return;
    acting.value = true;
    error.value = "";
    notice.value = "";
    try {
      await run();
    } catch (cause) {
      error.value = cloudError(cause);
    } finally {
      acting.value = false;
    }
  }
  const install = (entry: MarketSkillEntry): Promise<void> =>
    action(async () => {
      // 快照经登录态代理下载；落盘复用原来的两阶段校验，不让来源字段决定目标路径。
      const snapshot = parseSnapshot(await cloudRequest("GET", `/api/download/${entry.ref}`));
      await skillsStore.installFromSnapshot(entry, snapshot);
      notice.value = `已安装 ${entry.name}，新建 Agent 会话后生效。`;
    });
  const downloadSkill = (entry: MarketSkillEntry): Promise<void> =>
    action(async () => {
      const snapshot = parseSnapshot(await cloudRequest("GET", `/api/download/${entry.ref}`));
      const { default: JSZip } = await import("jszip");
      const zip = new JSZip();
      for (const file of snapshot.files) zip.file(`${entry.skillId}/${file.path}`, file.contents);
      downloadBlob(await zip.generateAsync({ type: "blob" }), `${entry.skillId}.zip`);
      notice.value = `已下载 ${entry.name}`;
    });
  return { kind, query, skills, mcps, loading, busy, error, notice, search, install, downloadSkill };
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
