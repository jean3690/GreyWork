<script setup lang="ts">
/**
 * 插件市场 · MCP 专区：浏览官方 Registry 并把条目登记成本机 MCP 服务器。
 *
 * 与技能 / 插件两区的差别在「安装」的含义：MCP 没有包落盘这回事——登记只做一件事，
 * 把条目转成可编辑的服务器草稿（transport / url / command / env 占位）交给
 * `McpFormDialog`，用户确认后才写进 settings.mcpServers。所以这里：
 * - 搜索走宿主命令 mcp_search（浏览器态无宿主代理，如实说明不可用）；
 * - 卡片只给「登记 / 已登记」，真正的字段编辑在表单弹窗里（与设置 → MCP 同一条落库路径）。
 */
import { computed, onMounted, ref } from "vue";
import { i18n } from "@/i18n";
import { isTauriRuntime } from "@greywork/core";
import { useSettingsStore } from "@/stores/settings";
import { registryEntryToDraft, searchMcpRegistry, type McpRegistryDraft, type McpRegistryEntry } from "@/lib/mcp-registry";
import Icon from "@/features/shared/Icon.vue";
import { Skeleton } from "@/components/ui/skeleton";
import McpFormDialog, { type McpDraftPayload, type McpFormPreset } from "@/features/settings/McpFormDialog.vue";

const t = i18n.global.t;
const settings = useSettingsStore();
const hostAvailable = isTauriRuntime();

const query = ref("");
const results = ref<McpRegistryEntry[]>([]);
const searching = ref(false);
const error = ref<string | null>(null);
const searched = ref(false);
let timer: ReturnType<typeof setTimeout> | null = null;

interface RegistryRow {
  entry: McpRegistryEntry;
  draft: McpRegistryDraft;
  registered: boolean;
}

/** 已登记服务器名集合：登记按钮据此变「已登记」。 */
const registeredNames = computed(() => new Set(settings.mcpServers.map((server) => server.name)));

/**
 * 已登记判定：登记时默认用条目标题当服务器名（用户可在弹窗里改），所以标题与注册表名
 * 都比一遍。名字可改意味着这只是启发式：改过名再登记同一台会看到两个「未登记」按钮，
 * 但比「明明登记过却显示未登记」更不容易误导。
 */
function isRegistered(entry: McpRegistryEntry): boolean {
  return registeredNames.value.has(entry.name) || (entry.title ? registeredNames.value.has(entry.title) : false);
}

/** 预归一视图模型：draft/registered 只算一次，模板按行取用。 */
const rows = computed<RegistryRow[]>(() =>
  results.value.map((entry) => ({
    entry,
    draft: registryEntryToDraft(entry),
    registered: isRegistered(entry),
  })),
);

const registeredCount = computed(() => settings.mcpServers.length);

async function runSearch(): Promise<void> {
  error.value = null;
  searching.value = true;
  try {
    results.value = await searchMcpRegistry(query.value);
    searched.value = true;
  } catch (cause) {
    results.value = [];
    error.value = String(cause);
  } finally {
    searching.value = false;
  }
}

function onQueryInput(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void runSearch(), 400);
}

onMounted(() => {
  if (hostAvailable) void runSearch();
});

// ---------- 登记弹窗（与设置 → MCP 共用同一个表单组件与落库路径） ----------
const editorOpen = ref(false);
const editorPreset = ref<McpFormPreset | null>(null);

function startRegister(entry: McpRegistryEntry): void {
  const draft = registryEntryToDraft(entry);
  if (!draft.ok) return;
  editorPreset.value = {
    source: "registry",
    registry: entry,
    name: entry.title || entry.name,
    transport: draft.transport,
    url: draft.transport === "stdio" ? undefined : draft.url,
    command: draft.transport === "stdio" ? draft.command : undefined,
    args: draft.transport === "stdio" ? draft.args : undefined,
    envHint: draft.envNames,
  };
  editorOpen.value = true;
}

const editorExistingNames = computed(() => settings.mcpServers.map((server) => server.name));

function onEditorSave(payload: McpDraftPayload): void {
  settings.upsertMcpServer({
    id: `mcp-${Date.now().toString(36)}`,
    enabled: true,
    ...payload,
  });
  editorOpen.value = false;
  editorPreset.value = null;
}

function titleOf(entry: McpRegistryEntry): string {
  return entry.title || entry.name;
}

/** 条目的登记能力说明（不可一键登记时给出原因）。 */
function draftReason(row: RegistryRow): string {
  if (row.draft.ok) return "";
  if (row.draft.reason === "unsupported-only") return t("market.mcpUnsupportedTransport", { transports: row.draft.transports.join("、") });
  if (row.draft.reason === "unsupported-packages") return t("market.mcpUnsupportedPackages", { types: row.draft.packageTypes.join("、") });
  return t("market.mcpNoDraft");
}
</script>

