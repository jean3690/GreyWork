<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import "./theme/shadcn.css";
import "./theme/tokens.css";
import "./theme/base.css";
import { useSessionStore } from "./stores/session";
import { useSettingsStore } from "./stores/settings";
import { useWorkspaceStore } from "./stores/workspace";
import { usePreviewStore } from "./stores/preview";
import { useWorkspacePanelStore } from "./stores/workspacePanel";
import { useActivityStore } from "./stores/activity";
import { useLayoutStore } from "./stores/layout";
import { useRemoteAssistantStore } from "./stores/remote-assistant";
import { appEvents } from "./events";
import { applyAppearance as applyAppearanceToDom } from "./lib/theme";
import { modeOfShortcut, visibilityOf, type LayoutMode } from "./lib/layout-modes";
import { bootPlugins } from "./plugins/runtime";
import Sider from "./components/Sider.vue";
import SettingsDialog from "./components/SettingsDialog.vue";
import PreviewSider from "./components/preview/PreviewSider.vue";
import WorkspacePanel from "./components/WorkspacePanel.vue";
import Titlebar from "./components/Titlebar.vue";
import NoticeHost from "./components/NoticeHost.vue";
import ActivityBand from "./components/activity/ActivityBand.vue";
import WorkspaceOverlayRegions from "./components/WorkspaceOverlayRegions.vue";

/**
 * GreyWork 风格外壳：标题栏 + 左侧栏 + 内容区（router-view）+ 右侧预览面板。
 *
 * 主题配色、明暗模式和字号独立持久化。DOM 约定（由 lib/theme 的 applyAppearance 落地）：
 * - data-palette：greywork / night-blue / night-green / github / fox；
 * - data-theme：实际生效的 light / dark（system 在这里解析，供 CSS 与后挂载的组件判断）；
 * - data-font-size：small / medium / large。
 *
 * 外观变化经 window 上的 APPEARANCE_EVENT 广播，消费方（Mermaid / Univer / 侧栏开关）
 * 订阅事件而不是盯 DOM。
 */
const settings = useSettingsStore();
const route = useRoute();
const router = useRouter();
/** 裸路由（悬浮窗 #/plugin-window）：不渲染标题栏/侧栏等外壳 chrome。 */
const bareWindow = computed(() => route.meta.bare === true);
const sessionStore = useSessionStore();
const workspaceStore = useWorkspaceStore();
const preview = usePreviewStore();
const workspace = useWorkspacePanelStore();
const activity = useActivityStore();
const layout = useLayoutStore();

const darkMedia =
  typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
const systemDark = ref(darkMedia?.matches ?? false);
const resolvedTheme = computed<"light" | "dark">(() =>
  settings.colorMode === "system" ? (systemDark.value ? "dark" : "light") : settings.colorMode,
);

// 这里盯 resolvedTheme 而不是 settings.colorMode：跟随系统时系统翻了、colorMode 没变，
// 只有 resolvedTheme 会动，而它是这次重算外观的唯一触发点。
watch(
  [() => settings.theme, resolvedTheme, () => settings.fontSize],
  ([palette, theme, fontSize]) => applyAppearanceToDom({ palette, colorMode: theme, fontSize }),
  { immediate: true },
);

const MOBILE_BREAKPOINT = 768;
const isMobile = ref(false);

/**
 * 左侧栏折叠态 = **有效态**，初值取自持久化偏好。
 *
 * 有效态与偏好必须分开：窄屏下左栏是抽屉，开关都是瞬态的，写回偏好会让用户
 * 在窄屏开一次抽屉就把桌面的偏好改掉。所以只有桌面下才回写（见下面的 watch）。
 */
const collapsed = ref(layout.sidebarCollapsed);

watch(collapsed, (value) => {
  if (!isMobile.value) layout.sidebarCollapsed = value;
});

// 偏好也可能被别的入口改（标题栏的布局指示器会同时拨两个面板），要回灌到有效态。
// 两个 watch 都被 isMobile 挡住、且同值不会重复触发，所以不会互相追着跑。
watch(
  () => layout.sidebarCollapsed,
  (value) => {
    if (!isMobile.value) collapsed.value = value;
  },
);

/** 把两个面板一起拨到目标布局；桌面下上面的 watch 会把左栏结果持久化。 */
function applyLayoutMode(next: LayoutMode): void {
  const target = visibilityOf(next);
  collapsed.value = !target.sidebar;
  // 窄屏不渲染右栏，别去展开一个不存在的东西
  if (preview.available) preview.setCollapsed(!target.preview);
}

