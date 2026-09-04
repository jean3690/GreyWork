<script setup lang="ts">
/**
 * ToolTimeline —— 消息内的工具调用时间线。
 *
 * 数据源是 ACP 的 tool_call / tool_call_update（agent store 解析后并进 message.tools）。
 * 运行中自动展开、结算后收起为一行摘要，交互约定与 ThinkingBlock 一致。
 * MCP 工具额外标出所属服务器：agent 只把 `mcp__<server>__<tool>` 塞在 title 里，
 * 不标出来就看不出这一步其实是外部 MCP 服务器在干活。
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import Icon from "../Icon.vue";
import ToolCallDetail from "./ToolCallDetail.vue";
import {
  activityRowLabel,
  activityRowVerb,
  aggregateLifecycle,
  aggregateSummary,
  buildActivityRows,
  durationOf,
  formatDuration,
} from "../../lib/tool-activity";
import type { ToolActivity, ToolActivityKind } from "../../types";

const props = defineProps<{ activities: ToolActivity[] }>();
const { t } = useI18n();

/** 展开了细节的行（按 toolCallId）。默认全折叠：一屏里同时摊开十几个文件内容没人看得下去。 */
const openRows = ref<string[]>([]);

function toggleRow(toolCallId: string): void {
  const index = openRows.value.indexOf(toolCallId);
  if (index >= 0) openRows.value.splice(index, 1);
  else openRows.value.push(toolCallId);
}

/** 工具类型 → 外壳图标名（icons.ts 形状表的 key）。 */
const KIND_ICON: Record<ToolActivityKind, string> = {
  read: "folder",
  edit: "edit",
  delete: "delete",
  move: "arrow-right",
  search: "search",
  execute: "terminal",
  think: "magic",
  fetch: "earth",
  other: "lightning",
};

/** 聚合生命周期 → 徽标配色。 */
const STATUS_BADGE: Record<string, string> = {
  running: "bg-amber/10 text-amber",
  failed: "bg-destructive/10 text-destructive",
  waiting: "bg-panel text-dim2",
  done: "bg-mint/10 text-mint",
};

const open = ref(false);

const rows = computed(() => buildActivityRows(props.activities));
const lifecycle = computed(() => aggregateLifecycle(props.activities));
const summary = computed(() => aggregateSummary(props.activities, lifecycle.value));

/** 本条消息里出现过的 MCP 服务器（去重保序）——折叠态也必须能看见。 */
const mcpServers = computed(() => {
  const seen: string[] = [];
  for (const activity of props.activities) {
    if (activity.mcpServer && !seen.includes(activity.mcpServer)) seen.push(activity.mcpServer);
  }
  return seen;
});

const statusText = computed(() =>
  lifecycle.value === "running"
    ? t("chatView.toolStatus.running")
    : lifecycle.value === "failed"
      ? t("chatView.toolStatus.failed")
      : lifecycle.value === "waiting"
        ? t("chatView.toolStatus.waiting")
        : t("chatView.toolStatus.done"),
);

// 有调用在飞行中就展开（用户要实时看到 agent 在动什么工具）；全部结算后收起。
watch(
  lifecycle,
  (now, before) => {
    if (now === "running") open.value = true;
    else if (before === "running") open.value = false;
  },
  { immediate: true },
);
</script>

<template>
  <section
    class="overflow-hidden rounded-[10px] border border-line bg-panel-2"
    data-testid="tool-timeline"
    :data-open="open"
    :data-lifecycle="lifecycle"
  >
    <button
      type="button"
      class="flex w-full cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-left text-[12px] text-dim hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-cyan [font-family:inherit]"
      :aria-expanded="open"
      :aria-label="t('chatView.tools.toggle')"
      @click="open = !open"
    >
      <Icon name="hammer" :size="13" class="flex-none text-dim2" />
      <span class="flex-none font-medium">{{ t("chatView.tools.title") }}</span>
      <span class="truncate text-dim2">{{ summary }}</span>
      <span
        v-for="server in mcpServers"
        :key="server"
        class="flex h-4 flex-none items-center gap-1 rounded-full bg-cyan/10 px-1.5 text-[10px] text-cyan"
        data-testid="tool-mcp-badge"
      >
        <Icon name="earth" :size="9" />{{ t("chatView.tools.mcp") }} · {{ server }}
      </span>
      <span class="ml-auto flex h-4 flex-none items-center rounded-full px-1.5 text-[10px]" :class="STATUS_BADGE[lifecycle]">
        {{ statusText }}
      </span>
      <Icon :name="open ? 'up' : 'down'" :size="12" class="flex-none text-dim2" />
    </button>
    <ul v-if="open" class="m-0 flex list-none flex-col gap-1 border-t border-line px-2.5 py-1.5">
      <li
        v-for="row in rows"
        :key="row.activity.toolCallId"
        class="flex flex-col gap-0.5 text-[11.5px] leading-[1.6]"
        data-testid="tool-row"
        :data-mcp-server="row.activity.mcpServer"
      >
        <component
          :is="row.activity.detail ? 'button' : 'div'"
          :type="row.activity.detail ? 'button' : undefined"
          class="flex w-full items-center gap-1.5 text-left [font-family:inherit]"
          :class="
            row.activity.detail
              ? 'cursor-pointer hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-cyan'
              : ''
          "
          :aria-expanded="row.activity.detail ? openRows.includes(row.activity.toolCallId) : undefined"
          :data-testid="row.activity.detail ? 'tool-row-toggle' : undefined"
          @click="row.activity.detail ? toggleRow(row.activity.toolCallId) : undefined"
        >
          <Icon
            :name="KIND_ICON[row.activity.kind]"
            :size="11"
            class="flex-none"
            :class="row.activity.status === 'failed' ? 'text-destructive' : 'text-dim2'"
          />
          <span class="flex-none text-dim2">{{ activityRowVerb(row.activity) }}</span>
          <span v-if="row.activity.mcpServer" class="flex-none rounded-full bg-cyan/10 px-1.5 text-[10px] text-cyan">
            {{ row.activity.mcpServer }}
          </span>
          <span class="truncate font-mono text-dim [overflow-wrap:anywhere]">{{ activityRowLabel(row.activity) }}</span>
          <span v-if="row.repeat > 1" class="flex-none text-dim2">×{{ row.repeat }}</span>
          <Icon
            v-if="row.activity.detail"
            :name="openRows.includes(row.activity.toolCallId) ? 'up' : 'down'"
            :size="10"
            class="ml-auto flex-none text-dim2"
          />
          <span
            v-if="row.activity.finishedAt != null"
            class="flex-none font-mono text-[10px] text-dim2"
            :class="row.activity.detail ? '' : 'ml-auto'"
          >
            {{ formatDuration(durationOf(row.activity)) }}
          </span>
        </component>
        <p v-if="row.activity.error" class="m-0 pl-[18px] font-mono text-[10.5px] text-destructive [overflow-wrap:anywhere]">
          {{ row.activity.error }}
        </p>
        <ToolCallDetail
          v-if="row.activity.detail && openRows.includes(row.activity.toolCallId)"
          :detail="row.activity.detail"
          class="ml-[18px] mt-0.5"
        />
      </li>
    </ul>
  </section>
</template>
