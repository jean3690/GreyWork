<script setup lang="ts">
/**
 * 右侧面板外壳：区段切换（文件 / 预览）+ 宽度 / 折叠 / 拖拽把手。
 *
 * 与左侧栏（`Sider.vue`）对称：**折叠即宽度归零并保持挂载**，靠 `overflow-hidden`
 * 兜住子元素。不卸载是关键 —— 卸载会让 CodeMirror / Univer 实例连同滚动位置一起丢，
 * 折叠再展开等于重新加载一遍。
 *
 * 拖拽把手贴在**左边缘**，所以 `useResizableSplit` 传 `reverse: true`（向左拖变宽）。
 * 把手是 12px 宽的透明热区，视觉上只有 2px 的线：热区太窄会变成「像素级瞄准游戏」。
 *
 * 区段切换是本地状态，但「有新的激活 tab」会自动跳到预览区 —— 与面板自动展开同一逻辑：
 * 用户或管线刚打开一个文件，就该看见它，而不是停在文件列表上。`artifact:updated`
 * 不改 activeId，所以后台就地更新不会把人从文件树里拽走。
 */
import { computed, ref, watch } from "vue";
import Icon from "../Icon.vue";
import FileTree from "./FileTree.vue";
import PreviewSurface from "./PreviewSurface.vue";
import WebFetchDialog from "./WebFetchDialog.vue";
import { DEFAULT_PREVIEW_PANEL_PX, MAX_PREVIEW_PANEL_PX, MIN_PREVIEW_PANEL_PX, PREVIEW_TAB_BAR_HEIGHT } from "../../lib/layout";
import { usePreviewBridge } from "../../lib/preview-bridge";
import { useResizableSplit } from "../../lib/resizable-split";
import { usePreviewStore } from "../../stores/preview";

type Section = "files" | "preview";

const preview = usePreviewStore();

// 事件订阅挂在组件作用域内，随卸载解绑（详见 preview-bridge.ts）。
usePreviewBridge();

const section = ref<Section>("preview");
const fetchDialogOpen = ref(false);

watch(
  () => preview.activeId,
  (id) => {
    if (id) section.value = "preview";
  },
);

const { dragging, onPointerDown } = useResizableSplit({
  width: () => preview.widthPx,
  onWidth: (px, commit) => preview.setWidth(px, commit),
  reverse: true,
});

const widthStyle = computed(() => ({ width: `${preview.effectiveWidthPx}px` }));

/** 双击把手复位到默认宽度：比「拖回大概位置」可靠，也是常见的分隔条约定。 */
function resetWidth(): void {
  preview.setWidth(DEFAULT_PREVIEW_PANEL_PX, true);
}

/** 键盘调宽：方向键 ±8px（Shift 步进 40），Home/End 到上下限。 */
function onResizeKeydown(event: KeyboardEvent): void {
  const step = event.shiftKey ? 40 : 8;
  let next: number | null = null;
  if (event.key === "ArrowLeft") next = preview.widthPx - step;
  else if (event.key === "ArrowRight") next = preview.widthPx + step;
  else if (event.key === "Home") next = MIN_PREVIEW_PANEL_PX;
  else if (event.key === "End") next = MAX_PREVIEW_PANEL_PX;
  if (next === null) return;
  event.preventDefault();
  preview.setWidth(next, true);
}

const sectionClass = (active: boolean): string =>
  [
    "h-6 shrink-0 cursor-pointer rounded-[6px] px-2 text-[11.5px] transition-colors",
    "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan",
    active ? "bg-panel text-foreground" : "text-dim hover:text-foreground",
  ].join(" ");
</script>

