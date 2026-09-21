<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { i18n } from "@/i18n";
import Icon from "@/features/shared/Icon.vue";
import Hint from "@/features/shared/Hint.vue";
import StatusChip from "@/features/shared/StatusChip.vue";
import ConfirmDialog from "@/features/settings/ConfirmDialog.vue";
import {
  CAPABILITY_REGISTRY,
  capabilityAuditLog,
  capabilityTitle,
  normalizeGrantSpec,
  resetCapabilityAuditForTest,
  type CapabilityAuditEntry,
} from "@/plugins/capabilities";
import {
  installMarketPlugin,
  installedMarketIds,
  marketBusyId,
  marketCatalog,
  marketError,
  marketLoading,
  outdatedPlugins,
  pluginMarketHostAvailable,
  pluginRegistryUrl,
  previewMarketPlugin,
  refreshPluginCatalog,
  setPluginRegistryUrl,
  uninstallMarketPlugin,
  upgradeMarketPlugin,
} from "@/plugins/market";
import {
  grantPluginCapability,
  isPluginCapabilityGranted,
  isPluginEnabled,
  pluginActive,
  pluginManifests,
  restoreBuiltinPlugins,
  revokePluginCapability,
  setPluginEnabled,
} from "@/plugins/runtime";
import { useCapabilityLoader } from "@/plugins/current";
import { useSettingsStore } from "@/stores/settings";
import { useSkillsStore } from "@/stores/skills";
import McpMarketSection from "@/features/plugins/McpMarketSection.vue";
import SkillsMarketSection from "@/features/plugins/SkillsMarketSection.vue";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * 插件中心（本身是内置插件 core.plugins 贡献的模式页）。
 *
 * 展示已注册清单与启停状态；开关即 loader.activate/deactivate。
 * 停用 core.plugins（本页的宿主插件）会让本页消失 —— 走两步确认，
 * 文案讲明后果与恢复路径（回退页有「恢复内置插件」按钮）。
 */
const t = i18n.global.t;
const loader = useCapabilityLoader();
const settings = useSettingsStore();
const skills = useSkillsStore();

/** seam 当前快照（响应式）：模式页贡献实时反映启停结果。 */
const contributedModes = computed(() => loader.snapshot().modes.map((mode) => ({ id: mode.id, title: mode.title })));
/** uiRegions 面板贡献（region + 标题），同一响应式来源。 */
const contributedRegions = computed(() =>
  loader.snapshot().uiRegions.map((region) => ({ region: region.region, id: region.id, title: region.title })),
);

const busyId = ref<string | null>(null);
/** 停用 core.plugins（自身）前的两步确认。 */
const confirmDisableId = ref<string | null>(null);
const notice = ref<{ kind: "ok" | "error"; text: string } | null>(null);
const registryDraft = ref(pluginRegistryUrl.value);
const activeSection = ref<"discover" | "mcp" | "skills" | "installed" | "audit">("discover");
const searchQuery = ref("");
const registryOpen = ref(false);
const uninstallTarget = ref<{ id: string; name: string } | null>(null);
const installPreviewLoading = ref<string | null>(null);

/** 安装/升级确认弹窗：preview 已校验的 manifest + 来源目录项。 */
const installTarget = ref<{
  entryId: string;
  name: string;
  manifest: {
    id: string;
    name: string;
    version: string;
    description?: string;
    kind?: string;
    requires: Array<{ capability: string; hosts?: string[] }>;
  };
} | null>(null);
/** 升级请求标志：确认弹窗的「确认」按此分流到 install 或 upgrade。 */
const isUpgradeRequest = ref(false);

const installRequirements = computed(() =>
  (installTarget.value?.manifest.requires ?? []).map((grant) => ({
    capability: grant.capability,
    hosts: grant.hosts,
    title: capabilityTitle(grant.capability),
    danger: CAPABILITY_REGISTRY[grant.capability]?.danger ?? "high",
    description: CAPABILITY_REGISTRY[grant.capability]?.description ?? "未知能力（宿主未登记）",
  })),
);

/** 安装后待授权引导的插件 id：高亮其卡片与未授权 chip。 */
const pendingGrantId = ref<string | null>(null);

