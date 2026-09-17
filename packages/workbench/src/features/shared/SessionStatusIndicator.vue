<script setup lang="ts">
/**
 * 会话状态指示器：运行 = 青色转圈，等待中 = 琥珀点（呼吸），结束 = 薄荷点，
 * 未开始不画点（紧凑态）但始终输出 `data-status`，供侧栏与测试读取。
 *
 * 两种形态：紧凑（侧栏行内，仅标记）与胶囊（对话页头部，标记 + 文案）。
 */
import { computed } from "vue";
import { i18n } from "@/i18n";
import Hint from "@/features/shared/Hint.vue";
import type { SessionStatus } from "@/lib/session-status";

const props = withDefaults(defineProps<{ status: SessionStatus; chip?: boolean }>(), { chip: false });

/** 直接读全局 i18n：本组件挂在侧栏/头部，宿主链条不一定装了 vue-i18n 插件（同 PermissionCard）。 */
const t = i18n.global.t;
const label = computed(() => t(`sessionStatus.${props.status}`));

/** 圆点配色（运行态用转圈，不走这张表）。 */
const DOT: Record<SessionStatus, string> = {
  idle: "bg-dim2",
  running: "bg-cyan",
  waiting: "bg-amber animate-pulse",
  done: "bg-mint",
};

/** 胶囊文案配色。 */
const TEXT: Record<SessionStatus, string> = {
  idle: "text-dim2",
  running: "text-cyan",
  waiting: "text-amber",
  done: "text-mint",
};
</script>

<template>
  <span
    v-if="chip"
    data-testid="conversation-status"
    :data-status="status"
    class="flex h-5 shrink-0 items-center gap-1 rounded-full border border-line bg-panel-2 px-2 text-[10.5px]"
    :class="TEXT[status]"
  >
    <span v-if="status === 'running'" class="size-2.5 animate-spin rounded-full border border-cyan border-t-transparent" />
    <span v-else class="size-1.5 rounded-full" :class="DOT[status]" />
    {{ label }}
  </span>
  <!-- 纯圆点态：没有可见文字，提示是唯一的状态出口（原生 title 只认悬停，这里保留同等能力）。 -->
  <Hint v-else :text="label">
    <span data-testid="session-status" :data-status="status" class="grid size-3 shrink-0 place-items-center">
      <span v-if="status === 'running'" class="size-2.5 animate-spin rounded-full border border-cyan border-t-transparent" />
      <span v-else-if="status !== 'idle'" class="size-1.5 rounded-full" :class="DOT[status]" />
    </span>
  </Hint>
</template>
