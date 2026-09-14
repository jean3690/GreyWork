<script setup lang="ts">
/**
 * 关闭未保存表格前的确认。
 *
 * 只给「取消」与「放弃改动并关闭」两个出口，不做「保存并关闭」：未保存的 tab 可能是**非激活**的，
 * 它没有活着的编辑器实例可供调用保存（`PreviewSurface` 只挂载激活 tab），为它回到视图层要一个
 * 保存回调不划算。文案里说清「想留下就先取消」，用户自己就能走通那条路。
 */
defineProps<{ names: string[] }>();
const emit = defineEmits<{ close: []; confirm: [] }>();
</script>

<template>
  <div
    data-testid="unsaved-sheet-dialog"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    role="dialog"
    aria-modal="true"
    @click.self="emit('close')"
  >
    <div class="w-full max-w-[380px] rounded-[14px] border border-line bg-panel p-4 shadow-xl">
      <div class="text-[13px] font-medium text-foreground">有未保存的改动</div>
      <p class="mt-2 text-[12px] leading-relaxed text-dim">
        {{ names.join("、") }} 还有未保存的改动，关闭后这些改动会丢失。想留下请先取消，用该表格右上角的「保存」写回。
      </p>
      <div class="mt-4 flex justify-end gap-2">
        <button
          type="button"
          data-testid="unsaved-sheet-cancel"
          class="rounded-[8px] border border-line bg-panel-2 px-3 py-1.5 text-[12px] text-dim transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
          @click="emit('close')"
        >
          取消
        </button>
        <button
          type="button"
          data-testid="unsaved-sheet-confirm"
          class="rounded-[8px] bg-orange/15 px-3 py-1.5 text-[12px] font-medium text-orange transition-colors hover:bg-orange/25 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
          @click="emit('confirm')"
        >
          放弃改动并关闭
        </button>
      </div>
    </div>
  </div>
</template>
