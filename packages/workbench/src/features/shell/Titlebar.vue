<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { isTauriRuntime } from "@greywork/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { useWorkspaceStore } from "@/stores/workspace";
import { usePreviewStore } from "@/stores/preview";
import { useWorkspacePanelStore } from "@/stores/workspacePanel";
import { useActivityStore } from "@/stores/activity";
import { hostOs } from "@/lib/host-platform";
import Icon from "@/features/shared/Icon.vue";
import Hint from "@/features/shared/Hint.vue";
import SearchPanel from "@/features/workspace/SearchPanel.vue";
import { Popover, PopoverTrigger } from "@/components/ui/popover";

/**
 * GreyWork 风格标题栏：侧栏开合 + 主导航 + 当前工作区指示 + 右上角窗口控制键。
 *
 * 窗口是无边框的（tauri.conf.json decorations: false），这条 header 就是标题栏本体。
 * 拖动与双击最大化由 tauri 注入的 drag.js 处理，认 `data-tauri-drag-region`；
 * 裸属性 = 只有直接点在 header 自身才拖动，按钮等子元素天然不触发。
 *
 * 四个窗口命令（start_dragging / minimize / toggle_maximize / close）都不在
 * core:default 里，必须在 src-tauri/capabilities 显式放行，否则被 ACL 拒绝，
 * 表现就是「窗口拖不动、按钮点了没反应」。
 */
const props = defineProps<{ collapsed: boolean }>();

const emit = defineEmits<{ toggleSider: []; navigate: [path: string] }>();

const workspaceStore = useWorkspaceStore();
const preview = usePreviewStore();
const workspace = useWorkspacePanelStore();
const activity = useActivityStore();

const activeWorkspace = computed(
  () => workspaceStore.workspaces.find((workspace) => workspace.id === workspaceStore.activeWorkspaceId) ?? null,
);

/** 浏览器态没有宿主窗口可控，整组控制键不渲染。 */
const hasWindowControls = isTauriRuntime();
/**
 * 是否 macOS。`hostOs` 未回来时按 false 走 —— 也就是 Windows/Linux 的既有布局。
 *
 * macOS 上窗口是 `decorations: false`（没有原生红绿灯），控件仍由本组件自绘，但按
 * 平台习惯放**左侧**且顺序相反（关闭在最左）；图标沿用现有单色字形，不另画红黄绿圆点。
 */
const onMac = computed(() => hostOs.value === "macos");
/** 快捷键提示：macOS 用 ⌘。按键处理（`onSearchShortcut`）本来就同时认 ctrl/meta。 */
const searchHint = computed(() => `搜索会话与功能（${onMac.value ? "⌘K" : "Ctrl+K"}）`);
const maximized = ref(false);
let unlistenResized: UnlistenFn | null = null;

/* ===== 标题栏搜索 =====
 * 按钮紧挨侧栏开合键（同为「全局入口」）。面板 Teleport 到 body —— 标题栏是
 * `relative z-30`，自成层叠上下文，就地渲染会被同为 z-40 的侧栏遮罩/悬浮层压住。 */
const searchOpen = ref(false);

/** Ctrl/Cmd+K：与按钮同一状态（鼠标开合由 PopoverTrigger 自己 toggle，键盘走这里）。 */
function toggleSearch(): void {
  searchOpen.value = !searchOpen.value;
}

/** Ctrl/Cmd+K：与按钮同一状态，键盘与鼠标走同一条路。 */
function onSearchShortcut(event: KeyboardEvent): void {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
  if (event.key.toLowerCase() !== "k") return;
  event.preventDefault();
  toggleSearch();
}

/** 三个控制键共用的形：46px 宽 · 吃满标题栏高 · 图标居中。 */
const controlButton =
  "grid w-[46px] cursor-pointer place-items-center text-dim transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-cyan";

async function syncMaximized(): Promise<void> {
  try {
    maximized.value = await getCurrentWindow().isMaximized();
  } catch (error: unknown) {
    console.error("[titlebar] 读取窗口最大化状态失败", error);
  }
}

function minimizeWindow(): void {
  getCurrentWindow()
    .minimize()
    .catch((error: unknown) => console.error("[titlebar] 最小化失败", error));
}

function toggleMaximizeWindow(): void {
  // 只发命令，maximized 由 tauri://resize 回灌：双击标题栏走的是同一条路，两边不会各记一份状态。
  getCurrentWindow()
    .toggleMaximize()
    .catch((error: unknown) => console.error("[titlebar] 最大化/还原失败", error));
}

function closeWindow(): void {
  getCurrentWindow()
    .close()
    .catch((error: unknown) => console.error("[titlebar] 关闭窗口失败", error));
}

/**
 * 三个窗口控制键的描述（Windows 顺序：最小化 → 最大化 → 关闭）。
 *
 * macOS 上整组放到左侧并把顺序反过来（关闭在最左），所以这里返回前先 reverse；
 * 按钮本身只有一份定义，避免两套 DOM 各写一遍导致 hover 色/测试 id 漂移。
 */
const windowControls = computed(() => {
  const controls = [
    {
      key: "minimize",
      label: "最小化",
      testid: "win-minimize",
      hover: "hover:bg-panel hover:text-foreground",
      icon: "minimize",
      run: minimizeWindow,
    },
    {
      key: "maximize",
      label: maximized.value ? "向下还原" : "最大化",
      testid: "win-maximize",
      hover: "hover:bg-panel hover:text-foreground",
      icon: maximized.value ? "restore" : "maximize",
      run: toggleMaximizeWindow,
    },
    {
      key: "close",
      label: "关闭",
      testid: "win-close",
      // 关闭键 hover 用 Windows 的 #c42b1e 而非主题色——这里的目的就是仿系统 chrome。
      hover: "hover:bg-[#c42b1e] hover:text-white",
      icon: "close",
      run: closeWindow,
    },
  ];
  return onMac.value ? [...controls].reverse() : controls;
});

