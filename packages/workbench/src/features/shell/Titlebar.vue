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
import ContextMenuRegion from "@/features/shared/ContextMenuRegion.vue";
import SearchPanel from "@/features/workspace/SearchPanel.vue";
import { buildTitlebarItems, type ContextMenuItem } from "@/lib/context-menu";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { useI18n } from "vue-i18n";
import { updateBackend, REPO_URL } from "@/lib/update-backend";
import UpdateDialog from "@/features/shell/UpdateDialog.vue";

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
const props = defineProps<{
  collapsed: boolean;
  /**
   * 是否渲染标题栏里的侧栏开合键。桌面端**不**渲染：侧栏顶部的品牌键（SiderToolbar）
   * 已经在做同一件事，两颗并排只是重复。移动端收起时 Sider 整个不挂载（见 Shell 的
   * `v-if="!isMobile || !collapsed"`），标题栏这颗才是唯一入口 —— 由 Shell 按 isMobile 传进来，
   * 断点判断仍然只留在 Shell 一处。
   */
  showSiderToggle?: boolean;
}>();

const emit = defineEmits<{ toggleSider: []; navigate: [path: string]; newChat: []; openSettings: [] }>();

const workspaceStore = useWorkspaceStore();
const preview = usePreviewStore();
const workspace = useWorkspacePanelStore();
const activity = useActivityStore();
const { t } = useI18n();

/** 检查更新对话框；`v-if` 挂载 UpdateDialog，关闭即卸载（打开时才发起 GitHub 查询）。 */
const updateOpen = ref(false);

/** GitHub 图标：用系统浏览器打开本项目仓库（浏览器态回落新标签页）。 */
function openRepo(): void {
  void updateBackend.openExternal(REPO_URL);
}

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
const searchHint = computed(() => t("titlebar.searchHint", { key: onMac.value ? "⌘K" : "Ctrl+K" }));
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

/**
 * 其余图标按钮共用的皮肤（侧栏开合 / 搜索 / GitHub / 检查更新 / 三个面板开关）。
 * 此前 7 处各抄一遍同一串 class，改一次样式要改 7 个地方 —— 收在这里。
 * 窗口三键刻意不并进来：它仿系统 chrome，是吃满高度的方块，见上面的 controlButton。
 */
const iconButton =
  "grid size-7 shrink-0 cursor-pointer place-items-center rounded-[6px] text-dim2 transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan";

/** 组间竖分隔线：1px 宽，`self-center` + h-4 让它在 42px 高的标题栏里居中。 */
const groupDivider = "mx-1 h-4 w-px shrink-0 self-center bg-line-2";

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

/**
 * 标题栏右键菜单：面板显隐 + 全局入口。新建对话 / 打开设置的状态都在 Shell，
 * 这里只发意图（与侧栏 open-settings 同一套 emit 约定）。
 */
