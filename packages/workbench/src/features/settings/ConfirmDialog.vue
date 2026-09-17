<script setup lang="ts">
/**
 * 轻量确认弹层：设置页删除/卸载等破坏性动作前二步确认。
 *
 * 行为与结构走 shadcn-vue 的 AlertDialog —— Portal 到 body、焦点陷阱、打开时焦点落在
 * 「取消」上、关闭后焦点归还触发元素、body 滚动锁、role="alertdialog" 且 Title/Description
 * 与弹层关联。旧的手写实现这些一个都没有（只有 role="dialog" + aria-modal），
 * 且在 `overflow:hidden` 的祖先里会被裁切。
 *
 * 视觉仍是项目的紧凑规格（13/12px 字、14px 圆角、panel 底），不跟随 shadcn 默认的
 * text-lg / max-w-lg / p-6 —— 否则和旁边 7 个手写弹窗并排会很跳。
 *
 * 与旧实现的唯一行为差异：**点遮罩不再关闭**。alertdialog 的语义是必须显式选择，
 * reka-ui 在 AlertDialogContent 上 prevent 了 interact-outside。Esc 仍可取消，
 * 取消按钮也在，不会困住用户。
 */
import { ref } from "vue";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

defineProps<{
  title: string;
  message?: string;
  confirmLabel?: string;
  /** 操作进行中：禁用确认按钮防重复点击。 */
  busy?: boolean;
}>();

const emit = defineEmits<{ confirm: []; cancel: [] }>();

/**
 * 消费者用 `v-if` 挂载，所以本组件只要存在就是打开态；关闭由消费者在事件里卸载。
 * 用 v-model 而非静态 :open，是为了让关闭能走完整流程（退场动画、焦点归还）——
 * 静态 prop 的话 reka-ui 收不到父级更新，弹层会关不掉。
 */
const open = ref(true);

/**
 * 取消走 AlertDialogCancel 的 DialogClose → open=false → 这里发 cancel。
 * Esc 也是同一条路径（reka-ui 不拦 Esc），一并覆盖，不用单独监听键盘。
 *
 * 确认**故意不用 AlertDialogAction**：它同样是 DialogClose，而它的关闭发生在
 * 本组件 click 处理器之前，任何「先置标记再发事件」的写法都会漏出一个多余的 cancel，
 * 让消费者把目标清两遍。确认按钮因此只发事件、不自关闭 —— 这也正是旧实现的行为：
 * 关闭责任一直在消费者手上（它 `v-if` 的条件就是那份 target）。
 */
function onOpenChange(next: boolean): void {
  if (next) return;
  emit("cancel");
}
</script>

<template>
  <AlertDialog v-model:open="open" @update:open="onOpenChange">
    <AlertDialogContent
      class="max-h-[85vh] w-full max-w-[380px] gap-3 overflow-y-auto rounded-[14px] border border-line bg-panel p-4 shadow-xl sm:max-w-[380px]"
    >
      <AlertDialogHeader class="gap-0 text-left">
        <AlertDialogTitle class="text-[13px] font-medium text-foreground">{{ title }}</AlertDialogTitle>
        <AlertDialogDescription v-if="message" class="mt-1.5 text-[12px] leading-relaxed text-dim2">
          {{ message }}
        </AlertDialogDescription>
      </AlertDialogHeader>

      <slot></slot>

      <AlertDialogFooter class="mt-1 flex-row justify-end gap-2">
        <!--
          取消按钮的 dark: 三连不是冗余：AlertDialogCancel 内部是 buttonVariants({variant:'outline'})，
          那个变体带 dark:bg-input/30 dark:border-input dark:hover:bg-input/50。
          本项目的 dark 变体编译成 `.dark\:x:is([data-theme="dark"] *)`，特异性 (0,2,0) 高于
          不带变量的 `.bg-panel-2` (0,1,0) —— 所以只写 bg-panel-2/border-line 的话，
          暗色下会落回 --line-2 而不是 --panel-2。这里把暗色也钉到项目的次级面规格上。
        -->
        <AlertDialogCancel
          class="h-auto rounded-[8px] border border-line bg-panel-2 px-3 py-1.5 text-[12px] font-normal text-dim shadow-none transition-colors hover:bg-panel-2 hover:text-foreground dark:border-line dark:bg-panel-2 dark:hover:bg-panel-2"
        >
          取消
        </AlertDialogCancel>
        <Button
          type="button"
          :disabled="busy"
          class="h-auto rounded-[8px] bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-ink transition-opacity hover:bg-accent disabled:opacity-60"
          @click="emit('confirm')"
        >
          {{ confirmLabel ?? "确认" }}
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