/** 升级入口：与安装同一确认标准 —— 新版可能新增 requires，能力语义变化必须重新知情。 */
async function requestUpgrade(entryId: string, name: string): Promise<void> {
  isUpgradeRequest.value = true;
  await requestInstall(entryId, name);
}
/** 目录项安装入口：先 preview（下载 + 全量校验不落盘），确认后真正安装。 */
async function requestInstall(entryId: string, name: string): Promise<void> {
  notice.value = null;
  installPreviewLoading.value = entryId;
  try {
    const manifest = await previewMarketPlugin(entryId);
    installTarget.value = {
      entryId,
      name,
      manifest: {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        kind: manifest.kind,
        requires: manifest.requires.map((spec) => normalizeGrantSpec(spec)),
      },
    };
  } catch (error) {
    notice.value = { kind: "error", text: String(error) };
  } finally {
    installPreviewLoading.value = null;
  }
}

onMounted(() => {
  if (import.meta.env.MODE !== "test" && marketCatalog.value.length === 0) void refreshPluginCatalog();
});

async function confirmInstall(): Promise<void> {
  if (!installTarget.value) return;
  const target = installTarget.value;
  const upgrading = isUpgradeRequest.value;
  installTarget.value = null;
  isUpgradeRequest.value = false;
  notice.value = null;
  try {
    if (upgrading) {
      await upgradeMarketPlugin(target.entryId);
      notice.value = { kind: "ok", text: `已升级 ${target.entryId} 至 v${target.manifest.version}` };
      return;
    }
    await installMarketPlugin(target.entryId);
    const missing = target.manifest.requires
      .filter((grant) => !isPluginCapabilityGranted(target.manifest.id, grant.capability))
      .map((grant) => grant.capability);
    if (missing.length) {
      // 引导授权：跳到已装页签 + 提示哪些能力还没授权（chip 在已装卡片上可点）。
      activeSection.value = "installed";
      pendingGrantId.value = target.manifest.id;
      notice.value = {
        kind: "ok",
        text: `${t("market.pluginInstalled", { id: target.entryId })}——还需授权：${missing.map((capability) => capabilityTitle(capability)).join("、")}`,
      };
    } else {
      notice.value = { kind: "ok", text: t("market.pluginInstalled", { id: target.entryId }) };
    }
  } catch (error) {
    notice.value = { kind: "error", text: String(error) };
  }
}

const filteredCatalog = computed(() => {
  const query = searchQuery.value.trim().toLocaleLowerCase();
  if (!query) return marketCatalog.value;
  return marketCatalog.value.filter((entry) =>
    [entry.name, entry.id, entry.description ?? "", entry.author ?? ""].some((value) => value.toLocaleLowerCase().includes(query)),
  );
});
const catalogInstalledCount = computed(() => marketCatalog.value.filter((entry) => installedMarketIds.value.has(entry.id)).length);
/** manifest.requires（可能为对象形态）归一化为 chip 列表。 */
const requiredCapabilitiesByPlugin = computed(() =>
  Object.fromEntries(
    pluginManifests.value.map((manifest) => [
      manifest.id,
      (manifest.requires ?? []).map((spec) =>
        typeof spec === "string"
          ? { capability: spec, hosts: undefined as string[] | undefined }
          : { capability: spec.capability, hosts: spec.hosts },
      ),
    ]),
  ),
);

/** 能力审计：快照函数非响应式，切到审计页签时刷新 + 每条调用后轮询刷新。
 * 简化处理：本地 ref + 手动 sync（审计写入频率低，页面级刷新足够）。 */
const auditEntries = ref<readonly CapabilityAuditEntry[]>(capabilityAuditLog());
function syncAudit(): void {
  auditEntries.value = capabilityAuditLog();
}
function clearAudit(): void {
  resetCapabilityAuditForTest();
  syncAudit();
}

function requestToggle(manifestId: string, enabled: boolean): void {
  if (!enabled && manifestId === "core.plugins") {
    confirmDisableId.value = manifestId;
    return;
  }
  void toggle(manifestId, enabled);
}

