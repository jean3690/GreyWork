<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import "@/theme/shadcn.css";
import "@/theme/tokens.css";
import "@/theme/base.css";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { useWorkspaceStore } from "@/stores/workspace";
import { usePreviewStore } from "@/stores/preview";
import { useWorkspacePanelStore } from "@/stores/workspacePanel";
import { useActivityStore } from "@/stores/activity";
import { useLayoutStore } from "@/stores/layout";
import { useRemoteAssistantStore } from "@/stores/remote-assistant";
import { appEvents } from "@/events";
import { i18n } from "@/i18n";
import { applyAppearance as applyAppearanceToDom } from "@/lib/theme";
import { modeOfShortcut, visibilityOf, type LayoutMode } from "@/lib/layout-modes";
import { syncCloseToTray, syncTrayLabels, useTrayBridge, type TrayLabels } from "@/lib/tray-bridge";
import { useCloseGuard } from "@/lib/close-guard";
import { hasDirtyPreviewTabs, pendingDiscard, requestLeave } from "@/lib/preview-edit-guard";
import { bootPlugins } from "@/plugins/runtime";
import Sider from "@/features/shell/Sider.vue";
import Titlebar from "@/features/shell/Titlebar.vue";
import NoticeHost from "@/features/shell/NoticeHost.vue";
import WorkspaceOverlayRegions from "@/features/shell/WorkspaceOverlayRegions.vue";

/**
 * 首屏不渲染的四块改成异步组件：它们整棵子树（设置面含全部设置分区、预览外壳、
 * 文件树、底部活动带）原本被静态 import 焊进入口 chunk，白白让首帧多下约 47 KiB gzip。
 * 实测入口 810 KiB → 645 KiB raw（254 → 207 KiB gzip）。
 *
 * 桌面端 chunk 从本地文件加载、落地是毫秒级；设置是「点开才用」的模态，
 * 右栏/活动带也都在 mount 之后才由 store 打开，因此首次渲染并不同步依赖它们。
 */
const SettingsDialog = defineAsyncComponent(() => import("@/features/settings/SettingsDialog.vue"));
const PreviewSider = defineAsyncComponent(() => import("@/features/preview/PreviewSider.vue"));
const WorkspacePanel = defineAsyncComponent(() => import("@/features/workspace/WorkspacePanel.vue"));
const ActivityBand = defineAsyncComponent(() => import("@/features/activity/ActivityBand.vue"));

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

/**
 * 窄屏收拢右栏：**先把未保存的改动存下来再卸载**。
 *
 * 模板里 `PreviewSider` 是 `v-if="preview.available"` —— 变窄就整个卸载，而卸载会注销
 * 预览编辑器的 saver，未保存的改动随之消失。所以「从桌面变窄」这一步在面板还挂着的
 * 状态下先走一遍守卫：flush 全部成功才真的收起来；写不进去会挂起确认弹层（由
 * PreviewSider 渲染），在用户答复之前面板继续留着。
 *
 * 留在窄屏不会挤坏布局：窄屏下面板本就会被自动折叠成宽度 0（stores/preview 的
 * shouldAutoCollapse），差别只是实例还在、编辑器与滚动位置都还在。
 *
 * 两个模块级标志：`narrowFlushInFlight` 挡 resize storm 期间的并发 flush（requestLeave
 * 只在已有待确认弹层时才早退，flush 途中没有互斥）；`narrowDeferred` 记下「用户这次选了
 * 取消」，此后不再反复追问，直到视口回到桌面重新武装。
 */
let narrowFlushInFlight = false;
let narrowDeferred = false;

function collapsePreviewForNarrow(): void {
  // 没有脏改动（或本来就没开着）：照旧直接卸载。
  if (!hasDirtyPreviewTabs()) {
    preview.setAvailable(false);
    return;
  }
  // 正在 flush、用户已拒绝过一次、或关窗守卫的弹层正挂着 → 这一轮不动它。
  if (narrowFlushInFlight || narrowDeferred || pendingDiscard.value) return;
  narrowFlushInFlight = true;
  requestLeave(() => {
    narrowFlushInFlight = false;
    // flush 期间用户可能已经拉回桌面：那就不该再卸（syncViewport 已经把它打开了）。
    if (window.innerWidth >= MOBILE_BREAKPOINT) return;
    preview.setAvailable(false);
  });
}

