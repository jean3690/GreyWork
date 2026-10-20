<script setup lang="ts">
/**
 * 协议层子代理指示器：agent 用 `subagent_update` 宣告内部子会话时，在会话头部亮一枚胶囊。
 *
 * 数据源 `agent.protocolSubagents`（stores/agent/subagent.ts 维护）。无子代理时零渲染，
 * 布局回到现状。展开可见每个子代理的当前工作状态、工具数、最新文本；宣告了
 * `capabilities.cancel` 的子代理可单独取消（发 ACP `session/cancel` 指向子会话 id）。
 *
 * 与 TeamView 的「编排子任务」看板是两回事：那是 UI 主动拆解并行任务，这里是 agent
 * 自己内部委派、经协议宣告的子会话。两者可并存，故本胶囊只读协议层子代理。
 */
import { computed } from "vue";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import Icon from "@/features/shared/Icon.vue";
import { i18n } from "@/i18n";
import { useAgentStore } from "@/stores/agent";
import type { SubagentState } from "@/stores/agent/state";

const t = i18n.global.t;
const agent = useAgentStore();

const subagents = computed(() => agent.protocolSubagents);
/** 活跃 = 未进入 idle 的（running / requires_action / unknown / 尚未上报状态）。 */
const active = computed(() => subagents.value.filter((child) => child.state?.state !== "idle"));
const activeCount = computed(() => active.value.length);
/** 需要用户关注（等待操作 / 状态未知）时给胶囊换色，避免被当背景噪音忽略。 */
const needsAttention = computed(() => subagents.value.some((child) => child.state?.state === "requires_action"));
const isUnknown = computed(() => subagents.value.some((child) => child.state?.state === "unknown"));

const chipLabel = computed(() => (activeCount.value === 1 ? t("subagent.activeOne") : t("subagent.active", { count: activeCount.value })));

const chipClass = computed(() => {
  if (needsAttention.value) return "border-amber/40 bg-amber/10 text-amber";
  if (isUnknown.value) return "border-line bg-panel-2 text-dim2";
  return "border-cyan/30 bg-cyan/10 text-cyan";
});

function stateLabel(child: SubagentState): string {
  const raw = child.state?.state ?? "unknown";
  return t(`subagent.state.${raw}`);
}

function stateDotClass(child: SubagentState): string {
  switch (child.state?.state) {
    case "running":
      return "bg-cyan";
    case "requires_action":
      return "bg-amber";
    case "idle":
      return "bg-line-2";
    default:
      return "bg-dim2";
  }
}

function titleOf(child: SubagentState): string {
  return child.title || child.description || t("subagent.fallbackTitle");
}

/** 嵌套缩进：根的子代理（深度 1）不缩进，逐层 +8px，封顶 3 层避免深层把行挤没。 */
function indentOf(child: SubagentState): string {
  const depth = agent.subagentDepthOf(child.sessionId);
  const level = Math.min(Math.max(depth - 1, 0), 3);
  return `${level * 8}px`;
}

async function cancel(child: SubagentState): Promise<void> {
  await agent.cancelSubagent(child.sessionId);
}
</script>

<template>
  <Popover v-if="subagents.length">
    <PopoverTrigger as-child>
      <button
        type="button"
        data-testid="subagent-chip"
        class="flex h-5 cursor-pointer items-center gap-1 rounded-full border px-2 text-[10.5px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
        :class="chipClass"
        :aria-label="t('subagent.panelTitle')"
      >
        <Icon name="peoples" :size="10" />
        {{ activeCount > 0 ? chipLabel : t("subagent.panelTitle") }}
      </button>
    </PopoverTrigger>
    <PopoverContent align="end" class="w-80 border-line bg-panel p-0 shadow-xl">
      <div class="border-b border-line-2 px-3 py-2 text-[11px] font-medium tracking-wide text-dim2 uppercase">
        {{ t("subagent.panelTitle") }}
      </div>
      <ul class="flex max-h-72 flex-col overflow-y-auto p-1">
        <li
          v-for="child in subagents"
          :key="child.sessionId"
          class="flex flex-col gap-1 rounded-[calc(6px*var(--gw-radius-scale))] px-2 py-1.5 hover:bg-panel-2"
          :style="{ marginLeft: indentOf(child) }"
        >
          <div class="flex items-center gap-1.5">
            <span class="size-1.5 shrink-0 rounded-full" :class="stateDotClass(child)" aria-hidden="true" />
            <span class="min-w-0 flex-1 truncate text-[12px] text-foreground">{{ titleOf(child) }}</span>
            <span class="shrink-0 text-[10px] text-dim2">{{ stateLabel(child) }}</span>
          </div>
          <div v-if="child.description && child.description !== titleOf(child)" class="truncate pl-3 text-[10.5px] text-dim2">
            {{ child.description }}
          </div>
          <div class="flex items-center gap-2 pl-3 text-[10px] text-dim2">
            <span v-if="child.toolCount > 0">{{ child.toolCount }} × 工具</span>
            <span v-if="child.lastText" class="min-w-0 flex-1 truncate">{{ child.lastText }}</span>
          </div>
          <div v-if="child.capabilities?.cancel" class="pl-3">
            <button
              type="button"
              class="cursor-pointer rounded-[calc(4px*var(--gw-radius-scale))] border border-line px-1.5 text-[10px] text-dim transition-colors hover:border-line-2 hover:text-foreground"
              :data-testid="`subagent-cancel-${child.sessionId}`"
              @click="cancel(child)"
            >
              {{ t("common.cancel") }}
            </button>
          </div>
        </li>
      </ul>
    </PopoverContent>
  </Popover>
</template>
