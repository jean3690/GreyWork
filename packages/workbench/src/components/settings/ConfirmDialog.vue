<script setup lang="ts">
/** 轻量确认弹层：设置页删除/卸载等破坏性动作前二步确认（fixed overlay）。 */
defineProps<{
  title: string;
  message?: string;
  confirmLabel?: string;
  busy?: boolean;
}>();

const emit = defineEmits<{ confirm: []; cancel: [] }>();
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    role="dialog"
    aria-modal="true"
    @click.self="emit('cancel')"
  >
    <div class="w-full max-w-[380px] rounded-[14px] border border-line bg-panel p-4 shadow-xl">
      <div class="text-[13px] font-medium text-foreground">{{ title }}</div>
      <p v-if="message" class="mt-1.5 text-[12px] leading-relaxed text-dim2">{{ message }}</p>
      <slot></slot>
      <div class="mt-4 flex justify-end gap-2">
        <button
          type="button"
          class="rounded-[8px] border border-line bg-panel-2 px-3 py-1.5 text-[12px] text-dim transition-colors hover:text-foreground"
          @click="emit('cancel')"
        >
          取消
        </button>
        <button
          type="button"
          class="rounded-[8px] bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-ink transition-opacity disabled:opacity-60"
          :disabled="busy"
          @click="emit('confirm')"
        >
          {{ confirmLabel ?? "确认" }}
        </button>
      </div>
    </div>
  </div>
</template>
