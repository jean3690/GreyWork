<script setup lang="ts">
/**
 * 计划模式卡片（planPending 消息）：
 * - 内部 mock：展示拟执行的步骤时间线，确认后由 chat.confirmPlan 交回管线（intent 从 planDraft 取）。
 * - ACP 后端：展示派发目标 + 意图草稿，确认后 agent.confirmAcpPlan 复用已入流支架派发，不重复入流。
 * 确认/取消都等航次空闲才允许：运行中确认会被忽略（卡片保持挂起），避免与在途回合打架。
 */
import { useI18n } from "vue-i18n";
import { useAgentStore } from "@/stores/agent";
import { useChatStore } from "@/stores/chat";
import { useTurnActive } from "@/lib/turn-activity";
import Icon from "@/features/shared/Icon.vue";
import type { ChatStepKind, ThreadMessage } from "@/types";

const props = defineProps<{ threadId: string; message: ThreadMessage }>();

const { t } = useI18n();
const agent = useAgentStore();
const chat = useChatStore();

/** 步骤 kind → 装饰图标（展示语义，无 i18n）。 */
const STEP_ICONS: Record<ChatStepKind, string> = {
  read: "search",
  search: "search",
  write: "edit",
  exec: "terminal",
  test: "check",
};

/** 航次空闲判定：对 mock 与 ACP 统一（确认执行就是要启动一个航次）。 */
const busy = useTurnActive();

function confirm(): void {
  if (props.message.acp) {
    agent.confirmAcpPlan(props.threadId, props.message);
  } else {
    chat.confirmPlan(props.threadId, props.message);
  }
}

function cancel(): void {
  chat.cancelPlan(props.threadId, props.message);
}
</script>

<template>
  <div data-testid="plan-card" class="flex flex-col gap-2.5 rounded-[14px] border border-line bg-panel-2 p-3">
    <div class="flex items-center justify-between gap-2">
      <span class="flex min-w-0 items-center gap-1.5 text-[12px] font-medium text-foreground">
        <Icon name="lightning" :size="13" class="shrink-0 text-dim" />
        {{ t("chatView.planTitle") }}
      </span>
      <span
        v-if="message.acp"
        data-testid="plan-target"
        class="flex h-5 shrink-0 items-center gap-1 rounded-full border border-line bg-panel px-2 text-[10.5px] text-dim"
      >
        <Icon name="robot" :size="10" />
        {{ t("chatView.planAcpTarget", { backend: message.acp }) }}
      </span>
    </div>

    <!-- mock：拟执行的步骤时间线 -->
    <ol v-if="message.steps?.length" data-testid="plan-steps" class="flex flex-col gap-1.5">
      <li v-for="step in message.steps" :key="step.label" class="flex items-start gap-2">
        <Icon :name="STEP_ICONS[step.kind]" :size="12" class="mt-[3px] shrink-0 text-dim2" />
        <div class="min-w-0">
          <div class="text-[12px] text-foreground">{{ step.label }}</div>
          <div v-if="step.detail" class="text-[11px] text-dim2">{{ step.detail }}</div>
        </div>
      </li>
    </ol>
    <!-- ACP：派发目标 + 意图草稿 -->
    <p
      v-else-if="message.acp && message.planDraft"
      data-testid="plan-draft"
      class="flex flex-col gap-1 rounded-[10px] border border-dashed border-line bg-panel px-2.5 py-2 text-[12px] leading-relaxed"
    >
      <span class="text-dim">{{ t("chatView.planAcpDispatch", { backend: message.acp }) }}</span>
      <span class="whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">{{ message.planDraft }}</span>
    </p>

    <div class="flex items-center justify-end gap-1.5">
      <button
        type="button"
        data-testid="plan-cancel"
        :disabled="busy"
        class="flex h-7 cursor-pointer items-center gap-1 rounded-[8px] border border-line bg-panel px-2.5 text-[11.5px] text-dim transition-colors hover:border-line-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:opacity-40"
        @click="cancel"
      >
        <Icon name="close-one" :size="11" />
        {{ t("chatView.cancelPlan") }}
      </button>
      <button
        type="button"
        data-testid="plan-confirm"
        :disabled="busy"
        class="flex h-7 cursor-pointer items-center gap-1 rounded-[8px] bg-accent px-3 text-[11.5px] font-medium text-accent-ink transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:opacity-40"
        @click="confirm"
      >
        <Icon name="check-one" :size="12" />
        {{ t("chatView.confirmRun") }}
      </button>
    </div>
  </div>
</template>
