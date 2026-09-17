<script setup lang="ts">
/**
 * 定时任务确认卡（message.scheduleDraft 消息）：
 * AI 在回复末尾输出 ```schedule 围栏提议一个定时任务，这里渲染成确认卡——
 * 展示名称 / 指令 / 触发描述，用户确认才真正创建（automation store），
 * 取消则把提案从消息上摘掉。createdId 非空 = 已收口（只读态，回放不重复建）。
 *
 * 触发时刻不可信：AI 估的 onceAt/cron 可能是错的，精确调整引导去定时任务页，
 * 卡片不做行内编辑（保持小卡职责单一）。
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { describeCron } from "@/lib/cron";
import { useTurnActive } from "@/lib/turn-activity";
import { useAgentStore } from "@/stores/agent";
import { useAutomationStore } from "@/stores/automation";
import { useChatStore } from "@/stores/chat";
import { useWorkspaceStore } from "@/stores/workspace";
import Icon from "@/features/shared/Icon.vue";
import type { ThreadMessage } from "@/types";

const props = defineProps<{ threadId: string; message: ThreadMessage }>();

const { t } = useI18n();
const router = useRouter();
const agent = useAgentStore();
const automation = useAutomationStore();
const chat = useChatStore();
const workspaceStore = useWorkspaceStore();

const draft = computed(() => props.message.scheduleDraft);
const createdId = computed(() => draft.value?.createdId);
const settled = computed(() => Boolean(createdId.value));

/** 航次忙碌判定：与 AskQuestionCard 一致，运行中不让确认。 */
const busy = useTurnActive();

const triggerText = computed<string | null>(() => {
  if (!draft.value) return null;
  if (draft.value.cron) return describeCron(draft.value.cron) ?? draft.value.cron;
  if (draft.value.onceAt) {
    return t("chatView.scheduleCard.triggerOnce", {
      date: new Date(draft.value.onceAt).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }),
    });
  }
  return null;
});

function confirm(): void {
  const current = draft.value;
  if (!current || createdId.value || busy.value) return;
  const task = automation.add({
    name: current.name,
    intent: current.intent,
    cron: current.cron ?? null,
    onceAt: current.onceAt ?? null,
    enabled: true,
    lastRun: 0,
    running: false,
    // 跟随当前路由：ACP 会话里提议的任务带工具执行，Local 管线任务走本机模型
    acpProviderId: agent.routeToAcp ? agent.selectedProviderId : null,
    target:
      workspaceStore.workspaces.find((workspace) => workspace.id === workspaceStore.activeWorkspaceId)?.name ??
      t("automation.defaultTarget"),
  });
  // 走 chat store 落库（与 markAskAnswered 同一约定），不在组件里直接改 prop
  chat.markScheduleCreated(props.threadId, props.message, task.id);
}

function cancel(): void {
  if (!draft.value || settled.value || busy.value) return;
  chat.clearScheduleDraft(props.threadId, props.message);
}

function goScheduled(): void {
  void router.push("/scheduled");
}
</script>

<template>
  <div v-if="draft" data-testid="schedule-card" class="flex flex-col gap-2.5 rounded-[14px] border border-line bg-panel-2 p-3">
    <div class="flex items-center justify-between gap-2">
      <span class="flex min-w-0 items-center gap-1.5 text-[12px] font-medium text-foreground">
        <Icon name="clock" :size="13" class="shrink-0 text-cyan" />
        {{ t("chatView.scheduleCard.title") }}
      </span>
      <span
        v-if="settled"
        data-testid="schedule-created-badge"
        class="flex h-5 shrink-0 items-center gap-1 rounded-full bg-mint/10 px-2 text-[10.5px] text-mint"
      >
        <Icon name="check-one" :size="10" />
        {{ t("chatView.scheduleCard.created") }}
      </span>
    </div>

    <div class="flex flex-col gap-1.5">
      <div class="flex items-center gap-2">
        <span class="shrink-0 text-[11px] text-dim2">{{ draft.name }}</span>
        <span v-if="triggerText" class="shrink-0 rounded-full bg-panel px-2 text-[10.5px] text-cyan">{{ triggerText }}</span>
      </div>
      <p class="m-0 text-[12px] leading-relaxed text-dim [overflow-wrap:anywhere]">{{ draft.intent }}</p>
    </div>

    <!-- 已创建：给一个显式的「去定时任务页」入口（精确调整在那里做） -->
    <div v-if="settled" class="flex justify-end">
      <button
        type="button"
        data-testid="schedule-go-scheduled"
        class="flex h-7 cursor-pointer items-center gap-1.5 rounded-[8px] border border-line bg-panel px-2.5 text-[11.5px] text-dim transition-colors hover:border-line-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
        @click="goScheduled"
      >
        {{ t("chatView.scheduleCard.goScheduled") }}
        <Icon name="right" :size="11" />
      </button>
    </div>

    <!-- 待确认 -->
    <div v-else class="flex items-center justify-end gap-2">
      <span class="mr-auto text-[10.5px] text-dim2">{{ t("chatView.scheduleCard.hint") }}</span>
      <button
        type="button"
        data-testid="schedule-cancel"
        :disabled="busy"
        class="h-7 cursor-pointer rounded-[8px] border border-line bg-panel px-2.5 text-[11.5px] text-dim transition-colors hover:border-line-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        @click="cancel"
      >
        {{ t("chatView.scheduleCard.cancel") }}
      </button>
      <button
        type="button"
        data-testid="schedule-confirm"
        :disabled="busy"
        class="flex h-7 cursor-pointer items-center gap-1.5 rounded-[8px] bg-accent px-3 text-[11.5px] font-medium text-accent-ink transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:opacity-40"
        @click="confirm"
      >
        <Icon name="check" :size="12" />
        {{ t("chatView.scheduleCard.confirm") }}
      </button>
    </div>
  </div>
</template>