async function toggle(manifestId: string, enabled: boolean): Promise<void> {
  busyId.value = manifestId;
  notice.value = null;
  try {
    await setPluginEnabled(manifestId, enabled);
    notice.value = { kind: "ok", text: enabled ? `已启用 ${manifestId}` : `已停用 ${manifestId}` };
  } catch (error) {
    notice.value = { kind: "error", text: error instanceof Error ? error.message : String(error) };
  } finally {
    busyId.value = null;
  }
}

function confirmSelfDisable(): void {
  if (confirmDisableId.value === null) return;
  const id = confirmDisableId.value;
  confirmDisableId.value = null;
  void toggle(id, false);
}

/** 能力授权 chip 的态色：未授权但正处在安装引导（pendingGrantId）时高亮闪烁。 */
function grantChipClass(manifestId: string, capability: string): string {
  if (isPluginCapabilityGranted(manifestId, capability)) return "border-mint/30 bg-mint/10 text-mint";
  if (pendingGrantId.value === manifestId) return "animate-pulse border-amber/60 bg-amber/20 text-amber";
  return "border-amber/30 bg-amber/10 text-amber";
}

function grantLabel(manifestId: string, capability: string): string {
  return isPluginCapabilityGranted(manifestId, capability) ? t("market.granted") : t("market.notGranted");
}

/** 审计结果态色：拒绝走橙、异常走琥珀、通过走薄荷。 */
function auditChipTone(outcome: CapabilityAuditEntry["outcome"]): "ok" | "warn" | "denied" {
  if (outcome === "ok") return "ok";
  if (outcome === "denied") return "denied";
  return "warn";
}

/** 能力危险级别 chip 的语义态。 */
function dangerChipTone(danger: string): "high" | "medium" | "low" {
  if (danger === "high") return "high";
  if (danger === "medium") return "medium";
  return "low";
}

function dangerLabel(danger: string): string {
  if (danger === "high") return "高危";
  if (danger === "medium") return "中危";
  return "低危";
}

function toggleLabel(manifestId: string): string {
  if (busyId.value === manifestId) return "…";
  return isPluginEnabled(manifestId) ? t("market.disable") : t("market.enable");
}

type MarketSection = "discover" | "mcp" | "skills" | "installed" | "audit";

/**
 * 页签定义：插件 / MCP / 技能 / 已装 / 能力审计，各自带计数。
 *
 * 三个市场页签是三种不同形态的「安装」：插件是声明式包落盘，MCP 是登记服务器声明，
 * 技能是往工作区写技能目录——所以各给一个专区，而不是塞进同一张卡片网格。
 */
const sectionTabs = computed(() => [
  { key: "discover" as const, label: t("market.discoverPlugins"), count: marketCatalog.value.length },
  { key: "mcp" as const, label: t("market.tabMcp"), count: settings.mcpServers.length },
  { key: "skills" as const, label: t("market.tabSkills"), count: skills.installed.length },
  { key: "installed" as const, label: t("market.installedPlugins"), count: installedMarketIds.value.size },
  { key: "audit" as const, label: t("market.tabAudit"), count: auditEntries.value.length },
]);

function selectSection(section: MarketSection): void {
  activeSection.value = section;
  if (section === "audit") syncAudit();
  if (section === "skills") void skills.refreshInstalled();
}

function toggleGrant(manifestId: string, capability: string): void {
  notice.value = null;
  if (isPluginCapabilityGranted(manifestId, capability)) {
    revokePluginCapability(manifestId, capability);
    notice.value = { kind: "ok", text: t("market.capabilityRevoked", { capability: capabilityTitle(capability) }) };
    return;
  }
  grantPluginCapability(manifestId, capability);
  notice.value = { kind: "ok", text: t("market.capabilityGranted", { capability: capabilityTitle(capability) }) };
}

function saveRegistry(): void {
  setPluginRegistryUrl(registryDraft.value);
  void refreshPluginCatalog();
}

async function installFromMarket(id: string): Promise<void> {
  // 宿主不可用时按钮只标 aria-disabled（保持可聚焦，"仅桌面端可安装"的提示才弹得出来），
  // 点击真正的兜底在这里 —— 否则会走到 requestInstall 再报错。
  if (!pluginMarketHostAvailable) return;
  notice.value = null;
  try {
    await requestInstall(id, marketCatalog.value.find((entry) => entry.id === id)?.name ?? id);
  } catch (error) {
    notice.value = { kind: "error", text: String(error) };
  }
}
async function confirmUninstall(): Promise<void> {
  if (!uninstallTarget.value) return;
  const target = uninstallTarget.value;
  uninstallTarget.value = null;
  notice.value = null;
  try {
    await uninstallMarketPlugin(target.id);
    notice.value = { kind: "ok", text: t("market.pluginUninstalled", { id: target.id }) };
  } catch (error) {
    notice.value = { kind: "error", text: String(error) };
  }
}
</script>

