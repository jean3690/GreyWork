<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { appEvents } from "@/events";
import { useSettingsStore } from "@/stores/settings";
import { MCP_TRANSPORT_LABELS } from "@/lib/mcp-labels";
import Icon from "@/features/shared/Icon.vue";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

/**
 * MCP 服务器配置弹窗（远程助手侧）：勾选哪些服务器随 ACP 会话声明给 agent。
 *
 * 这里只做「启用哪些」——增删改与探活仍归 设置 → MCP（本弹窗给一跳转）。
 * 声明与连接的主语是 agent：宿主不代理工具调用，所以开关只影响下个会话的声明面。
 */
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const settings = useSettingsStore();

const enabledCount = computed(() => settings.mcpServers.filter((server) => server.enabled).length);

/** 增删改归「设置 → MCP」：这里只勾启用面，跳过去时先收起自己（避免两层弹窗打架）。 */
function openSettings(): void {
  emit("close");
  appEvents.emit("settings:open", { section: "mcp" });
}

function onOpenChange(next: boolean): void {
  if (!next) emit("close");
}
</script>

<template>
  <Dialog :open="props.open" @update:open="onOpenChange">
    <DialogContent
      :show-close-button="false"
      class="flex max-h-[88vh] flex-col gap-0 overflow-hidden rounded-[14px] border-line bg-panel p-0 shadow-xl sm:max-w-[520px]"
      data-testid="remote-mcp-dialog"
    >
      <div class="flex items-center justify-between px-4 pb-2 pt-3.5">
        <div class="flex min-w-0 items-center gap-2.5">
          <span class="grid size-7 shrink-0 place-items-center rounded-[8px] border border-line bg-panel-2 text-dim">
            <Icon name="terminal" :size="14" />
          </span>
          <div class="min-w-0">
            <DialogTitle class="text-[13px] font-medium text-foreground">{{ t("remoteAssist.rows.mcpName") }}</DialogTitle>
            <DialogDescription class="mt-0.5 text-[10.5px] leading-relaxed text-dim2">
              {{ t("remoteAssist.rows.mcpDesc") }}
            </DialogDescription>
          </div>
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
        <p class="text-[10.5px] leading-relaxed text-dim2">
          {{ t("remoteAssist.mcp.enabledCount", { enabled: enabledCount, total: settings.mcpServers.length }) }}
        </p>

        <p v-if="settings.mcpServers.length === 0" class="rounded-[10px] border border-line bg-panel-2 px-3 py-2 text-[11px] text-dim2">
          {{ t("remoteAssist.mcp.empty") }}
        </p>

        <div v-else class="flex flex-col gap-1.5">
          <label
            v-for="server in settings.mcpServers"
            :key="server.id"
            class="flex cursor-pointer items-center gap-3 rounded-[10px] border border-line bg-panel-2 px-3 py-2"
            :data-testid="`mcp-toggle-row-${server.id}`"
          >
            <span class="min-w-0 flex-1">
              <span class="flex items-center gap-1.5">
                <span class="truncate text-[12px] text-foreground">{{ server.name }}</span>
                <span class="shrink-0 rounded-full border border-line px-1.5 text-[9.5px] text-dim2">
                  {{ MCP_TRANSPORT_LABELS[server.transport] ?? server.transport }}
                </span>
              </span>
              <span class="mt-0.5 block truncate font-mono text-[10px] text-dim2">
                {{ server.transport === "stdio" ? [server.command, ...(server.args ?? [])].join(" ") : server.url }}
              </span>
            </span>
            <input
              type="checkbox"
              class="size-4 shrink-0 cursor-pointer accent-[var(--accent)]"
              :checked="server.enabled"
              :aria-label="server.name"
              :data-testid="`mcp-toggle-${server.id}`"
              @change="settings.setMcpServerEnabled(server.id, ($event.target as HTMLInputElement).checked)"
            />
          </label>
        </div>

        <button
          type="button"
          class="h-7 w-fit cursor-pointer rounded-[7px] border border-line bg-panel-2 px-2.5 text-[11.5px] text-dim transition-colors hover:border-line-2 hover:text-foreground"
          data-testid="mcp-open-settings"
          @click="openSettings"
        >
          {{ t("remoteAssist.mcp.openSettings") }}
        </button>
      </div>
    </DialogContent>
  </Dialog>
</template>
