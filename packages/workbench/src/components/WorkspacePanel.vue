<script setup lang="ts">
/**
 * 工作区栏：三栏（会话 | 预览 | 工作区）的**最右栏**，文件树面板。
 *
 * 位置沿自 AionUI 的 Conversation Shell：预览紧挨会话（看产物的心智最近），工作区在预览
 * 右侧放文件。内容直接复用右栏的文件树（同一份 FileTree，点击文件同样是开预览 tab）。
 *
 * 与右栏的「文件」区段功能重叠是有意的：三栏是可选能力，面板**默认折叠**（回到旧的
 * 会话 | 右栏布局），需要的人用标题栏按钮 / Ctrl+E 展开。折叠即宽度归零并保持挂载，
 * 靠 overflow-hidden 兜住子树；重挂一棵树代价高得多。
 *
 * 拖拽把手贴在**左边缘**（面向预览），`useResizableSplit` 传 `reverse: true`（向左拖变宽）。
 */
import { computed } from "vue";
import Icon from "./Icon.vue";
import FileTree from "./preview/FileTree.vue";
import { DEFAULT_WORKSPACE_PANEL_PX, MAX_WORKSPACE_PANEL_PX, MIN_WORKSPACE_PANEL_PX, PREVIEW_TAB_BAR_HEIGHT } from "../lib/layout";
import { useResizableSplit } from "../lib/resizable-split";
import { useWorkspacePanelStore } from "../stores/workspacePanel";

const workspace = useWorkspacePanelStore();

const { dragging, onPointerDown } = useResizableSplit({
  width: () => workspace.widthPx,
  onWidth: (px, commit) => workspace.setWidth(px, commit),
  reverse: true,
});

const widthStyle = computed(() => ({ width: `${workspace.effectiveWidthPx}px` }));

/** 双击把手复位到默认宽度。 */
function resetWidth(): void {
  workspace.setWidth(DEFAULT_WORKSPACE_PANEL_PX, true);
}

/** 键盘调宽：方向键 ±8px（Shift 步进 40），Home/End 到上下限。 */
function onResizeKeydown(event: KeyboardEvent): void {
  const step = event.shiftKey ? 40 : 8;
  let next: number | null = null;
  if (event.key === "ArrowLeft") next = workspace.widthPx - step;
  else if (event.key === "ArrowRight") next = workspace.widthPx + step;
  else if (event.key === "Home") next = MIN_WORKSPACE_PANEL_PX;
  else if (event.key === "End") next = MAX_WORKSPACE_PANEL_PX;
  if (next === null) return;
  event.preventDefault();
  workspace.setWidth(next, true);
}
</script>

<template>
  <aside
    data-testid="workspace-panel"
    class="relative flex shrink-0 flex-col overflow-hidden bg-panel-2 transition-[width] duration-150"
    :class="workspace.collapsed ? 'border-x-0' : 'border-l border-line-2'"
    :style="widthStyle"
    :aria-hidden="workspace.collapsed ? 'true' : undefined"
  >
    <!-- 拖拽把手：折叠时不渲染（没有可拖的宽度，留着只会挡住会话区右边缘的点击） -->
    <div
      v-if="!workspace.collapsed"
      class="group absolute inset-y-0 left-0 z-20 flex w-3 cursor-col-resize items-center justify-start"
      data-testid="workspace-resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整工作区面板宽度"
      :aria-valuemin="MIN_WORKSPACE_PANEL_PX"
      :aria-valuemax="MAX_WORKSPACE_PANEL_PX"
      :aria-valuenow="workspace.widthPx"
      tabindex="0"
      @keydown="onResizeKeydown"
      @pointerdown="onPointerDown"
      @dblclick="resetWidth"
    >
      <span
        class="pointer-events-none block h-full w-0.5 rounded-full transition-all duration-150"
        :class="dragging ? 'w-1 bg-cyan' : 'bg-line-2 group-hover:w-1 group-hover:bg-cyan'"
      />
    </div>

    <!-- 面板标题条：与右栏的 tab 条同高，横向对齐 -->
    <div class="flex shrink-0 items-center gap-1 border-b border-line ps-4 pe-1" :style="{ height: `${PREVIEW_TAB_BAR_HEIGHT}px` }">
      <span class="min-w-0 flex-1 truncate text-[11.5px] text-dim">工作区</span>
      <button
        type="button"
        data-testid="workspace-collapse"
        class="grid size-6 cursor-pointer place-items-center rounded-[6px] text-dim2 transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
        aria-label="折叠工作区面板"
        @click="workspace.setCollapsed(true)"
      >
        <Icon name="expand-right" :size="13" />
      </button>
    </div>

    <FileTree class="min-h-0 flex-1" />
  </aside>
</template>