<template>
  <div
    class="mx-auto flex h-full min-h-0 w-full max-w-[1120px] flex-col overflow-y-auto px-4 py-4 sm:px-6 sm:py-6"
    data-testid="plugin-market"
  >
    <p
      v-if="notice"
      role="status"
      class="mb-3 rounded-[10px] border px-3 py-2 text-[12px]"
      :class="notice.kind === 'error' ? 'border-orange/35 bg-orange/10 text-orange' : 'border-mint/25 bg-mint/10 text-mint'"
    >
      {{ notice.text }}
    </p>

    <nav class="flex items-center border-b border-line" :aria-label="t('market.pluginMarketTitle')">
      <button
        v-for="section in sectionTabs"
        :key="section.key"
        type="button"
        :data-testid="`market-tab-${section.key}`"
        :class="activeSection === section.key ? 'text-foreground' : 'text-dim2 hover:text-dim'"
        :aria-pressed="activeSection === section.key"
        @click="selectSection(section.key)"
      >
        {{ section.label }}
        <span class="ml-1.5 rounded-full bg-panel-2 px-1.5 py-0.5 font-mono text-[9px] text-dim2">
          {{ section.count }}
        </span>
        <i v-if="activeSection === section.key" class="absolute inset-x-2 bottom-[-1px] h-0.5 rounded-full bg-accent"></i>
      </button>
      <div class="ml-auto flex items-center gap-1.5 pb-1">
        <Hint :text="t('market.refreshCatalog')">
          <button
            type="button"
            class="grid size-8 cursor-pointer place-items-center rounded-[8px] text-dim2 transition-colors hover:bg-panel-2 hover:text-foreground disabled:opacity-40"
            :disabled="marketLoading"
            :aria-label="t('market.refreshCatalog')"
            data-testid="plugin-market-refresh"
            @click="refreshPluginCatalog()"
          >
            <Icon name="refresh" :size="14" :class="marketLoading ? 'animate-spin' : ''" />
          </button>
        </Hint>
        <Hint :text="t('market.registrySettings')">
          <button
            type="button"
            class="grid size-8 cursor-pointer place-items-center rounded-[8px] text-dim2 transition-colors hover:bg-panel-2 hover:text-foreground"
            :aria-label="t('market.registrySettings')"
            :aria-expanded="registryOpen"
            data-testid="plugin-registry-toggle"
            @click="registryOpen = !registryOpen"
          >
            <Icon name="setting" :size="14" />
          </button>
        </Hint>
      </div>
    </nav>

    <section v-if="registryOpen" class="mt-3 rounded-[12px] border border-line bg-panel p-3" data-testid="plugin-registry-settings">
      <label for="plugin-registry-url" class="text-[11px] font-medium text-foreground">{{ t("market.registrySource") }}</label>
      <div class="mt-2 flex flex-col gap-2 sm:flex-row">
        <input
          id="plugin-registry-url"
          v-model="registryDraft"
          type="url"
          class="h-9 min-w-0 flex-1 rounded-[8px] border border-line bg-ink px-3 font-mono text-[11px] text-foreground outline-none placeholder:text-dim2 focus:border-accent"
          :placeholder="t('market.registryUrlPlaceholder')"
          data-testid="plugin-registry-url"
          @keydown.enter="saveRegistry"
        />
        <button
          type="button"
          class="h-9 cursor-pointer rounded-[8px] bg-accent px-4 text-[11.5px] font-medium text-accent-ink transition-colors hover:bg-accent-hi disabled:opacity-50"
          :disabled="marketLoading"
          @click="saveRegistry"
        >
          {{ marketLoading ? t("market.loadingCatalog") : t("market.saveAndReload") }}
        </button>
      </div>
    </section>

    <p v-if="marketError" class="mt-3 rounded-[10px] border border-orange/30 bg-orange/10 px-3 py-2 text-[11.5px] text-orange" role="alert">
      {{ marketError }}
    </p>

    <section v-if="activeSection === 'discover'" class="mt-4">
      <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div class="relative min-w-0 flex-1">
          <Icon name="search" :size="13" class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dim2" />
          <input
            v-model="searchQuery"
            type="search"
            class="h-10 w-full rounded-[10px] border border-line bg-panel pl-9 pr-3 text-[12px] text-foreground outline-none placeholder:text-dim2 focus:border-accent"
            :placeholder="t('market.searchMarketplace')"
            data-testid="plugin-market-search"
          />
        </div>
        <span class="shrink-0 text-[10.5px] text-dim2"
          >{{ catalogInstalledCount }}/{{ marketCatalog.length }} {{ t("market.alreadyInstalled") }}</span
        >
      </div>

      <!-- 原先挂在页头的那段说明与信任标记：挪到真正发生安装的地方 -->
      <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-dim2">
        <span class="rounded-full border border-mint/30 px-2 py-0.5 text-[10px] text-mint">{{ t("market.declarativeOnly") }}</span>
        <span class="min-w-0 flex-1">{{ t("market.pluginMarketHint") }}</span>
        <span class="inline-flex items-center gap-1.5 font-mono"><i class="size-1.5 rounded-full bg-mint"></i> SHA-256</span>
        <span class="inline-flex items-center gap-1.5 font-mono"><i class="size-1.5 rounded-full bg-accent"></i> GitHub HTTPS</span>
      </div>

      <div v-if="marketLoading && marketCatalog.length === 0" class="mt-3 grid gap-3 md:grid-cols-2">
        <Skeleton v-for="index in 4" :key="index" class="h-40 rounded-[14px] border border-line bg-panel" />
      </div>

      <div v-else-if="filteredCatalog.length" class="mt-3 grid gap-3 md:grid-cols-2">
        <article
          v-for="entry in filteredCatalog"
          :key="entry.id"
          class="group flex min-h-40 flex-col rounded-[14px] border border-line bg-panel p-4 transition-colors hover:border-line-2"
          :data-testid="`market-plugin-${entry.id}`"
        >
          <div class="flex items-start gap-3">
            <span class="grid size-10 shrink-0 place-items-center rounded-[11px] border border-brand-hover/25 bg-brand-light/50 text-brand">
              <Icon name="lightning" :size="17" />
            </span>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <h2 class="truncate text-[13px] font-semibold text-foreground">{{ entry.name }}</h2>
                <span
                  v-if="installedMarketIds.has(entry.id)"
                  class="shrink-0 rounded-full bg-mint/10 px-1.5 py-0.5 text-[9.5px] font-medium text-mint"
                >
                  {{ t("market.installed") }}
                </span>
              </div>
              <p class="mt-0.5 truncate font-mono text-[9.5px] text-dim2">{{ entry.id }} · v{{ entry.version }}</p>
            </div>
          </div>
          <p class="mt-3 line-clamp-3 flex-1 text-[11.5px] leading-[1.55] text-dim">{{ entry.description || t("market.noDescription") }}</p>
          <footer class="mt-4 flex items-center justify-between gap-3 border-t border-line pt-3">
            <span class="truncate text-[10.5px] text-dim2">{{ entry.author || t("market.communityAuthor") }}</span>
            <button
              v-if="installedMarketIds.has(entry.id)"
              type="button"
              class="h-7 shrink-0 cursor-pointer rounded-[7px] border border-line px-2.5 text-[11px] text-dim transition-colors hover:border-orange/40 hover:text-orange disabled:opacity-40"
              :disabled="!pluginMarketHostAvailable || marketBusyId === entry.id"
              :data-testid="`market-uninstall-${entry.id}`"
              @click="uninstallTarget = { id: entry.id, name: entry.name }"
            >
              {{ marketBusyId === entry.id ? "…" : t("market.uninstall") }}
            </button>
            <Hint v-else :text="!pluginMarketHostAvailable ? t('market.desktopInstallOnly') : null" multiline>
              <button
                type="button"
                class="h-7 shrink-0 cursor-pointer rounded-[7px] bg-accent px-3 text-[11px] font-medium text-accent-ink transition-colors hover:bg-accent-hi disabled:cursor-not-allowed disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:opacity-40"
                :disabled="marketBusyId !== null"
                :aria-disabled="!pluginMarketHostAvailable || undefined"
                :data-testid="`market-install-${entry.id}`"
                @click="installFromMarket(entry.id)"
              >
                {{ installPreviewLoading === entry.id || marketBusyId === entry.id ? t("market.installingPlugin") : t("market.install") }}
              </button>
            </Hint>
          </footer>
        </article>
      </div>

      <div
        v-else
        class="mt-3 grid min-h-52 place-items-center rounded-[14px] border border-dashed border-line-2 bg-panel/50 px-6 text-center"
      >
        <div>
          <span class="mx-auto grid size-10 place-items-center rounded-[11px] bg-panel-2 text-dim2"><Icon name="search" :size="16" /></span>
          <p class="mt-3 text-[12px] font-medium text-foreground">{{ t("market.noPluginsFound") }}</p>
          <p class="mt-1 text-[10.5px] text-dim2">{{ t("market.noPluginsHint") }}</p>
        </div>
      </div>

      <p v-if="!pluginMarketHostAvailable" class="mt-3 text-center text-[10.5px] text-dim2">{{ t("market.desktopInstallOnly") }}</p>
    </section>

    <section v-else-if="activeSection === 'mcp'" class="mt-4">
      <McpMarketSection />
    </section>

    <section v-else-if="activeSection === 'skills'" class="mt-4">
      <SkillsMarketSection />
    </section>

    <section v-else-if="activeSection === 'installed'" class="mt-4">
      <div class="mb-3 flex items-end justify-between gap-3">
        <div>
          <h2 class="text-[13px] font-semibold text-foreground">{{ t("market.installedPlugins") }}</h2>
          <p class="mt-0.5 text-[10.5px] text-dim2">{{ t("market.installedPluginsHint") }}</p>
        </div>
        <span class="font-mono text-[10px] text-dim2"
          >{{ pluginActive.length }}/{{ pluginManifests.length }} {{ t("market.activeCount") }}</span
        >
      </div>

      <div v-if="pluginManifests.length" class="flex flex-col gap-2">
        <article
          v-for="manifest in pluginManifests"
          :key="manifest.id"
          class="rounded-[12px] border bg-panel px-3.5 py-3 transition-colors"
          :class="pendingGrantId === manifest.id ? 'border-amber/50' : 'border-line'"
          :data-testid="`plugin-card-${manifest.id}`"
        >
          <div class="flex items-start gap-3">
            <span
              class="mt-0.5 size-2 shrink-0 rounded-full"
              :class="
                isPluginEnabled(manifest.id) ? 'bg-mint shadow-[0_0_0_3px_color-mix(in_srgb,var(--mint)_14%,transparent)]' : 'bg-line-2'
              "
            ></span>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-1.5">
                <span class="text-[12.5px] font-medium text-foreground">{{ manifest.name }}</span>
                <code class="rounded-[5px] bg-panel-2 px-1.5 py-0.5 text-[9.5px] text-dim2">{{ manifest.id }}</code>
                <span class="font-mono text-[9.5px] text-dim2">v{{ manifest.version }}</span>
                <span
                  v-if="outdatedPlugins[manifest.id]"
                  class="rounded-full border border-amber/40 bg-amber/10 px-1.5 py-0.5 text-[9px] text-amber"
                  :data-testid="`plugin-upgrade-badge-${manifest.id}`"
                >
                  可升级 → v{{ outdatedPlugins[manifest.id] }}
                </span>
                <span
                  v-if="installedMarketIds.has(manifest.id)"
                  class="rounded-full border border-accent/25 px-1.5 py-0.5 text-[9px] text-accent"
                >
                  {{ t("market.fromMarketplace") }}
                </span>
                <span v-else class="rounded-full border border-line px-1.5 py-0.5 text-[9px] text-dim2">{{
                  t("market.builtinPlugin")
                }}</span>
              </div>
              <p v-if="manifest.description" class="mt-1 text-[11px] leading-relaxed text-dim">{{ manifest.description }}</p>
              <p v-if="manifest.dependsOn?.length" class="mt-1 font-mono text-[9.5px] text-dim2">
                depends · {{ manifest.dependsOn.join(", ") }}
              </p>
              <div v-if="requiredCapabilitiesByPlugin[manifest.id]?.length" class="mt-2 flex flex-wrap items-center gap-1.5">
                <Hint
                  v-for="required in requiredCapabilitiesByPlugin[manifest.id]"
                  :key="required.capability"
                  :text="required.hosts?.length ? `域名白名单：${required.hosts.join(', ')}` : null"
                  multiline
                >
                  <button
                    type="button"
                    class="cursor-pointer rounded-[6px] border px-1.5 py-0.5 text-[9.5px] transition-colors"
                    :class="grantChipClass(manifest.id, required.capability)"
                    :aria-pressed="isPluginCapabilityGranted(manifest.id, required.capability)"
                    :data-testid="`plugin-capability-${manifest.id}-${required.capability}`"
                    @click="
                      pendingGrantId = null;
                      toggleGrant(manifest.id, required.capability);
                    "
                  >
                    {{ capabilityTitle(required.capability) }}{{ required.hosts?.length ? ` · ${required.hosts.join(", ")}` : "" }} ·
                    {{ grantLabel(manifest.id, required.capability) }}
                  </button>
                </Hint>
              </div>
            </div>
            <div v-if="confirmDisableId === manifest.id" class="flex max-w-[290px] shrink-0 flex-col items-end gap-1.5">
              <span class="rounded-[7px] bg-amber/10 px-2 py-1 text-right text-[9.5px] leading-snug text-amber">{{
                t("market.selfDisableWarn")
              }}</span>
              <div class="flex gap-1.5">
                <button type="button" class="h-7 rounded-[7px] bg-orange px-2.5 text-[11px] text-white" @click="confirmSelfDisable">
                  {{ t("common.delete") }}
                </button>
                <button
                  type="button"
                  class="h-7 rounded-[7px] border border-line px-2.5 text-[11px] text-dim"
                  @click="confirmDisableId = null"
                >
                  {{ t("common.cancel") }}
                </button>
              </div>
            </div>
            <button
              v-if="outdatedPlugins[manifest.id]"
              type="button"
              class="h-7 shrink-0 cursor-pointer rounded-[7px] bg-amber px-2.5 text-[11px] font-medium text-amber-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              :disabled="marketBusyId !== null"
              :data-testid="`plugin-upgrade-${manifest.id}`"
              @click="requestUpgrade(manifest.id, manifest.name)"
            >
              {{ marketBusyId === manifest.id ? "…" : t("market.upgrade") }}
            </button>
            <button
              v-else
              type="button"
              class="h-7 w-14 shrink-0 cursor-pointer rounded-[7px] text-[11px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              :class="isPluginEnabled(manifest.id) ? 'border border-line bg-panel-2 text-dim' : 'bg-accent text-accent-ink'"
              :disabled="busyId === manifest.id"
              :aria-pressed="isPluginEnabled(manifest.id)"
              :data-testid="`plugin-toggle-${manifest.id}`"
              @click="requestToggle(manifest.id, !isPluginEnabled(manifest.id))"
            >
              {{ toggleLabel(manifest.id) }}
            </button>
          </div>
        </article>
      </div>

      <div v-else class="grid min-h-52 place-items-center rounded-[14px] border border-dashed border-line-2 text-center">
        <div>
          <p class="text-[12px] text-dim2">{{ t("market.pluginsEmpty") }}</p>
          <button type="button" class="mt-3 h-8 rounded-[8px] bg-accent px-3 text-[11px] text-accent-ink" @click="restoreBuiltinPlugins()">
            {{ t("market.restoreBuiltins") }}
          </button>
        </div>
      </div>
    </section>

    <section v-else-if="activeSection === 'audit'" class="mt-4" data-testid="plugin-audit-section">
      <div class="mb-3 flex items-end justify-between gap-3">
        <div>
          <h2 class="text-[13px] font-semibold text-foreground">{{ t("market.tabAudit") }}</h2>
          <p class="mt-0.5 text-[10.5px] text-dim2">{{ t("market.auditDesc") }}</p>
        </div>
        <button
          type="button"
          class="h-7 cursor-pointer rounded-[7px] border border-line px-2.5 text-[11px] text-dim transition-colors hover:border-orange/40 hover:text-orange"
          data-testid="plugin-audit-clear"
          @click="clearAudit"
        >
          {{ t("market.auditClear") }}
        </button>
      </div>
      <div v-if="auditEntries.length" class="flex flex-col gap-1.5">
        <div
          v-for="(entry, index) in auditEntries"
          :key="`${entry.at}-${index}`"
          class="flex items-start gap-2.5 rounded-[10px] border border-line bg-panel px-3 py-2"
          :data-testid="`plugin-audit-entry-${index}`"
        >
          <StatusChip class="mt-0.5 shrink-0 font-mono" :tone="auditChipTone(entry.outcome)">
            {{ entry.outcome }}
          </StatusChip>
          <div class="min-w-0 flex-1">
            <p class="font-mono text-[10.5px] text-dim">
              <span class="text-foreground">{{ entry.plugin }}</span>
              <span class="text-dim2"> · {{ entry.capability }}</span>
            </p>
            <p v-if="entry.detail" class="mt-0.5 truncate font-mono text-[9.5px] text-dim2">{{ entry.detail }}</p>
          </div>
          <span class="shrink-0 font-mono text-[9.5px] text-dim2">{{ new Date(entry.at).toLocaleString() }}</span>
        </div>
      </div>
      <div v-else class="grid min-h-52 place-items-center rounded-[14px] border border-dashed border-line-2 text-center">
        <p class="text-[12px] text-dim2">{{ t("market.auditEmpty") }}</p>
      </div>
    </section>

    <div class="sr-only" aria-hidden="true">
      <span v-for="mode in contributedModes" :key="mode.id" :data-testid="`mode-chip-${mode.id}`">{{ mode.title }}</span>
      <span v-for="region in contributedRegions" :key="region.id" :data-testid="`region-chip-${region.region}-${region.id}`">
        {{ region.region }} · {{ region.title }}
      </span>
    </div>

    <ConfirmDialog
      v-if="uninstallTarget"
      :title="t('market.uninstallPluginTitle', { name: uninstallTarget.name })"
      :message="t('market.uninstallPluginMessage', { name: uninstallTarget.name })"
      :confirm-label="t('market.uninstall')"
      @confirm="confirmUninstall"
      @cancel="uninstallTarget = null"
    />

    <ConfirmDialog
      v-if="installTarget"
      :title="
        isUpgradeRequest
          ? `升级 ${installTarget.manifest.name} 至 v${installTarget.manifest.version}`
          : `安装 ${installTarget.manifest.name} v${installTarget.manifest.version}`
      "
      :message="installTarget.manifest.description"
      :confirm-label="isUpgradeRequest ? '升级' : t('market.install')"
      @confirm="confirmInstall"
      @cancel="
        installTarget = null;
        isUpgradeRequest = false;
      "
    >
      <div class="mt-2 flex flex-col gap-2" data-testid="install-capability-list">
        <p class="text-[11px] text-dim">
          该插件请求以下能力{{ installTarget.manifest.kind === "worker" ? "，并在隔离 Worker 中执行代码" : "" }}：
        </p>
        <div
          v-for="required in installRequirements"
          :key="required.capability"
          class="rounded-[10px] border border-line bg-panel-2 px-2.5 py-2"
          :data-testid="`install-capability-${required.capability}`"
        >
          <div class="flex items-center gap-1.5">
            <StatusChip :tone="dangerChipTone(required.danger)">{{ dangerLabel(required.danger) }}</StatusChip>
            <span class="text-[12px] font-medium text-foreground">{{ required.title }}</span>
            <code class="font-mono text-[9.5px] text-dim2">{{ required.capability }}</code>
          </div>
          <p class="mt-1 text-[11px] leading-relaxed text-dim">{{ required.description }}</p>
          <p v-if="required.hosts?.length" class="mt-1 font-mono text-[10px] text-dim2">域名白名单：{{ required.hosts.join("、") }}</p>
        </div>
        <p v-if="!installRequirements.length" class="text-[11px] text-dim2">无能力请求（纯声明式插件）。</p>
      </div>
    </ConfirmDialog>
  </div>
</template>
