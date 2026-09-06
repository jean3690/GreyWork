<script setup lang="ts">
import { i18n } from "../i18n";
import { useNoticeStore, type NoticeKind } from "../stores/notice";
import Icon from "./Icon.vue";

/**
 * 全局通知面的渲染宿主：挂在外壳顶层，读 notice store。
 *
 * 位置在标题栏之下的右上角，而不是右下角 —— 会话页右下角是发送按钮，
 * 常驻的错误卡片压在那里等于把主操作挡住。
 * 外层 `pointer-events-none`：通知不参与命中测试，只有卡片本体可点，
 * 所以一条没被关掉的错误不会变成一块吃掉点击的死区。
 */
const t = i18n.global.t;
const notices = useNoticeStore();

const ICON_BY_KIND: Record<NoticeKind, string> = {
  error: "close-one",
  warning: "shield",
  success: "check-one",
  info: "message",
};

/** 图标配色走语义令牌（--orange 危险 / --amber 警告 / --mint 成功），不用 raw palette。 */
const TONE_BY_KIND: Record<NoticeKind, string> = {
  error: "bg-orange/15 text-orange",
  warning: "bg-amber/15 text-amber",
  success: "bg-mint/15 text-mint",
  info: "bg-cyan/15 text-cyan",
};
</script>

<template>
  <div
    class="pointer-events-none fixed top-[52px] right-3 z-[90] flex w-[320px] max-w-[calc(100vw-24px)] flex-col gap-2"
    data-testid="notice-host"
  >
    <div
      v-for="notice in notices.list"
      :key="notice.id"
      class="pointer-events-auto rounded-[12px] border border-line bg-popover p-3 shadow-lg"
      :role="notice.kind === 'error' || notice.kind === 'warning' ? 'alert' : 'status'"
      :data-testid="`notice-${notice.kind}`"
    >
      <div class="flex items-start gap-2.5">
        <span class="grid size-7 shrink-0 place-items-center rounded-[8px]" :class="TONE_BY_KIND[notice.kind]">
          <Icon :name="ICON_BY_KIND[notice.kind]" :size="14" />
        </span>
        <div class="min-w-0 flex-1">
          <p class="text-[12.5px] leading-snug font-medium text-foreground">{{ notice.title }}</p>
          <p v-if="notice.detail" class="mt-0.5 line-clamp-3 text-[11px] leading-snug break-words text-dim2">{{ notice.detail }}</p>
          <button
            v-if="notice.action"
            type="button"
            class="mt-1.5 cursor-pointer rounded-[5px] text-[11px] text-cyan underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
            :data-testid="`notice-action-${notice.id}`"
            @click="
              notice.action.run();
              notices.dismiss(notice.id);
            "
          >
            {{ notice.action.label }}
          </button>
        </div>
        <button
          type="button"
          class="grid size-6 shrink-0 cursor-pointer place-items-center rounded-[6px] text-dim2 transition-colors hover:bg-panel-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
          :aria-label="t('notice.dismiss')"
          @click="notices.dismiss(notice.id)"
        >
          <Icon name="close" :size="12" />
        </button>
      </div>
    </div>
  </div>
</template>