<template>
  <div data-testid="market-mcp-section">
    <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
      <div class="relative min-w-0 flex-1">
        <Icon name="search" :size="13" class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dim2" />
        <input
          v-model="query"
          type="search"
          class="h-10 w-full rounded-[10px] border border-line bg-panel pl-9 pr-3 text-[12px] text-foreground outline-none placeholder:text-dim2 focus:border-accent"
          :placeholder="t('market.mcpSearchPlaceholder')"
          :disabled="!hostAvailable"
          data-testid="market-mcp-search"
          @input="onQueryInput"
          @keydown.enter.prevent="runSearch"
        />
      </div>
      <span class="shrink-0 text-[10.5px] text-dim2">{{ t("market.mcpRegisteredCount", { count: registeredCount }) }}</span>
    </div>

    <p class="mt-2 text-[10.5px] leading-relaxed text-dim2">{{ t("market.mcpInstallHint") }}</p>

    <p v-if="!hostAvailable" class="mt-3 rounded-[10px] border border-line bg-panel px-3 py-2 text-[11px] leading-relaxed text-dim2">
      {{ t("market.mcpDesktopOnly") }}
    </p>
    <p v-else-if="error" class="mt-3 rounded-[10px] border border-orange/30 bg-orange/10 px-3 py-2 text-[11.5px] text-orange" role="alert">
      {{ error }}
    </p>

    <div v-if="searching && results.length === 0" class="mt-3 grid gap-3 md:grid-cols-2">
      <Skeleton v-for="index in 4" :key="index" class="h-32 rounded-[14px] border border-line bg-panel" />
    </div>

    <div v-else-if="rows.length" class="mt-3 grid gap-3 md:grid-cols-2">
      <article
        v-for="row in rows"
        :key="row.entry.name"
        class="flex min-h-32 flex-col rounded-[14px] border border-line bg-panel p-4 transition-colors hover:border-line-2"
        :data-testid="`market-mcp-${row.entry.name}`"
      >
        <div class="flex items-start gap-3">
          <span class="grid size-10 shrink-0 place-items-center rounded-[11px] border border-line bg-panel-2 text-dim">
            <Icon name="terminal" :size="16" />
          </span>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <h2 class="truncate text-[13px] font-semibold text-foreground">{{ titleOf(row.entry) }}</h2>
              <span v-if="row.registered" class="shrink-0 rounded-full bg-mint/10 px-1.5 py-0.5 text-[9.5px] font-medium text-mint">
                {{ t("market.mcpRegistered") }}
              </span>
            </div>
            <p class="mt-0.5 truncate font-mono text-[9.5px] text-dim2">{{ row.entry.name }}</p>
          </div>
        </div>

        <p class="mt-3 line-clamp-3 flex-1 text-[11.5px] leading-[1.55] text-dim">
          {{ row.entry.description || t("market.noDescription") }}
        </p>

        <div class="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
          <span
            v-for="remote in row.entry.remotes"
            :key="`${row.entry.name}:${remote.transport}`"
            class="rounded-full border border-line px-1.5 py-px font-mono text-dim2"
          >
            {{ remote.transport }}
          </span>
          <span v-if="row.entry.remotes.length === 0" class="rounded-full border border-line px-1.5 py-px text-dim2">
            {{ t("market.mcpStdioOnly") }}
          </span>
        </div>

        <footer class="mt-3 flex items-center justify-between gap-3 border-t border-line pt-3">
          <span class="truncate font-mono text-[10px] text-dim2">{{ row.entry.version || "" }}</span>
          <button
            type="button"
            class="h-7 shrink-0 cursor-pointer rounded-[7px] px-3 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
            :class="row.registered ? 'border border-line text-dim2' : 'bg-accent text-accent-ink hover:bg-accent-hi'"
            :disabled="row.registered || !row.draft.ok || !hostAvailable"
            :data-testid="`market-mcp-register-${row.entry.name}`"
            @click="startRegister(row.entry)"
          >
            {{ row.registered ? t("market.mcpRegistered") : t("market.mcpRegister") }}
          </button>
        </footer>
        <p v-if="draftReason(row) && !row.registered" class="mt-1.5 text-[10.5px] text-dim2">{{ draftReason(row) }}</p>
      </article>
    </div>

    <div
      v-else-if="searched && !searching"
      class="mt-3 grid min-h-52 place-items-center rounded-[14px] border border-dashed border-line-2 bg-panel/50 px-6 text-center"
    >
      <div>
        <span class="mx-auto grid size-10 place-items-center rounded-[11px] bg-panel-2 text-dim2"><Icon name="search" :size="16" /></span>
        <p class="mt-3 text-[12px] font-medium text-foreground">{{ t("market.mcpNoResults") }}</p>
      </div>
    </div>

    <McpFormDialog
      :open="editorOpen"
      :entry="null"
      :preset="editorPreset"
      :existing-names="editorExistingNames"
      @save="onEditorSave"
      @cancel="
        editorOpen = false;
        editorPreset = null;
      "
    />
  </div>
</template>
