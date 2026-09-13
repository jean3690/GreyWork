<script setup lang="ts">
/**
 * 设置页 MCP 面板：服务器列表（启用/编辑/删除/测试连接）+ 新增/编辑弹窗
 * （含请求头与 stdio 环境变量 KV）+ 官方 Registry 浏览登记。
 *
 * 数据全在 settings store（变更即持久化）；「测试连接」走宿主 mcp_probe。
 */
import { computed, ref } from "vue";
import { useAgentStore } from "../../stores/agent";
import { useSettingsStore, type McpServerEntry } from "../../stores/settings";
import { MCP_SKIP_REASONS, MCP_TRANSPORT_LABELS } from "../../lib/mcp-labels";
import { registryEntryToDraft, type McpRegistryEntry } from "../../lib/mcp-registry";
import ConfirmDialog from "./ConfirmDialog.vue";
import McpFormDialog, { type McpDraftPayload, type McpFormPreset } from "./McpFormDialog.vue";
import McpRegistryPane from "./McpRegistryPane.vue";

const settings = useSettingsStore();
const agent = useAgentStore();

/** 每台服务器最近一次「测试连接」的结果（成功列工具，失败给原因）。 */
const mcpProbes = ref<Record<string, { server?: string; tools?: string[]; durationMs?: number; error?: string }>>({});
/** 允许不同服务器并发探活，但同一台在请求完成前不可重复触发。 */
const mcpProbing = ref<Record<string, true>>({});

// ---------- 新增 / 编辑弹窗 ----------
const editorOpen = ref(false);
const editorEntry = ref<McpServerEntry | null>(null);
const editorPreset = ref<McpFormPreset | null>(null);
const editorExistingNames = computed(() =>
  settings.mcpServers.filter((server) => server.id !== editorEntry.value?.id).map((server) => server.name),
);

function openAdd(): void {
  editorEntry.value = null;
  editorPreset.value = null;
  editorOpen.value = true;
}

function openEdit(entry: McpServerEntry): void {
  editorEntry.value = entry;
  editorPreset.value = null;
  editorOpen.value = true;
}

function onEditorSave(payload: McpDraftPayload): void {
  if (editorEntry.value) {
    // 编辑：保留原 id 与启停状态，并清掉已失效的探活结果。
    settings.upsertMcpServer({
      ...editorEntry.value,
      ...payload,
    });
    delete mcpProbes.value[editorEntry.value.id];
  } else {
    settings.upsertMcpServer({
      id: `mcp-${Date.now().toString(36)}`,
      enabled: true,
      ...payload,
    });
  }
  editorOpen.value = false;
}

/** 官方 Registry 条目 → 预填到新增弹窗（可改），登记与手动添加同一条落库路径。 */
function onRegistryRegister(entry: McpRegistryEntry): void {
  const draft = registryEntryToDraft(entry);
  if (!draft.ok) return;
  editorPreset.value = {
    source: "registry",
    registry: entry,
    name: entry.title || entry.name,
    transport: draft.transport,
    url: draft.url,
    envHint: draft.envNames,
  };
  editorEntry.value = null;
  editorOpen.value = true;
}

// ---------- 测试连接 ----------
async function testMcpServer(entry: McpServerEntry): Promise<void> {
  if (mcpProbing.value[entry.id]) return;
  mcpProbing.value = { ...mcpProbing.value, [entry.id]: true };
  try {
    const { id: _id, enabled: _enabled, ...config } = entry;
    const { report, error } = await agent.probeMcpServer(config);
    mcpProbes.value = {
      ...mcpProbes.value,
      [entry.id]: error
        ? { error }
        : {
            server: report?.serverName ? `${report.serverName} ${report.serverVersion ?? ""}`.trim() : undefined,
            tools: report?.tools.map((tool) => tool.name) ?? [],
            durationMs: report?.durationMs,
          },
    };
  } catch (error) {
    mcpProbes.value = { ...mcpProbes.value, [entry.id]: { error: String(error) } };
  } finally {
    const { [entry.id]: _done, ...remaining } = mcpProbing.value;
    mcpProbing.value = remaining;
  }
}

// ---------- 删除确认 ----------
const deleteTarget = ref<McpServerEntry | null>(null);

function confirmDelete(): void {
  if (!deleteTarget.value) return;
  settings.removeMcpServer(deleteTarget.value.id);
  delete mcpProbes.value[deleteTarget.value.id];
  deleteTarget.value = null;
}