function syncViewport(): void {
  if (typeof window === "undefined") return;
  const mobile = window.innerWidth < MOBILE_BREAKPOINT;
  isMobile.value = mobile;
  // 窄屏默认收起，让内容区拿满宽度；用户手动展开后交给 toggle 决定。
  // 从窄屏回到桌面时恢复偏好 —— 否则「我收起了左栏」这个偏好只在重启后才生效。
  collapsed.value = mobile ? true : layout.sidebarCollapsed;
  // 右栏在窄屏不渲染。这个判断只在这里做一次，Titlebar 的开关按钮读同一个 store 字段，
  // 不再各自写一个断点（那正是 640–768px 之间「按钮可见但面板不存在」的来源）。
  preview.setAvailable(!mobile);
  workspace.setAvailable(!mobile);
  // 底部活动面板与右栏同源同断点：产物点开进右栏预览，窄屏两条都没意义。
  activity.setAvailable(!mobile);
}

/**
 * 全局快捷键与抽屉的键盘退路。
 *
 * - Ctrl/Cmd+N 新对话 · Ctrl/Cmd+B 折叠/展开侧栏 · Ctrl/Cmd+E 工作区栏 · Ctrl/Cmd+\ 预览面板。
 * - Ctrl/Cmd+1~4 布局模式（三栏 / 对话 / 文档 / 专注）—— 只是把上面两个开关一起拨到位，
 *   所以不存在「模式与面板状态不一致」的可能。按 event.code 匹配，见 lib/layout-modes.ts。
 *   集中注册在这一个函数里：以后要上命令面板时，把这些 key 挪进面板注册表即可。
 * - Escape 关抽屉：遮罩是 aria-hidden 的装饰层，点它收起对鼠标够用，对键盘不够；
 *   挂在 window 上是因为抽屉打开时焦点可能在侧栏内的任意按钮上，
 *   挂在遮罩元素上的处理器永远收不到那个 keydown。
 */
function onWindowKeydown(event: KeyboardEvent): void {
  const mod = event.ctrlKey || event.metaKey;
  if (mod && !event.altKey && !event.shiftKey) {
    const key = event.key.toLowerCase();
    if (key === "n") {
      event.preventDefault();
      handleNewChat();
      return;
    }
    if (key === "b") {
      event.preventDefault();
      collapsed.value = !collapsed.value;
      return;
    }
    if (key === "e") {
      event.preventDefault();
      if (workspace.available) workspace.toggle();
      return;
    }
    if (key === "\\") {
      event.preventDefault();
      if (preview.available) preview.toggle();
      return;
    }
    const layoutMode: LayoutMode | null = modeOfShortcut(event.code);
    if (layoutMode) {
      event.preventDefault();
      applyLayoutMode(layoutMode);
      return;
    }
  }
  if (event.key !== "Escape") return;
  if (!isMobile.value || collapsed.value) return;
  collapsed.value = true;
}

/**
 * [会话区 + 工作区栏 + 右栏] 这一行的实测宽度回灌给两个面板 store，用于把面板宽度收进
 * 「不挤破会话区」的范围。用这一行而不是整个窗口：左栏宽度会变（折叠/拖拽），
 * 拿窗口宽度算会在左栏展开时高估可用空间。
 */
const mainRow = ref<HTMLElement | null>(null);
let rowObserver: ResizeObserver | null = null;

/**
 * 伙伴预留转发：每个面板的 clamp 都要按「另一个面板现在的偏好宽」来留空间。
 * 面板之间不直接互读 store（setup 时会形成实例依赖），统一经 Shell 单向转发。
 * 只按偏好宽（非实测）转发 —— 偏好不依赖容器，不会形成循环。
 */
function syncReserves(): void {
  preview.setReserved(workspace.collapsed ? 0 : workspace.widthPx);
  workspace.setReserved(preview.collapsed ? 0 : preview.widthPx);
}

function observeMainRow(): void {
  // happy-dom 等环境没有 ResizeObserver：跳过即可，宽度约束退化为只按 MIN/MAX 收敛。
  if (typeof ResizeObserver === "undefined" || !mainRow.value) return;
  rowObserver = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect.width;
    if (typeof width !== "number") return;
    syncReserves();
    preview.setAvailableWidth(width);
    workspace.setAvailableWidth(width);
  });
  rowObserver.observe(mainRow.value);
}

