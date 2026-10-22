<script setup lang="ts">
/**
 * 「手输路径」弹层：无原生文件夹选择器（自托管 Web / 浏览器）时的唯一入口。
 *
 * 由外壳全局挂载、由 `lib/path-prompt` 的 requestPathInput() 命令式调起 —— 调用方是
 * store / lib 里的普通函数（fileTree、workspace-bind 相关入口），拿不到组件上下文，
 * 所以这里读模块级的 pathPromptOpen，收口时调 settlePathInput()。
 *
 * 行为对齐系统对话框：Enter 确认、Esc / 取消返回 null、空白视为取消（按钮同时置灰）。
 * 路径原样交给调用方（不在这里补全 / 规范化），由服务端的授权账本决定能不能读。
 */
import { computed, nextTick, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { settlePathInput } from "@/lib/path-prompt";

const { t } = useI18n();
/** 消费者（外壳）用 v-if 挂载，存在即打开态；Esc 走 update:open 回到 cancel。 */
const open = ref(true);
const value = ref("");
const inputEl = ref<HTMLInputElement | null>(null);

/** 打开即聚焦并全选：绝大多数时候用户是粘贴一条路径进来。 */
onMounted(async () => {
  await nextTick();
  inputEl.value?.focus();
  inputEl.value?.select();
});

const trimmed = computed(() => value.value.trim());
const canConfirm = computed(() => trimmed.value.length > 0);

function confirm(): void {
  if (!canConfirm.value) return;
  settlePathInput(trimmed.value);
}

function cancel(): void {
  settlePathInput(null);
}

/** Esc / 点遮罩都走这里（reka-ui 的 Dialog 会把 open 置 false）。 */
function onOpenChange(next: boolean): void {
  if (!next) cancel();
}
</script>

<template>
  <Dialog v-model:open="open" @update:open="onOpenChange">
    <DialogContent
      :show-close-button="false"
      class="w-full max-w-[420px] gap-3 rounded-[calc(14px*var(--gw-radius-scale))] border border-line bg-panel p-4 shadow-xl sm:max-w-[420px]"
      data-testid="path-prompt-dialog"
    >
      <DialogTitle class="text-[13px] font-medium text-foreground">{{ t("pathPrompt.title") }}</DialogTitle>
      <DialogDescription class="text-[11.5px] leading-relaxed text-dim2">
        {{ t("pathPrompt.description") }}
      </DialogDescription>

      <input
        ref="inputEl"
        v-model="value"
        class="h-8 w-full rounded-[calc(8px*var(--gw-radius-scale))] border border-line bg-panel-2 px-2.5 font-mono text-[11.5px] text-foreground outline-none placeholder:text-dim2 focus:border-cyan/60"
        :placeholder="t('pathPrompt.placeholder')"
        :aria-label="t('pathPrompt.title')"
        data-testid="path-prompt-input"
        spellcheck="false"
        @keydown.enter.prevent="confirm"
      />

      <div class="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          class="h-auto rounded-[calc(8px*var(--gw-radius-scale))] border border-line bg-panel-2 px-3 py-1.5 text-[12px] font-normal text-dim shadow-none hover:bg-panel-2 hover:text-foreground"
          data-testid="path-prompt-cancel"
          @click="cancel"
        >
          {{ t("common.cancel") }}
        </Button>
        <Button
          type="button"
          :disabled="!canConfirm"
          class="h-auto rounded-[calc(8px*var(--gw-radius-scale))] bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-ink hover:bg-accent disabled:opacity-60"
          data-testid="path-prompt-confirm"
          @click="confirm"
        >
          {{ t("pathPrompt.confirm") }}
        </Button>
      </div>
    </DialogContent>
  </Dialog>
</template>