// 弹层关掉但 run 没执行 = 用户选了「取消」：清掉 inFlight（否则会永久卡住，之后再窄也不收），
// 并记下这次不收，等回到桌面重新武装。
watch(pendingDiscard, (pending) => {
  if (pending || !narrowFlushInFlight) return;
  narrowFlushInFlight = false;
  narrowDeferred = true;
});

function syncViewport(): void {
  if (typeof window === "undefined") return;
  const mobile = window.innerWidth < MOBILE_BREAKPOINT;
  isMobile.value = mobile;
  // 窄屏默认收起，让内容区拿满宽度；用户手动展开后交给 toggle 决定。
  // 从窄屏回到桌面时恢复偏好 —— 否则「我收起了左栏」这个偏好只在重启后才生效。
  collapsed.value = mobile ? true : layout.sidebarCollapsed;
  // 右栏在窄屏不渲染。这个判断只在这里做一次，Titlebar 的开关按钮读同一个 store 字段，
  // 不再各自写一个断点（那正是 640–768px 之间「按钮可见但面板不存在」的来源）。
  // 但卸载前要先兜住未保存的编辑，见 collapsePreviewForNarrow。
  if (mobile) {
    collapsePreviewForNarrow();
  } else {
    narrowDeferred = false;
    preview.setAvailable(true);
  }
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

/**
 * 「关闭到托盘」同步给宿主：宿主在 CloseRequested 里读它决定拦不拦（见 src-tauri/src/tray.rs）。
 * immediate 让默认 / 本地缓存值先落地；设置从 SQLite 水合完成后若真值不同会再触发一次，
 * 因此不会出现「偏好是关到托盘、宿主却按关闭即退出拦」的错配。
 *
 * 宿主还会再叠一道可用性钳制：托盘没建出来时这个偏好不生效（否则窗口藏起来没入口恢复）。
 */
watch(
  () => settings.closeToTray,
  (enabled) => void syncCloseToTray(enabled),
  { immediate: true },
);

/**
 * 托盘菜单文案同步给宿主。宿主侧菜单是原生控件、不认 vue-i18n，所以每次切语言都要
 * 整份重推（见 src-tauri/src/tray.rs 的 set_tray_labels）。immediate 让启动时就落地，
 * 覆盖掉宿主构建菜单时用的那套占位文案。
 */
function currentTrayLabels(): TrayLabels {
  const t = i18n.global.t;
  return {
    toggleWindow: t("trayMenu.toggleWindow"),
    newChat: t("trayMenu.newChat"),
    settings: t("trayMenu.settings"),
    quit: t("trayMenu.quit"),
    hiddenHint: t("trayMenu.hiddenHint"),
  };
}
watch(
  () => i18n.global.locale.value,
  () => void syncTrayLabels(currentTrayLabels()),
  { immediate: true },
);

/** 托盘事件订阅的解绑函数（浏览器态是空函数）。 */
let disposeTrayBridge: (() => void) | null = null;

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
  // 系统托盘：把菜单事件转成应用内动作（新建对话 / 打开设置）。宿主已先显示并聚焦窗口。
  disposeTrayBridge = useTrayBridge({ onNewChat: handleNewChat, onOpenSettings: openSettings });
  // 关窗 / 退出守卫：拦下「有未保存改动」的退出，交给预览那套先保存再走。
  // 与托盘桥同为应用级接线，所以放在外壳而不是预览面板里；确认弹层的渲染点在
  // PreviewSider（它持有 saver 注册表，见 lib/close-guard.ts）。
  useCloseGuard();
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
  disposeTrayBridge?.();
  disposeTrayBridge = null;
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
  <!-- 注意：这里**不**挂全局 TooltipProvider。features/shared/Hint.vue 自带一个 ——
       reka 的 TooltipRoot 缺 provider 会直接抛，全局挂法会把「哪些测试要多包一层」
       变成隐式耦合。取舍见 Hint.vue 顶部注释。 -->
  <!-- 裸窗口（悬浮宠物等）：只有 router-view，无外壳 chrome。 -->
  <router-view v-if="bareWindow" />
  <div v-else class="flex size-full min-h-0 flex-col overflow-hidden bg-background" data-testid="shell">
    <Titlebar
      :collapsed="collapsed"
      :show-sider-toggle="isMobile"
      @toggle-sider="collapsed = !collapsed"
      @navigate="navigate"
      @new-chat="handleNewChat"
      @open-settings="openSettings"
    />
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