onMounted(async () => {
  window.addEventListener("keydown", onSearchShortcut);
  if (!hasWindowControls) return;
  await syncMaximized();
  try {
    unlistenResized = await getCurrentWindow().onResized(() => void syncMaximized());
  } catch (error: unknown) {
    console.error("[titlebar] 监听窗口尺寸变化失败", error);
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onSearchShortcut);
  unlistenResized?.();
  unlistenResized = null;
});
</script>

<template>
  <header
    class="relative z-30 flex h-[42px] shrink-0 items-center gap-1 border-b border-line-2 bg-panel-2 px-2 select-none"
    data-tauri-drag-region
    data-testid="grey-titlebar"
  >
    <!-- 窗口控制键（仅桌面壳）。DOM 里放第一个，靠 `order-last` 决定视觉位置：
         macOS 留在左侧（平台习惯），其余平台甩到最右（仿 Windows chrome）。
         `-ml-2`/`-mr-2` 抵消 header 的 px-2 贴住对应边角；self-stretch 吃满标题栏高度。 -->
    <div
      v-if="hasWindowControls"
      class="flex self-stretch"
      :class="onMac ? '-ml-2 mr-1' : 'order-last -mr-2 ml-1'"
      data-testid="win-controls"
    >
      <button
        v-for="control in windowControls"
        :key="control.key"
        :class="[controlButton, control.hover]"
        :aria-label="control.label"
        :data-testid="control.testid"
        @click="control.run()"
      >
        <Icon :name="control.icon" :size="18" :stroke-width="2.6" />
      </button>
    </div>

    <button
      class="grid size-7 cursor-pointer place-items-center rounded-[6px] text-dim2 transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
      :aria-label="props.collapsed ? '展开侧栏' : '折叠侧栏'"
      @click="emit('toggleSider')"
    >
      <Icon :name="props.collapsed ? 'expand-right' : 'sidebar'" :size="16" />
    </button>

    <!-- 搜索：紧挨侧栏开合键。Popover 由本组件持有（触发器即这颗按钮），
         SearchPanel 只出 Content —— 层级、翻转夹紧、Esc、点外部关闭全交给 reka。 -->
    <Popover v-model:open="searchOpen">
      <Hint :text="searchHint">
        <PopoverTrigger as-child>
          <button
            class="grid size-7 cursor-pointer place-items-center rounded-[6px] text-dim2 transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
            aria-label="搜索"
            data-testid="titlebar-search"
          >
            <Icon name="search" :size="16" />
          </button>
        </PopoverTrigger>
      </Hint>
      <SearchPanel v-if="searchOpen" @close="searchOpen = false" />
    </Popover>

    <div class="ml-auto flex items-center gap-1.5 rounded-[6px] border border-line-2 bg-panel px-2 py-1 text-[12px] text-dim">
      <span class="size-1.5 rounded-full" :class="activeWorkspace ? 'bg-mint' : 'bg-dim2'" />
      <span class="max-w-[200px] truncate">{{ activeWorkspace?.name ?? "未绑定工作区" }}</span>
    </div>
    <!-- 右栏开关。左栏 toggle 走 emit 是因为其状态在 Shell 里；右栏状态在 store 里，
         再绕一层 emit 没有收益。
         显隐读 `preview.available`（Shell 按 768px 回灌），不用 Tailwind 断点自己判一次 ——
         两个阈值各写一处就会漂移，之前 `sm:`(640px) 与 Shell 的 768px 不一致，
         导致 640–768px 之间按钮可见但面板根本没渲染，点了没反应。 -->
    <button
      v-if="preview.available"
      class="grid size-7 cursor-pointer place-items-center rounded-[6px] text-dim2 transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
      :aria-label="preview.collapsed ? '展开预览面板' : '折叠预览面板'"
      data-testid="titlebar-preview-toggle"
      @click="preview.toggle()"
    >
      <Icon :name="preview.collapsed ? 'expand-left' : 'sidebar'" :size="16" />
    </button>

    <!-- 工作区栏开关（三栏 会话|预览|工作区 的最右栏）：近右栏开关，因为它是同一族
         「面板可见性」。默认折叠（回到旧单右栏布局），这里就是那个显式开关。
         图标固定用文件夹 —— 它就是文件工作区；开合状态靠 aria-label 与按钮显隐表达。
         显隐同样读 store 的 available（Shell 回灌），不另写断点。 -->
    <button
      v-if="workspace.available"
      class="grid size-7 cursor-pointer place-items-center rounded-[6px] text-dim2 transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
      :aria-label="workspace.collapsed ? '展开工作区面板' : '折叠工作区面板'"
      data-testid="titlebar-workspace-toggle"
      @click="workspace.toggle()"
    >
      <Icon name="folder" :size="16" />
    </button>

    <!-- 底部活动面板开关。可用性与预览同源（Shell 按 768px 回灌 activity.available），
         不再自己写断点；图标语义与预览开关一致：箭头指向面板运动方向 ——
         收起时展开是自底部升起（up），展开时收起是落回底部（down）。 -->
    <button
      v-if="activity.available"
      class="grid size-7 cursor-pointer place-items-center rounded-[6px] text-dim2 transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
      :aria-label="activity.open ? '收起活动面板' : '展开活动面板'"
      data-testid="titlebar-activity-toggle"
      @click="activity.toggle()"
    >
      <Icon :name="activity.open ? 'down' : 'up'" :size="16" />
    </button>
  </header>
</template>
