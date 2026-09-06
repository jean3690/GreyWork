<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { i18n } from "../../i18n";
import { useAgentStore } from "../../stores/agent";
import Icon from "../Icon.vue";

/**
 * ACP 权限确认卡片：宿主发出 permission-request（cautious/非只读档的 Ask 裁决）
 * 后，在这里给用户逐条确认。宿主 120s 不答复即取消工具调用（acp_host.rs
 * PERMISSION_CONFIRM_TIMEOUT），store 镜像同一窗口：卡片显示倒计时，
 * 到时自行收卡并通知。
 */
const t = i18n.global.t;
const agent = useAgentStore();

const nowMs = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | null = null;
watch(
  () => agent.pendingPermission,
  (pending) => {
    if (pending && ticker === null) {
      ticker = setInterval(() => {
        nowMs.value = Date.now();
      }, 250);
    } else if (!pending && ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  if (ticker !== null) clearInterval(ticker);
});

const remainingLabel = computed(() => {
  const deadline = agent.permissionDeadline;
  if (deadline === null) return "—";
  const seconds = Math.max(0, Math.ceil((deadline - nowMs.value) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
});

const requestLabel = computed(() => agent.pendingPermission?.title ?? agent.pendingPermission?.kind ?? "");
</script>

<template>
  <div
    v-if="agent.pendingPermission"
    role="alertdialog"
    aria-modal="true"
    :aria-label="t('chatView.permission.title')"
    class="flex items-start gap-2.5 rounded-[14px] border border-line bg-popover p-3 shadow-lg"
    data-testid="permission-card"
  >
    <span class="grid size-8 shrink-0 place-items-center rounded-[9px] bg-amber/15 text-amber">
      <Icon name="shield" :size="15" />
    </span>
    <div class="min-w-0 flex-1">
      <p class="text-[13px] font-medium text-foreground">{{ t("chatView.permission.title") }}</p>
      <p class="mt-0.5 break-words text-[12px] leading-relaxed text-dim">{{ requestLabel }}</p>
      <p class="mt-1 text-[10.5px] text-dim2">{{ t("chatView.permission.hint", { s: remainingLabel }) }}</p>
      <div class="mt-2 flex flex-wrap items-center gap-1.5">
        <button
          v-for="option in agent.pendingPermission.options"
          :key="option.optionId"
          type="button"
          class="cursor-pointer rounded-[8px] bg-accent px-2.5 py-1 text-[11.5px] font-medium text-accent-ink transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
          @click="agent.respondPermission(option.optionId)"
        >
          {{ option.name }}
        </button>
        <button
          type="button"
          class="cursor-pointer rounded-[8px] border border-line bg-panel-2 px-2.5 py-1 text-[11.5px] text-dim transition-colors hover:border-line-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
          @click="agent.respondPermission(null)"
        >
          {{ t("chatView.permission.deny") }}
        </button>
      </div>
    </div>
  </div>
</template>
