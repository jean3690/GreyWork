<script setup lang="ts">
/**
 * 划词浮层工具条。自己负责尺寸测量与定位（`anchor` 由 SelectionLayer 给）。
 *
 * 定位放在这里而不是父层，是因为「浮层多大」只有浮层自己知道，而父层拿不到它的 DOM
 * （根节点是 Teleport，组件 ref 给的是组件实例而非元素）。
 *
 * **必须 teleport 到 body**：预览面板的两层祖先（`PreviewSider` 的 aside 与内容区）
 * 都是 `overflow-hidden`，留在面板内的浮层会被裁掉。
 *
 * 只阻止 **mousedown** 的默认行为，**刻意不碰 pointerdown**：按 Pointer Events 规范，
 * 取消 pointerdown 会连带抑制兼容鼠标事件（mousedown / click），有可能让按钮点不动；
 * 而 mousedown 的默认行为才是「清空当前选区 + 转移焦点」，正是要拦的那个。
 * 即便某些引擎仍会折叠选区，SelectionLayer 的快照 + 按下期间抑制捕获也兜得住。
 *
 * 提示行用 `absolute` 挂在按钮行下方：绝对定位不参与父元素高度，所以测量到的
 * `offsetHeight` 就是按钮行本身的高度，提示的显隐不会影响定位。
 */
import { nextTick, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { placeToolbar, type AnchorRect, type ToolbarPlacement } from "@/lib/selection";
import type { SelectionAction } from "@/lib/selection-injection";

const props = defineProps<{ anchor: AnchorRect; available: boolean }>();
const emit = defineEmits<{ select: [action: SelectionAction] }>();

const { t } = useI18n();

const el = ref<HTMLElement | null>(null);
const placement = ref<ToolbarPlacement>({ left: 0, top: 0, flipped: false });
/** 量好之前先藏起来，否则会看到浮层从左上角跳到选区旁边。 */
const placed = ref(false);

/** 顺序即展示顺序：先问、再解释、最后改写。 */
const ACTIONS: readonly SelectionAction[] = ["ask", "explain", "rewrite"];

async function reposition(): Promise<void> {
  await nextTick();
  const element = el.value;
  if (!element) return;
  placement.value = placeToolbar(
    props.anchor,
    { width: window.innerWidth, height: window.innerHeight },
    { width: element.offsetWidth, height: element.offsetHeight },
  );
  placed.value = true;
}

onMounted(() => void reposition());
watch(
  () => props.anchor,
  () => void reposition(),
);
watch(
  () => props.available,
  () => void reposition(),
);

const actionClass = (available: boolean): string =>
  [
    "rounded-[6px] px-2 py-1 text-[11.5px] transition-colors",
    available
      ? "cursor-pointer text-foreground hover:bg-panel-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
      : "cursor-not-allowed text-dim2",
  ].join(" ");
</script>

<template>
  <Teleport to="body">
    <div
      ref="el"
      data-testid="selection-toolbar"
      role="toolbar"
      :aria-label="t('preview.selection.toolbarLabel')"
      class="fixed z-50 -translate-x-1/2"
      :style="{ left: `${placement.left}px`, top: `${placement.top}px`, visibility: placed ? 'visible' : 'hidden' }"
      @mousedown.prevent
    >
      <div class="flex items-center gap-0.5 rounded-[10px] border border-line bg-popover p-1 shadow-lg">
        <button
          v-for="action in ACTIONS"
          :key="action"
          type="button"
          :data-testid="`selection-action-${action}`"
          :disabled="!available"
          :class="actionClass(available)"
          @mousedown.prevent
          @click="emit('select', action)"
        >
          {{ t(`preview.selection.${action}`) }}
        </button>
      </div>

      <!-- 没有接收方时说清原因与出路，而不是让点击静默失效 -->
      <p
        v-if="!available"
        data-testid="selection-toolbar-disabled"
        class="absolute start-1/2 top-full mt-1 w-max -translate-x-1/2 rounded-[6px] border border-line bg-popover px-2 py-1 text-[10.5px] text-dim2 shadow-lg"
      >
        {{ t("preview.selection.disabledNoReceiver") }} · {{ t("preview.selection.disabledHint") }}
      </p>
    </div>
  </Teleport>
</template>
