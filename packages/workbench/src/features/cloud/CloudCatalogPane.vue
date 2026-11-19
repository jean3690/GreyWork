<script setup lang="ts">
import { computed, shallowRef } from "vue";
import type { MarketSkillEntry } from "@greywork/plugins";
import { registryEntryToDraft, type McpRegistryEntry } from "@/lib/mcp-registry";
import { useSettingsStore } from "@/stores/settings";
import McpFormDialog, { type McpDraftPayload, type McpFormPreset } from "@/features/settings/McpFormDialog.vue";
import ConfirmDialog from "@/features/settings/ConfirmDialog.vue";
import CloudCatalogList from "./CloudCatalogList.vue";
import { downloadBlob, useCloudCatalog } from "./useCloudCatalog";
const { kind, query, skills, mcps, loading, busy, error, notice, search, install, downloadSkill } = useCloudCatalog();
const settings = useSettingsStore();
const confirm = shallowRef<MarketSkillEntry | null>(null);
const preset = shallowRef<McpFormPreset | null>(null);
const names = computed(() => settings.mcpServers.map((entry) => entry.name));
function register(entry: McpRegistryEntry): void {
  const draft = registryEntryToDraft(entry);
  if (!draft.ok) {
    error.value = "此 MCP 条目没有支持的远程接口或 npm / PyPI 包";
    return;
  }
  preset.value = {
    source: "registry",
    registry: entry,
    name: entry.title || entry.name,
    transport: draft.transport,
    ...(draft.transport === "stdio" ? { command: draft.command, args: draft.args } : { url: draft.url }),
    envHint: draft.envNames,
  };
}
function saveMcp(payload: McpDraftPayload): void {
  settings.upsertMcpServer({ id: `mcp-${crypto.randomUUID()}`, enabled: false, ...payload });
  preset.value = null;
  notice.value = "已添加 MCP 配置（默认停用）。填写必要密钥并在 MCP 设置中启用。";
}
function downloadMcp(entry: McpRegistryEntry): void {
  const draft = registryEntryToDraft(entry);
  if (!draft.ok) {
    error.value = "此 MCP 条目无法生成配置";
    return;
  }
  const config = draft.transport === "stdio" ? { command: draft.command, args: draft.args } : { type: draft.transport, url: draft.url };
  downloadBlob(
    new Blob([JSON.stringify({ mcpServers: { [entry.name]: config } }, null, 2)], { type: "application/json" }),
    "mcp-config.json",
  );
}
function confirmInstall(): void {
  const entry = confirm.value;
  confirm.value = null;
  if (entry) void install(entry);
}
</script>

<template>
  <div class="mx-auto max-w-[900px]">
    <h2 class="text-[16px] font-semibold text-foreground">MCP / Skills 下载</h2>
    <p class="mb-4 mt-1 text-[12px] text-dim">浏览服务器发布的能力目录。技能可下载或安装到当前工作区，MCP 可下载配置并按需启用。</p>
    <form class="mb-4 flex flex-wrap gap-2" @submit.prevent="search">
      <select
        v-model="kind"
        class="rounded-[calc(6px*var(--gw-radius-scale))] border border-line bg-panel px-3 py-2 text-[12px] text-foreground"
        aria-label="能力类型"
      >
        <option value="skills">Skills</option>
        <option value="mcp">MCP</option>
      </select>
      <input
        v-model="query"
        class="min-w-[150px] flex-1 rounded-[calc(6px*var(--gw-radius-scale))] border border-line bg-panel px-3 py-2 text-[12px] text-foreground"
        aria-label="搜索服务器能力"
        placeholder="搜索名称或描述"
      />
      <button class="rounded-[calc(6px*var(--gw-radius-scale))] bg-cyan/15 px-4 py-2 text-[12px] text-cyan" :disabled="loading">
        搜索
      </button>
    </form>
    <p v-if="error" role="alert" class="mb-3 text-[12px] text-red-400">{{ error }}</p>
    <p v-if="notice" role="status" class="mb-3 text-[12px] text-cyan">{{ notice }}</p>
    <CloudCatalogList
      :kind="kind"
      :skills="skills"
      :mcps="mcps"
      :loading="loading"
      :busy="busy"
      @install="confirm = $event"
      @download-skill="downloadSkill"
      @register="register"
      @download-mcp="downloadMcp"
    />
    <ConfirmDialog
      v-if="confirm"
      title="安装技能"
      :message="`安装「${confirm.name}」到当前工作区？已有同名技能将被更新。技能可能影响 Agent 的行为，请确认来源可信。`"
      confirm-label="安装"
      @confirm="confirmInstall"
      @cancel="confirm = null"
    />
    <McpFormDialog
      v-if="preset"
      :open="true"
      :entry="null"
      :preset="preset"
      :existing-names="names"
      @save="saveMcp"
      @cancel="preset = null"
    />
  </div>
</template>
