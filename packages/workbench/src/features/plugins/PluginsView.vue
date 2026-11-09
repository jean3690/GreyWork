<script setup lang="ts">
import { computed, ref } from "vue";
import { i18n } from "@/i18n";
import Hint from "@/features/shared/Hint.vue";
import StatusChip from "@/features/shared/StatusChip.vue";
import { capabilityAuditLog, capabilityTitle, resetCapabilityAuditForTest, type CapabilityAuditEntry } from "@/plugins/capabilities";
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
/** 命令面板条目（归属插件 + 标题），同一响应式来源。 */
const contributedCommands = computed(() =>
  loader.snapshot().commands.map((command) => ({ pluginId: command.pluginId, id: command.id, title: command.title })),
);

const busyId = ref<string | null>(null);
/** 停用 core.plugins（自身）前的两步确认。 */
const confirmDisableId = ref<string | null>(null);
const notice = ref<{ kind: "ok" | "error"; text: string } | null>(null);
const activeSection = ref<"mcp" | "skills" | "installed" | "audit">("installed");

/**
 * 能力参数的短摘要：net.fetch 是域名白名单，mcp.connect 是「服务器(工具/工具)」。
 * 空摘要 = 该能力没有可展示的参数。
 */
function capabilityParams(params: { hosts?: string[]; servers?: Array<{ name: string; tools: string[] }> }): string {
  if (params.hosts?.length) return params.hosts.join("、");
  if (params.servers?.length) return params.servers.map((server) => `${server.name}(${server.tools.join("/")})`).join("、");
  return "";
}

