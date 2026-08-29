<script setup lang="ts">
import { DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogRoot, type DialogRootProps } from "reka-ui";
import { computed, type HTMLAttributes } from "vue";
import { X } from "lucide-vue-next";
import { cn } from "../../lib/utils";

defineOptions({ inheritAttrs: false });

const props = defineProps<{
  open?: DialogRootProps["open"];
  defaultOpen?: DialogRootProps["defaultOpen"];
  contentClass?: HTMLAttributes["class"];
}>();

const emit = defineEmits<{
  (event: "update:open", value: boolean): void;
}>();

/** 受控 open 需随父级 :open 更新：静态对象在 setup 捕获旧值，对话框永不打开。 */
const rootProps = computed(() => ({ open: props.open, defaultOpen: props.defaultOpen }));

function onOpenChange(value: boolean): void {
  emit("update:open", value);
}

function onInteractOutside(event: Event): void {
  event.preventDefault();
}
</script>

<template>
  <DialogRoot v-bind="rootProps" @update:open="onOpenChange">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-black/30 backdrop-blur-[2px] data-[state=open]:animate-in" />
      <DialogContent
        v-bind="$attrs"
        :class="
          cn(
            'fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-card p-5 shadow-[0_24px_60px_rgba(17,17,20,0.18)] focus:outline-none',
            props.contentClass,
          )
        "
        @interact-outside="onInteractOutside"
      >
        <slot />
        <DialogClose
          class="absolute right-4 top-4 rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-none"
        >
          <X class="size-4" />
        </DialogClose>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
