<script setup lang="ts">
/**
 * 侧栏「协作运行」区：把当前协作 run 作父节点、各成员位（slots）嵌在其下。
 *
 * Delta 的子代理嵌套：子线程不散落进历史列表，而是挂在父节点下。GreyWork 里每个成员位
 * 本就有独立会话（`slot.threadId`），这里只把它们从常规「工作区 → 会话」列表里摘出来，
 * 在 run 下重排一遍（去重由 Sider 计算 excludeSessionIds 完成，见 GroupedHistory 的 prop）。
 *
 * 「open as primary」在 GreyWork 已由现有导航满足：点成员位就是把它那条会话路由进主面板，
 * 与点普通会话行同义，故不引入新的「主面板」状态。
 *
 * run 只在内存里（cowork store 的 engine）：无 run 时整区零渲染；run 结束后 engine 仍在，
 * 节点与成员位照常可点（成员会话还在），直到下一次 startRun 替换掉它。
 */
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { i18n } from "@/i18n";
import Icon from "@/features/shared/Icon.vue";
import Hint from "@/features/shared/Hint.vue";
import { useChatStore } from "@/stores/chat";
import { useCoworkStore } from "@/stores/cowork";
import { useSessionStore } from "@/stores/session";

const t = i18n.global.t;
const route = useRoute();
const router = useRouter();
const cowork = useCoworkStore();
const sessionStore = useSessionStore();
const chat = useChatStore();

/** 成员位唤醒态的圆点色，与 CoworkPanel 的胶囊同源。 */
const wakeDot: Record<string, string> = {
  idle: "bg-line-2",
  running: "bg-amber",
  dirty: "bg-cyan",
};

const slots = computed(() => cowork.slots);

/** 当前打开的是哪条会话（用于把对应成员位行高亮）。 */
const activeThreadId = computed<string | null>(() => {
  const raw = route.params.conversationId;
  return (Array.isArray(raw) ? raw[0] : raw) ?? null;
});

function openConsole(): void {
  void router.push("/team");
}

/** 打开成员位会话：与 CoworkPanel 的 openSlot 同义（切激活 + 路由进主面板）。 */
function openSlot(threadId: string): void {
  sessionStore.setActive(threadId);
  chat.activeThreadId = threadId;
  void router.push(`/conversation/${threadId}`);
}
</script>

<template>
  <div v-if="slots.length" class="flex shrink-0 flex-col gap-0.5 px-2 pb-1" data-testid="cowork-sider">
    <div class="flex items-center gap-1 px-1 pt-1">
      <span class="text-[10.5px] font-medium tracking-wide text-dim2 uppercase">{{ t("cowork.title") }}</span>
    </div>

    <!-- run 父节点：点它回协作控制台（/team），状态胶囊说明这次 run 的进展 -->
    <button
      type="button"
      data-testid="cowork-sider-run"
      class="flex h-[34px] shrink-0 cursor-pointer items-center gap-1.5 rounded-[calc(8px*var(--gw-radius-scale))] px-2 text-left transition-colors hover:bg-panel focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
      :aria-label="t('cowork.sider.openConsole')"
      @click="openConsole"
    >
      <Icon name="peoples" :size="12" class="shrink-0 text-dim2" />
      <span class="min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground">{{ cowork.goal }}</span>
      <span v-if="cowork.status" class="shrink-0 rounded-full border border-line px-1.5 text-[10px] text-dim2">
        {{ t(`cowork.runStatus.${cowork.status}`) }}
      </span>
    </button>

    <!-- 成员位：嵌套在 run 之下，缩进对齐会话行的层级 -->
    <div class="flex flex-col" role="group" :aria-label="t('cowork.sider.slotsGroup')">
      <Hint v-for="slot in slots" :key="slot.id" :text="t(`cowork.wake.${slot.wake}`)" multiline>
        <button
          type="button"
          :data-testid="`cowork-sider-slot-${slot.id}`"
          class="ml-5 flex h-[30px] min-w-0 cursor-pointer items-center gap-1.5 rounded-[calc(8px*var(--gw-radius-scale))] px-2 pr-1.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
          :class="activeThreadId === slot.threadId ? 'bg-cyan/10 text-foreground' : 'text-dim hover:bg-panel hover:text-foreground'"
          :aria-current="activeThreadId === slot.threadId ? 'true' : undefined"
          :aria-label="t('cowork.sider.openSlot', { name: slot.name })"
          @click="openSlot(slot.threadId)"
        >
          <span class="size-1.5 shrink-0 rounded-full" :class="wakeDot[slot.wake]" aria-hidden="true" />
          <span class="min-w-0 flex-1 truncate text-[12px]">{{ slot.name }}</span>
          <span v-if="slot.unread > 0" class="shrink-0 rounded-full bg-cyan/15 px-1.5 text-[10px] text-cyan">{{ slot.unread }}</span>
          <span v-else-if="slot.status === 'failed'" class="shrink-0 text-[10px] text-destructive">!</span>
        </button>
      </Hint>
    </div>
  </div>
</template>