/** manifest.requires（可能为对象形态）归一化为 chip 列表。 */
const requiredCapabilitiesByPlugin = computed(() =>
  Object.fromEntries(
    pluginManifests.value.map((manifest) => [
      manifest.id,
      (manifest.requires ?? []).map((spec) =>
        typeof spec === "string"
          ? { capability: spec, hosts: undefined as string[] | undefined, servers: undefined }
          : { capability: spec.capability, hosts: spec.hosts, servers: spec.servers },
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

/** 能力授权 chip 的态色：已授权走薄荷、未授权走琥珀。 */
function grantChipClass(manifestId: string, capability: string): string {
  if (isPluginCapabilityGranted(manifestId, capability)) return "border-mint/30 bg-mint/10 text-mint";
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

function toggleLabel(manifestId: string): string {
  if (busyId.value === manifestId) return "…";
  return isPluginEnabled(manifestId) ? t("market.disable") : t("market.enable");
}

type MarketSection = "mcp" | "skills" | "installed" | "audit";

/**
 * 页签定义：MCP / 技能 / 已装 / 能力审计，各自带计数。
 *
 * 三种形态的「安装」各给一个专区：MCP 是登记服务器声明，技能是往工作区写技能目录，
 * 已装页只做启停与能力授权——不塞进同一张卡片网格。
 */
const sectionTabs = computed(() => [
  { key: "mcp" as const, label: t("market.tabMcp"), count: settings.mcpServers.length },
  { key: "skills" as const, label: t("market.tabSkills"), count: skills.installed.length },
  { key: "installed" as const, label: t("market.installedPlugins"), count: pluginManifests.value.length },
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
</script>

<template>
  <div
    class="mx-auto flex h-full min-h-0 w-full max-w-[1120px] flex-col overflow-y-auto px-4 py-4 sm:px-6 sm:py-6"
    data-testid="plugin-center"
  >
    <p
      v-if="notice"
      role="status"
      class="mb-3 rounded-[calc(10px*var(--gw-radius-scale))] border px-3 py-2 text-[12px]"
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
    </nav>

    <section v-if="activeSection === 'mcp'" class="mt-4">
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
          class="rounded-[calc(12px*var(--gw-radius-scale))] border border-line bg-panel px-3.5 py-3 transition-colors"
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
                <code class="rounded-[calc(5px*var(--gw-radius-scale))] bg-panel-2 px-1.5 py-0.5 text-[9.5px] text-dim2">{{
                  manifest.id
                }}</code>
                <span class="font-mono text-[9.5px] text-dim2">v{{ manifest.version }}</span>
              </div>
              <p v-if="manifest.description" class="mt-1 text-[11px] leading-relaxed text-dim">{{ manifest.description }}</p>
              <p v-if="manifest.dependsOn?.length" class="mt-1 font-mono text-[9.5px] text-dim2">
                depends · {{ manifest.dependsOn.join(", ") }}
              </p>
              <div v-if="requiredCapabilitiesByPlugin[manifest.id]?.length" class="mt-2 flex flex-wrap items-center gap-1.5">
                <Hint
                  v-for="required in requiredCapabilitiesByPlugin[manifest.id]"
                  :key="required.capability"
                  :text="capabilityParams(required) || null"
                  multiline
                >
                  <button
                    type="button"
                    class="cursor-pointer rounded-[calc(6px*var(--gw-radius-scale))] border px-1.5 py-0.5 text-[9.5px] transition-colors"
                    :class="grantChipClass(manifest.id, required.capability)"
                    :aria-pressed="isPluginCapabilityGranted(manifest.id, required.capability)"
                    :data-testid="`plugin-capability-${manifest.id}-${required.capability}`"
                    @click="toggleGrant(manifest.id, required.capability)"
                  >
                    {{ capabilityTitle(required.capability) }}{{ capabilityParams(required) ? ` · ${capabilityParams(required)}` : "" }} ·
                    {{ grantLabel(manifest.id, required.capability) }}
                  </button>
                </Hint>
              </div>
            </div>
            <div v-if="confirmDisableId === manifest.id" class="flex max-w-[290px] shrink-0 flex-col items-end gap-1.5">
              <span
                class="rounded-[calc(7px*var(--gw-radius-scale))] bg-amber/10 px-2 py-1 text-right text-[9.5px] leading-snug text-amber"
                >{{ t("market.selfDisableWarn") }}</span
              >
              <div class="flex gap-1.5">
                <button
                  type="button"
                  class="h-7 rounded-[calc(7px*var(--gw-radius-scale))] bg-orange px-2.5 text-[11px] text-white"
                  @click="confirmSelfDisable"
                >
                  {{ t("common.delete") }}
                </button>
                <button
                  type="button"
                  class="h-7 rounded-[calc(7px*var(--gw-radius-scale))] border border-line px-2.5 text-[11px] text-dim"
                  @click="confirmDisableId = null"
                >
                  {{ t("common.cancel") }}
                </button>
              </div>
            </div>
            <button
              type="button"
              class="h-7 w-14 shrink-0 cursor-pointer rounded-[calc(7px*var(--gw-radius-scale))] text-[11px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
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

      <div
        v-else
        class="grid min-h-52 place-items-center rounded-[calc(14px*var(--gw-radius-scale))] border border-dashed border-line-2 text-center"
      >
        <div>
          <p class="text-[12px] text-dim2">{{ t("market.pluginsEmpty") }}</p>
          <button
            type="button"
            class="mt-3 h-8 rounded-[calc(8px*var(--gw-radius-scale))] bg-accent px-3 text-[11px] text-accent-ink"
            @click="restoreBuiltinPlugins()"
          >
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
          class="h-7 cursor-pointer rounded-[calc(7px*var(--gw-radius-scale))] border border-line px-2.5 text-[11px] text-dim transition-colors hover:border-orange/40 hover:text-orange"
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
          class="flex items-start gap-2.5 rounded-[calc(10px*var(--gw-radius-scale))] border border-line bg-panel px-3 py-2"
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
      <div
        v-else
        class="grid min-h-52 place-items-center rounded-[calc(14px*var(--gw-radius-scale))] border border-dashed border-line-2 text-center"
      >
        <p class="text-[12px] text-dim2">{{ t("market.auditEmpty") }}</p>
      </div>
    </section>

    <div class="sr-only" aria-hidden="true">
      <span v-for="mode in contributedModes" :key="mode.id" :data-testid="`mode-chip-${mode.id}`">{{ mode.title }}</span>
      <span v-for="region in contributedRegions" :key="region.id" :data-testid="`region-chip-${region.region}-${region.id}`">
        {{ region.region }} · {{ region.title }}
      </span>
      <span
        v-for="command in contributedCommands"
        :key="`${command.pluginId}:${command.id}`"
        :data-testid="`command-chip-${command.pluginId}-${command.id}`"
      >
        {{ command.title }}
      </span>
    </div>
  </div>
</template>