// 折叠态或宽度偏好变了 → 预留立刻重算（不用等下一次测宽），生效宽度随之收敛。
watch([() => workspace.collapsed, () => workspace.widthPx, () => preview.collapsed, () => preview.widthPx], () => syncReserves());

onMounted(() => {
  syncViewport();
  window.addEventListener("resize", syncViewport);
  window.addEventListener("keydown", onWindowKeydown);
  darkMedia?.addEventListener("change", syncSystemTheme);
  observeMainRow();
  // 微内核接线：注册内置插件清单并激活（幂等，见 plugins/runtime）。
  void bootPlugins();
  // 远程助手：注册通道事件、按设置自动连接（幂等；浏览器态内部直接跳过）。
  void useRemoteAssistantStore().init();
});
function syncSystemTheme(event: MediaQueryListEvent): void {
  systemDark.value = event.matches;
}
onBeforeUnmount(() => {
  if (typeof window !== "undefined") {
    window.removeEventListener("resize", syncViewport);
    window.removeEventListener("keydown", onWindowKeydown);
  }
  darkMedia?.removeEventListener("change", syncSystemTheme);
  rowObserver?.disconnect();
  rowObserver = null;
  unsubscribeSettingsOpen();
});

/**
 * 设置弹窗状态落在 Shell：它是「调完即走」的瞬时 UI，不进路由（详见 SettingsDialog）。
 * section 在会话内记住上次打开的分区——用户多半是在同一处反复调，不必每次从 Agent 页翻。
 */
const settingsOpen = ref(false);
const settingsSection = ref("agent");

function openSettings(): void {
  settingsOpen.value = true;
}

/**
 * 「去设置配置」入口（远程助手页等）经事件总线请求打开指定分区。
 * 订阅挂在 Shell：设置弹窗的状态归它持有，别处只发意图。
 */
const unsubscribeSettingsOpen = appEvents.on("settings:open", (payload) => {
  if (payload.section) settingsSection.value = payload.section;
  settingsOpen.value = true;
});

function navigate(path: string): void {
  void router.push(path);
  if (isMobile.value) collapsed.value = true;
}

function handleNewChat(): void {
  const session = sessionStore.createSession(workspaceStore.activeWorkspaceId);
  navigate(`/conversation/${session.id}`);
}
</script>

<template>
  <!-- 裸窗口（悬浮宠物等）：只有 router-view，无外壳 chrome。 -->
  <router-view v-if="bareWindow" />
  <div v-else class="flex size-full min-h-0 flex-col overflow-hidden bg-background" data-testid="shell">
    <Titlebar :collapsed="collapsed" @toggle-sider="collapsed = !collapsed" @navigate="navigate" />
    <div class="relative flex min-h-0 flex-1 overflow-hidden">
      <!-- 移动端展开的侧栏是抽屉：遮罩点击收起，侧栏悬浮于内容之上而非挤占宽度 -->
      <div v-if="isMobile && !collapsed" class="absolute inset-0 z-30 bg-black/30" aria-hidden="true" @click="collapsed = true" />
      <Sider
        v-if="!isMobile || !collapsed"
        :collapsed="collapsed"
        :overlay="isMobile"
        @toggle-sider="collapsed = !collapsed"
        @new-chat="handleNewChat"
        @navigate="navigate"
        @open-settings="openSettings"
      />
      <!-- [内容区 + 预览 + 工作区] 组成一列：上行为被观测的 mainRow（宽度是两个面板 clamp 的依据）。
           顺序 = 会话 | 预览 | 工作区：预览紧挨会话（看产物的心智最近），工作区（文件树）在最右。
           工作区栏默认折叠（回旧单右栏布局），展开与否由 workspace store 的持久化开关决定。
           下行为底部活动面板通栏（ActivityBand 内部自管高度/折叠）。 -->
      <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div ref="mainRow" class="flex min-w-0 flex-1 overflow-hidden">
          <main class="min-w-0 flex-1 overflow-hidden bg-panel">
            <router-view />
          </main>
          <PreviewSider v-if="preview.available" />
          <WorkspacePanel v-if="workspace.available" />
        </div>
        <ActivityBand v-if="activity.available" />
      </div>
    </div>
    <WorkspaceOverlayRegions />
    <NoticeHost />
    <SettingsDialog v-model:open="settingsOpen" v-model:section="settingsSection" />
  </div>
</template>
