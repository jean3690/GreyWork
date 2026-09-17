<script setup lang="ts">
/** 设置 · assistant 分区：远程助手通道面板 + 默认行为开关。 */
import { useI18n } from "vue-i18n";
import { useChatStore } from "@/stores/chat";
import { useSettingsStore } from "@/stores/settings";
import RemoteChannelsPane from "@/features/settings/RemoteChannelsPane.vue";

const { t } = useI18n();
const settings = useSettingsStore();
const chatStore = useChatStore();
</script>

<template>
  <div class="flex flex-col gap-4">
    <RemoteChannelsPane />
    <div class="mt-1 text-[11px] font-medium uppercase tracking-wide text-dim2">{{ t("remoteAssist.settings.defaults") }}</div>
    <div class="rounded-[14px] border border-line bg-panel p-4">
      <label class="flex cursor-pointer items-center justify-between gap-3">
        <span>
          <span class="block text-[13px] font-medium text-foreground">Plan 模式</span>
          <span class="block text-[11px] text-dim2">发送前先出计划，确认后再执行</span>
        </span>
        <input v-model="settings.planMode" type="checkbox" class="size-4 cursor-pointer accent-[var(--accent)]" :aria-label="'Plan 模式'" />
      </label>
    </div>
    <div class="rounded-[14px] border border-line bg-panel p-4">
      <label class="flex cursor-pointer items-center justify-between gap-3">
        <span>
          <span class="block text-[13px] font-medium text-foreground">速度加成</span>
          <span class="block text-[11px] text-dim2">加速 mock 管线响应（演示用）</span>
        </span>
        <input
          v-model="chatStore.speedBoost"
          type="checkbox"
          class="size-4 cursor-pointer accent-[var(--accent)]"
          :aria-label="'速度加成'"
        />
      </label>
    </div>
  </div>
</template>