<template>
  <aside
    data-testid="preview-sider"
    class="relative flex shrink-0 flex-col overflow-hidden bg-panel-2 transition-[width] duration-150"
    :class="preview.collapsed ? 'border-l-0' : 'border-l border-line-2'"
    :style="widthStyle"
    :aria-hidden="preview.collapsed ? 'true' : undefined"
  >
    <!-- 拖拽把手：折叠时不渲染（没有可拖的宽度，留着只会挡住会话区右边缘的点击） -->
    <div
      v-if="!preview.collapsed"
      class="group absolute inset-y-0 left-0 z-20 flex w-3 cursor-col-resize items-center justify-start"
      data-testid="preview-resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整预览面板宽度"
      :aria-valuemin="MIN_PREVIEW_PANEL_PX"
      :aria-valuemax="MAX_PREVIEW_PANEL_PX"
      :aria-valuenow="preview.widthPx"
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

    <!-- 区段切换条 -->
    <div class="flex shrink-0 items-center gap-1 border-b border-line ps-4 pe-1" :style="{ height: `${PREVIEW_TAB_BAR_HEIGHT}px` }">
      <button
        type="button"
        data-testid="preview-section-files"
        :class="sectionClass(section === 'files')"
        :aria-current="section === 'files' ? 'true' : undefined"
        @click="section = 'files'"
      >
        文件
      </button>
      <button
        type="button"
        data-testid="preview-section-preview"
        :class="sectionClass(section === 'preview')"
        :aria-current="section === 'preview' ? 'true' : undefined"
        @click="section = 'preview'"
      >
        预览<span v-if="preview.tabs.length" class="ms-1 text-dim2">{{ preview.tabs.length }}</span>
      </button>

      <div class="ms-auto flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          data-testid="web-fetch-open"
          class="grid size-6 cursor-pointer place-items-center rounded-[6px] text-dim2 transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
          aria-label="抓取网页"
          @click="fetchDialogOpen = true"
        >
          <Icon name="earth" :size="13" />
        </button>
        <button
          v-if="section === 'preview' && preview.activeTab"
          type="button"
          data-testid="preview-reload"
          class="grid size-6 cursor-pointer place-items-center rounded-[6px] text-dim2 transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
          aria-label="重新加载当前预览"
          @click="preview.reload(preview.activeTab.path)"
        >
          <Icon name="refresh" :size="13" />
        </button>
        <button
          v-if="section === 'preview' && preview.tabs.length > 1"
          type="button"
          data-testid="preview-close-all"
          class="grid size-6 cursor-pointer place-items-center rounded-[6px] text-dim2 transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
          aria-label="关闭全部预览"
          @click="preview.closeAll()"
        >
          <Icon name="close-one" :size="13" />
        </button>
        <button
          type="button"
          data-testid="preview-collapse"
          class="grid size-6 cursor-pointer place-items-center rounded-[6px] text-dim2 transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
          aria-label="折叠预览面板"
          @click="preview.setCollapsed(true)"
        >
          <Icon name="expand-right" :size="13" />
        </button>
      </div>
    </div>

    <FileTree v-if="section === 'files'" class="min-h-0 flex-1" />

    <template v-else>
      <!-- tab 条：左侧 tab 溢出横向滚动 -->
      <div v-if="preview.tabs.length" class="flex h-7 shrink-0 items-center gap-1 overflow-x-auto border-b border-line ps-4 pe-1">
        <div
          v-for="tab in preview.tabs"
          :key="tab.id"
          data-testid="preview-tab"
          class="flex h-6 shrink-0 items-center gap-1 rounded-[6px] px-1.5 text-[11.5px] transition-colors"
          :class="tab.id === preview.activeId ? 'bg-panel text-foreground' : 'text-dim hover:text-foreground'"
        >
          <button
            type="button"
            class="max-w-[160px] cursor-pointer truncate focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
            :title="tab.path"
            :aria-label="`查看 ${tab.name}`"
            :aria-current="tab.id === preview.activeId ? 'true' : undefined"
            @click="preview.activate(tab.id)"
          >
            {{ tab.name }}
          </button>
          <button
            type="button"
            data-testid="preview-tab-close"
            class="grid size-4 cursor-pointer place-items-center rounded-[4px] text-dim2 transition-colors hover:bg-panel-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
            :aria-label="`关闭 ${tab.name}`"
            @click.stop="preview.close(tab.id)"
          >
            <Icon name="close" :size="10" />
          </button>
        </div>
      </div>

      <div class="min-h-0 flex-1 overflow-hidden">
        <PreviewSurface v-if="preview.activeTab" :tab="preview.activeTab" />
        <div v-else class="flex size-full flex-col items-center justify-center gap-1 px-4 text-center">
          <span class="text-[12px] text-dim2">暂无预览内容</span>
          <span class="text-[11px] text-dim2">从「文件」里点一个文件，或等产物生成后自动打开</span>
        </div>
      </div>
    </template>

    <WebFetchDialog v-if="fetchDialogOpen" @close="fetchDialogOpen = false" />
  </aside>
</template>
