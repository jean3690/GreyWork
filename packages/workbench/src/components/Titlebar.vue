<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { isTauriRuntime } from "@greywork/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { useWorkspaceStore } from "../stores/workspace";
import { usePreviewStore } from "../stores/preview";
import { useActivityStore } from "../stores/activity";
import Icon from "./Icon.vue";
import LayoutModeSwitch from "./LayoutModeSwitch.vue";

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
const activity = useActivityStore();

const activeWorkspace = computed(
  () => workspaceStore.workspaces.find((workspace) => workspace.id === workspaceStore.activeWorkspaceId) ?? null,
);

/** 浏览器态没有宿主窗口可控，整组控制键不渲染。 */
const hasWindowControls = isTauriRuntime();
const maximized = ref(false);
let unlistenResized: UnlistenFn | null = null;

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

onMounted(async () => {
  if (!hasWindowControls) return;
  await syncMaximized();
  try {
    unlistenResized = await getCurrentWindow().onResized(() => void syncMaximized());
  } catch (error: unknown) {
    console.error("[titlebar] 监听窗口尺寸变化失败", error);
  }
});

onBeforeUnmount(() => {
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
    <button
      class="grid size-7 cursor-pointer place-items-center rounded-[6px] text-dim2 transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
      :aria-label="props.collapsed ? '展开侧栏' : '折叠侧栏'"
      @click="emit('toggleSider')"
    >
      <Icon :name="props.collapsed ? 'expand-right' : 'sidebar'" :size="16" />
    </button>

    <!-- 布局模式：与上面的侧栏开关同属「面板可见性」这一族，所以排在它旁边而不是
         右侧的控制键堆里。窄屏不渲染 —— 四种模式里两种依赖右栏，而右栏此时不存在，
         给出按了也不生效的选项比不给更糟。 -->
    <LayoutModeSwitch v-if="preview.available" class="ml-1.5" />

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

    <!-- Windows 式控制键：-mr-2 抵消 header 的 px-2 贴住右上角，self-stretch 吃满标题栏高度。
         关闭键 hover 用 Windows 的 #c42b1e 而非主题色——这里的目的就是仿系统 chrome。 -->
    <div v-if="hasWindowControls" class="-mr-2 ml-1 flex self-stretch" data-testid="win-controls">
      <button
        :class="[controlButton, 'hover:bg-panel hover:text-foreground']"
        aria-label="最小化"
        data-testid="win-minimize"
        @click="minimizeWindow"
      >
        <Icon name="minimize" :size="18" :stroke-width="2.6" />
      </button>
      <button
        :class="[controlButton, 'hover:bg-panel hover:text-foreground']"
        :aria-label="maximized ? '向下还原' : '最大化'"
        data-testid="win-maximize"
        @click="toggleMaximizeWindow"
      >
        <Icon :name="maximized ? 'restore' : 'maximize'" :size="18" :stroke-width="2.6" />
      </button>
      <button
        :class="[controlButton, 'hover:bg-[#c42b1e] hover:text-white']"
        aria-label="关闭"
        data-testid="win-close"
        @click="closeWindow"
      >
        <Icon name="close" :size="18" :stroke-width="2.6" />
      </button>
    </div>
  </header>
</template>