function buildMenu(): ContextMenuItem[] {
  return buildTitlebarItems(t, {
    toggleSidebar: () => emit("toggleSider"),
    togglePreview: () => preview.toggle(),
    toggleWorkspace: () => workspace.toggle(),
    toggleActivity: () => activity.toggle(),
    newChat: () => emit("newChat"),
    openSettings: () => emit("openSettings"),
    previewAvailable: preview.available,
    workspaceAvailable: workspace.available,
    activityAvailable: activity.available,
  });
}

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
  <ContextMenuRegion :build="buildMenu">
    <header
      class="relative z-30 flex h-[42px] shrink-0 items-center gap-1 border-b border-line-2 bg-panel-2 px-2 select-none"
      data-tauri-drag-region
      data-testid="grey-titlebar"
    >
      <!-- 窗口控制键（仅桌面壳）。DOM 里放第一个，靠 `order-last` 决定视觉位置：
         macOS 留在左侧（平台习惯），其余平台甩到最右（仿 Windows chrome）。
         组内那条竖线是隔离线：非 mac 排在三键左侧（隔开相邻的活动面板开关），
         mac 靠 `order-last` 排到三键右侧（隔开相邻的搜索键）—— 两种平台都把「关闭」
         从高频按钮旁拉开，降低误点概率。
         `-ml-2`/`-mr-2` 抵消 header 的 px-2 贴住对应边角；self-stretch 吃满标题栏高度。 -->
      <div
        v-if="hasWindowControls"
        class="flex self-stretch"
        :class="onMac ? '-ml-2 mr-1' : 'order-last -mr-2 ml-1'"
        data-testid="win-controls"
      >
        <span :class="[groupDivider, onMac ? 'order-last' : '']" data-testid="win-controls-divider" aria-hidden="true" />
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

      <!-- 全局入口区（左）：侧栏开合（仅移动端，见 showSiderToggle）/ 搜索 / GitHub / 检查更新。
         四者都只是「打开一个入口」，不改变窗口内布局；右侧那组才是改布局的面板开关。 -->
      <button
        v-if="props.showSiderToggle"
        :class="iconButton"
        :aria-label="props.collapsed ? t('titlebar.expandSidebar') : t('titlebar.collapseSidebar')"
        data-testid="titlebar-sider-toggle"
        @click="emit('toggleSider')"
      >
        <Icon :name="props.collapsed ? 'expand-right' : 'sidebar'" :size="16" />
      </button>

      <!-- 搜索：Popover 由本组件持有（触发器即这颗按钮），SearchPanel 只出 Content ——
         层级、翻转夹紧、Esc、点外部关闭全交给 reka。 -->
      <Popover v-model:open="searchOpen">
        <Hint :text="searchHint">
          <PopoverTrigger as-child>
            <button :class="iconButton" :aria-label="t('titlebar.search')" data-testid="titlebar-search">
              <Icon name="search" :size="16" />
            </button>
          </PopoverTrigger>
        </Hint>
        <SearchPanel v-if="searchOpen" @close="searchOpen = false" />
      </Popover>

      <!-- GitHub 仓库：官方 mark 需要填充，故不走描边式的 Icon 组件，内联 SVG（fill=currentColor）。 -->
      <Hint :text="t('titlebar.github')">
        <button :class="iconButton" :aria-label="t('titlebar.github')" data-testid="titlebar-github" @click="openRepo">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
            <path
              d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"
            />
          </svg>
        </button>
      </Hint>

      <!-- 检查更新：refresh 图标语义即「查一遍」。点击打开对话框（打开时才发起 GitHub 查询）。 -->
      <Hint :text="t('titlebar.update')">
        <button :class="iconButton" :aria-label="t('titlebar.update')" data-testid="titlebar-update" @click="updateOpen = true">
          <Icon name="refresh" :size="16" />
        </button>
      </Hint>

      <UpdateDialog v-if="updateOpen" @close="updateOpen = false" />

      <!-- 状态区：ml-auto 把它连同后面的面板开关一起推到右侧。
         pill 自带边框，与相邻的面板开关组天然分得开，不再另加分隔线。 -->
      <div class="ml-auto flex items-center gap-1.5 rounded-[6px] border border-line-2 bg-panel px-2 py-1 text-[12px] text-dim">
        <span class="size-1.5 rounded-full" :class="activeWorkspace ? 'bg-mint' : 'bg-dim2'" />
        <span class="max-w-[200px] truncate">{{ activeWorkspace?.name ?? t("titlebar.noWorkspace") }}</span>
      </div>

      <!-- 面板开关组：三个开关都改窗口内布局，单独成组（组内 gap-0.5 比 header 的 gap-1 更紧，
         一眼看出是一簇）。三个的显隐都读各自 store 的 available（Shell 按 768px 回灌），
         不在这里另写断点 —— 两个阈值各写一处就会漂移，之前 `sm:`(640px) 与 Shell 的 768px
         不一致，导致 640–768px 之间按钮可见但面板根本没渲染，点了没反应。

         预览开关：状态在 store 里，不绕 emit。
         工作区开关：三栏 会话|预览|工作区 的最右栏，默认折叠（回到旧单右栏布局）；
           图标固定用文件夹 —— 它就是文件工作区，开合状态靠 aria-label 表达。
         活动开关：底部活动带。图标语义与预览开关一致：箭头指向面板运动方向 ——
           收起时展开是自底部升起（up），展开时收起是落回底部（down）。 -->
      <div class="ml-1 flex items-center gap-0.5" data-testid="titlebar-panels">
        <button
          v-if="preview.available"
          :class="iconButton"
          :aria-label="preview.collapsed ? t('titlebar.expandPreview') : t('titlebar.collapsePreview')"
          data-testid="titlebar-preview-toggle"
          @click="preview.toggle()"
        >
          <Icon :name="preview.collapsed ? 'expand-left' : 'sidebar'" :size="16" />
        </button>

        <button
          v-if="workspace.available"
          :class="iconButton"
          :aria-label="workspace.collapsed ? t('titlebar.expandWorkspace') : t('titlebar.collapseWorkspace')"
          data-testid="titlebar-workspace-toggle"
          @click="workspace.toggle()"
        >
          <Icon name="folder" :size="16" />
        </button>

        <button
          v-if="activity.available"
          :class="iconButton"
          :aria-label="activity.open ? t('titlebar.collapseActivity') : t('titlebar.expandActivity')"
          data-testid="titlebar-activity-toggle"
          @click="activity.toggle()"
        >
          <Icon :name="activity.open ? 'down' : 'up'" :size="16" />
        </button>
      </div>
    </header>
  </ContextMenuRegion>
</template>
