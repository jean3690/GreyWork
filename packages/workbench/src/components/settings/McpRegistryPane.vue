<script setup lang="ts">
/**
 * MCP 官方 Registry（registry.modelcontextprotocol.io）浏览与登记。
 *
 * 仅桌面态可用：搜索走宿主命令 mcp_search（浏览器态无代理直连）。
 * 「登记」只做一件事——把条目转成可编辑的登记草稿交给父级弹窗
 * （transport 归一 streamable-http → http），stdio-only 条目不可登记。
 */
import { computed, ref, watch } from "vue";
import { isTauriRuntime } from "@greywork/core";
import { useSettingsStore } from "../../stores/settings";
import { registryEntryToDraft, searchMcpRegistry, type McpRegistryDraft, type McpRegistryEntry } from "../../lib/mcp-registry";
import Icon from "../Icon.vue";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: []; register: [entry: McpRegistryEntry] }>();

const settings = useSettingsStore();
const hostAvailable = isTauriRuntime();

const query = ref("");
const results = ref<McpRegistryEntry[]>([]);
const searching = ref(false);
const error = ref<string | null>(null);
const searched = ref(false);

let timer: ReturnType<typeof setTimeout> | null = null;

/** 同名（或同 name）已登记过的服务器名集合：登记按钮变「已登记」。 */
const registeredNames = computed(() => new Set(settings.mcpServers.map((server) => server.name)));

interface RegistryRow {
  entry: McpRegistryEntry;
  draft: McpRegistryDraft;
  registered: boolean;
}

/** 预归一视图模型：draft/registered 只算一次，模板按行取用。 */
const rows = computed<RegistryRow[]>(() =>
  results.value.map((entry) => ({
    entry,
    draft: registryEntryToDraft(entry),
    registered: registeredNames.value.has(entry.name),
  })),
);

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

watch(
  () => props.open,
  (open) => {
    if (open && !searched.value && hostAvailable) void runSearch();
  },
);

function titleOf(entry: McpRegistryEntry): string {
  return entry.title || entry.name;
}
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    role="dialog"
    aria-modal="true"
    @click.self="emit('close')"
  >
    <div class="flex max-h-[88vh] w-full max-w-[560px] flex-col rounded-[14px] border border-line bg-panel shadow-xl">
      <div class="flex items-center justify-between px-4 pb-2 pt-3.5">
        <div class="min-w-0">
          <div class="text-[13px] font-medium text-foreground">MCP Registry · 官方</div>
          <p class="mt-0.5 text-[10.5px] text-dim2">registry.modelcontextprotocol.io · 登记 = 写入本机 MCP 服务器列表</p>
        </div>
        <button
          type="button"
          class="grid size-6 shrink-0 cursor-pointer place-items-center rounded-[6px] text-dim transition-colors hover:bg-panel-2 hover:text-foreground"
          aria-label="关闭"
          @click="emit('close')"
        >
          <Icon name="close" :size="13" />
        </button>
      </div>

      <div class="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 pb-4 pt-1">
        <div class="flex items-center gap-2">
          <input
            v-model="query"
            class="min-w-0 flex-1 rounded-[8px] border border-line bg-panel-2 px-2.5 py-1.5 text-[12px] text-foreground outline-none placeholder:text-dim2 focus:border-accent"
            placeholder="搜索服务器名 / 关键字，回车或停顿后自动搜索"
            :disabled="!hostAvailable"
            @input="onQueryInput"
            @keydown.enter.prevent="runSearch"
          />
          <button
            type="button"
            class="rounded-[8px] border border-line bg-panel-2 px-2.5 py-1.5 text-[11px] text-dim transition-colors hover:text-foreground disabled:opacity-50"
            :disabled="!hostAvailable || searching"
            @click="runSearch"
          >
            {{ searching ? "搜索中…" : "搜索" }}
          </button>
        </div>

        <p v-if="!hostAvailable" class="rounded-[8px] border border-line bg-panel-2 px-2.5 py-1.5 text-[11px] leading-relaxed text-dim2">
          浏览器预览态无宿主命令，官方 Registry 浏览需要桌面版（Tauri）。
        </p>
        <p v-else-if="error" class="text-[11px] text-destructive">{{ error }}</p>
        <p v-else-if="searched && results.length === 0 && !searching" class="px-1 text-[11px] text-dim2">没有匹配的服务器。</p>

        <div v-if="results.length > 0" class="flex flex-col gap-2">
          <div v-for="row in rows" :key="row.entry.name" class="rounded-[10px] bg-panel-2 p-2.5">
            <div class="flex items-start gap-2">
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1.5">
                  <span class="truncate text-[12px] font-medium text-foreground">{{ titleOf(row.entry) }}</span>
                  <span class="shrink-0 truncate rounded-full border border-line px-1.5 py-px font-mono text-[10px] text-dim2">{{
                    row.entry.name
                  }}</span>
                </div>
                <p v-if="row.entry.description" class="mt-1 line-clamp-2 text-[11px] leading-relaxed text-dim2">
                  {{ row.entry.description }}
                </p>
                <div class="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px]">
                  <template v-for="remote in row.entry.remotes" :key="`${row.entry.name}:${remote.transport}`">
                    <span
                      class="rounded-full border px-1.5 py-px font-mono"
                      :class="
                        remote.transport === 'streamable-http' || remote.transport === 'http' || remote.transport === 'sse'
                          ? 'border-line text-dim'
                          : 'border-line text-dim2 line-through'
                      "
                    >
                      {{ remote.transport }}
                    </span>
                  </template>
                  <span v-if="row.entry.remotes.length === 0" class="rounded-full border border-line px-1.5 py-px text-dim2"
                    >stdio / 无远程端点</span
                  >
                  <span
                    v-for="pkg in row.entry.packages"
                    :key="`${row.entry.name}:${pkg.identifier}`"
                    class="rounded-full border border-line px-1.5 py-px font-mono text-dim2"
                  >
                    {{ pkg.registry_type }} · {{ pkg.identifier }}
                  </span>
                </div>
              </div>
              <button
                type="button"
                class="shrink-0 rounded-[8px] border border-line px-2.5 py-1 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                :class="
                  row.registered
                    ? 'text-dim2'
                    : row.draft.ok
                      ? 'border-line text-dim hover:border-line-2 hover:text-foreground'
                      : 'text-dim2'
                "
                :disabled="row.registered || !row.draft.ok"
                @click="emit('register', row.entry)"
              >
                {{ row.registered ? "已登记" : "登记" }}
              </button>
            </div>
            <p v-if="!row.draft.ok && !row.registered" class="mt-1.5 text-[10.5px] text-dim2">
              {{
                row.draft.reason === "no-remote"
                  ? "该条目只有 stdio/npm 包，需要本地命令启动，暂不支持一键登记"
                  : `远程端点传输 ${row.draft.transports.join("、")} 暂不支持`
              }}
            </p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