// ---------- Registry 浏览 ----------
const registryOpen = ref(false);
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="rounded-[14px] border border-line bg-panel p-4">
      <div class="mb-1 text-[13px] font-medium text-foreground">MCP 服务器</div>
      <p class="mb-3 text-[11px] leading-relaxed text-dim2">
        启用的服务器会在建会话时声明给 agent，由 <b>agent 自己连接</b>并把工具并入它的工具面；宿主不代理工具调用。 HTTP / SSE 需要后端在
        initialize 时声明对应能力，不支持会被跳过并在下方说明原因；stdio 所有后端都必须支持。
      </p>

      <div v-if="settings.mcpServers.length === 0" class="text-[12px] text-dim2">还没有声明任何 MCP 服务器。</div>
      <div v-else class="flex flex-col gap-2">
        <div v-for="entry in settings.mcpServers" :key="entry.id" class="rounded-[10px] bg-panel-2 p-2.5">
          <div class="flex items-center gap-2">
            <span class="min-w-0 flex-1 truncate text-[12px] text-foreground">{{ entry.name }}</span>
            <span class="shrink-0 rounded-full border border-line px-1.5 text-[10px] text-dim2">
              {{ MCP_TRANSPORT_LABELS[entry.transport] ?? entry.transport }}
            </span>
            <label class="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-dim">
              <input
                type="checkbox"
                :checked="entry.enabled"
                @change="settings.setMcpServerEnabled(entry.id, ($event.target as HTMLInputElement).checked)"
              />
              启用
            </label>
          </div>
          <div class="mt-1 truncate font-mono text-[11px] text-dim2">
            {{ entry.transport === "stdio" ? [entry.command, ...(entry.args ?? [])].join(" ") : entry.url }}
          </div>
          <div class="mt-2 flex items-center gap-1.5">
            <button
              type="button"
              class="rounded-[8px] border border-line px-2 py-1 text-[11px] text-dim transition-colors hover:text-foreground disabled:opacity-50"
              :disabled="Boolean(mcpProbing[entry.id]) || entry.transport === 'sse'"
              :title="entry.transport === 'sse' ? 'SSE 需由 agent 建立长连接，宿主不代为探活' : undefined"
              @click="testMcpServer(entry)"
            >
              {{ entry.transport === "sse" ? "由 agent 连接" : mcpProbing[entry.id] ? "连接中…" : "测试连接" }}
            </button>
            <button
              type="button"
              class="rounded-[8px] border border-line px-2 py-1 text-[11px] text-dim transition-colors hover:text-foreground"
              @click="openEdit(entry)"
            >
              编辑
            </button>
            <button
              type="button"
              class="rounded-[8px] border border-line px-2 py-1 text-[11px] text-dim transition-colors hover:text-destructive"
              @click="deleteTarget = entry"
            >
              删除
            </button>
          </div>
          <p v-if="mcpProbes[entry.id]?.error" class="mt-1.5 text-[11px] text-destructive">
            {{ mcpProbes[entry.id]?.error }}
          </p>
          <p v-else-if="mcpProbes[entry.id]" class="mt-1.5 text-[11px] text-dim">
            {{ mcpProbes[entry.id]?.server ?? "已连接" }} · {{ mcpProbes[entry.id]?.durationMs ?? 0 }}ms · 工具
            {{ mcpProbes[entry.id]?.tools?.length ?? 0
            }}<template v-if="(mcpProbes[entry.id]?.tools?.length ?? 0) > 0"
              >：{{ (mcpProbes[entry.id]?.tools ?? []).join("、") }}</template
            >
          </p>
        </div>
      </div>

      <div class="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          class="h-6 cursor-pointer rounded-[6px] border border-line bg-panel-2 px-2 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-foreground"
          @click="openAdd"
        >
          ＋ 添加服务器
        </button>
        <button
          type="button"
          class="h-6 cursor-pointer rounded-[6px] border border-line bg-panel-2 px-2 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-foreground"
          @click="registryOpen = true"
        >
          从官方 Registry 添加
        </button>
        <button
          v-if="settings.mcpServers.some((server) => !server.enabled)"
          type="button"
          class="h-6 cursor-pointer rounded-[6px] border border-line bg-panel-2 px-2 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-foreground"
          @click="settings.setAllMcpServersEnabled(true)"
        >
          全部启用
        </button>
        <button
          v-if="settings.mcpServers.some((server) => server.enabled)"
          type="button"
          class="h-6 cursor-pointer rounded-[6px] border border-line bg-panel-2 px-2 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-foreground"
          @click="settings.setAllMcpServersEnabled(false)"
        >
          全部停用
        </button>
      </div>
    </div>

    <div v-if="agent.acpMcpServers.length > 0 || agent.acpMcpSkipped.length > 0" class="rounded-[14px] border border-line bg-panel p-4">
      <div class="mb-2 text-[13px] font-medium text-foreground">上次建会话的声明结果</div>
      <p v-if="agent.acpMcpServers.length > 0" class="text-[11px] text-dim">已声明：{{ agent.acpMcpServers.join("、") }}</p>
      <p v-for="skip in agent.acpMcpSkipped" :key="skip.name" class="text-[11px] text-destructive">
        已跳过 {{ skip.name }}：{{ MCP_SKIP_REASONS[skip.reason] ?? skip.reason }}
      </p>
    </div>

    <McpFormDialog
      :open="editorOpen"
      :entry="editorEntry"
      :preset="editorPreset"
      :existing-names="editorExistingNames"
      @save="onEditorSave"
      @cancel="editorOpen = false"
    />

    <McpRegistryPane :open="registryOpen" @close="registryOpen = false" @register="onRegistryRegister" />

    <ConfirmDialog
      v-if="deleteTarget"
      title="删除 MCP 服务器？"
      :message="`将移除「${deleteTarget.name}」。已建立的 agent 会话不受影响，新会话不再下发该服务器。`"
      confirm-label="删除"
      @confirm="confirmDelete"
      @cancel="deleteTarget = null"
    />
  </div>
</template>
