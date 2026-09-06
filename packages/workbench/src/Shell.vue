<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import "./theme/shadcn.css";
import "./theme/tokens.css";
import "./theme/base.css";
import { useSessionStore } from "./stores/session";
import { useSettingsStore } from "./stores/settings";
import { useWorkspaceStore } from "./stores/workspace";
import { usePreviewStore } from "./stores/preview";
import { bootPlugins } from "./plugins/runtime";
import Sider from "./components/Sider.vue";
import PreviewSider from "./components/preview/PreviewSider.vue";
import Titlebar from "./components/Titlebar.vue";
import NoticeHost from "./components/NoticeHost.vue";

/**
 * GreyWork 风格外壳：标题栏 + 左侧栏 + 内容区（router-view）+ 右侧预览面板。
 *
 * 主题读 settings.theme（与旧工作台同一持久化来源，切换不丢用户偏好）。
 */
const settings = useSettingsStore();
const route = useRoute();
const router = useRouter();
const sessionStore = useSessionStore();
const workspaceStore = useWorkspaceStore();
const preview = usePreviewStore();

watch(
  () => settings.theme,
  (theme) => {
    if (typeof document !== "undefined") document.documentElement.dataset.theme = theme;
  },
  { immediate: true },
);

const MOBILE_BREAKPOINT = 768;
const collapsed = ref(false);
const isMobile = ref(false);

function syncViewport(): void {
  if (typeof window === "undefined") return;
  const mobile = window.innerWidth < MOBILE_BREAKPOINT;
  isMobile.value = mobile;
  // 窄屏默认收起，让内容区拿满宽度；用户手动展开后交给 toggle 决定。
  if (mobile) collapsed.value = true;
  // 右栏在窄屏不渲染。这个判断只在这里做一次，Titlebar 的开关按钮读同一个 store 字段，
  // 不再各自写一个断点（那正是 640–768px 之间「按钮可见但面板不存在」的来源）。
  preview.setAvailable(!mobile);
}

/**
 * 全局快捷键与抽屉的键盘退路。
 *
 * - Ctrl/Cmd+N 新对话 · Ctrl/Cmd+B 折叠/展开侧栏 · Ctrl/Cmd+\ 预览面板。
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
    if (key === "\\") {
      event.preventDefault();
      if (preview.available) preview.toggle();
      return;
    }
  }
  if (event.key !== "Escape") return;
  if (!isMobile.value || collapsed.value) return;
  collapsed.value = true;
}

/**
 * [内容区 + 右栏] 这一行的实测宽度回灌给 preview store，用于把右栏宽度收进
 * 「不挤破会话区」的范围。用这一行而不是整个窗口：左栏宽度会变（折叠/拖拽），
 * 拿窗口宽度算会在左栏展开时高估可用空间。
 */
const mainRow = ref<HTMLElement | null>(null);
let rowObserver: ResizeObserver | null = null;

function observeMainRow(): void {
  // happy-dom 等环境没有 ResizeObserver：跳过即可，宽度约束退化为只按 MIN/MAX 收敛。
  if (typeof ResizeObserver === "undefined" || !mainRow.value) return;
  rowObserver = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect.width;
    if (typeof width === "number") preview.setAvailableWidth(width);
  });
  rowObserver.observe(mainRow.value);
}

onMounted(() => {
  syncViewport();
  window.addEventListener("resize", syncViewport);
  window.addEventListener("keydown", onWindowKeydown);
  observeMainRow();
  // 微内核接线：注册内置插件清单并激活（幂等，见 plugins/runtime）。
  void bootPlugins();
});
onBeforeUnmount(() => {
  if (typeof window !== "undefined") {
    window.removeEventListener("resize", syncViewport);
    window.removeEventListener("keydown", onWindowKeydown);
  }
  rowObserver?.disconnect();
  rowObserver = null;
});

/** 设置页的「返回」目标：记住进入设置前停在哪。 */
const lastNonSettingsPath = ref("/guid");
watch(
  () => route.fullPath,
  (path) => {
    if (!path.startsWith("/settings")) lastNonSettingsPath.value = path;
  },
  { immediate: true },
);

function navigate(path: string): void {
  void router.push(path);
  if (isMobile.value) collapsed.value = true;
}

function handleNewChat(): void {
  const session = sessionStore.createSession(workspaceStore.activeWorkspaceId);
  navigate(`/conversation/${session.id}`);
}

/** 主题切换只在 dark/light 间来回；system 由设置页显式选。 */
function toggleTheme(): void {
  settings.theme = settings.theme === "dark" ? "light" : "dark";
  settings.persist();
}
</script>

<template>
  <div class="flex size-full min-h-0 flex-col overflow-hidden bg-background" data-testid="shell">
    <Titlebar :collapsed="collapsed" @toggle-sider="collapsed = !collapsed" @navigate="navigate" />
    <div class="relative flex min-h-0 flex-1 overflow-hidden">
      <!-- 移动端展开的侧栏是抽屉：遮罩点击收起，侧栏悬浮于内容之上而非挤占宽度 -->
      <div v-if="isMobile && !collapsed" class="absolute inset-0 z-30 bg-black/30" aria-hidden="true" @click="collapsed = true" />
      <Sider
        :collapsed="collapsed"
        :overlay="isMobile"
        :theme="settings.theme"
        :last-non-settings-path="lastNonSettingsPath"
        @new-chat="handleNewChat"
        @navigate="navigate"
        @toggle-theme="toggleTheme"
      />
      <!-- 内容区与右栏合成被观测的一行：mainRow 的宽度是右栏 clamp 的依据 -->
      <div ref="mainRow" class="flex min-w-0 flex-1 overflow-hidden">
        <main class="min-w-0 flex-1 overflow-hidden bg-panel">
          <router-view />
        </main>
        <PreviewSider v-if="preview.available" />
      </div>
    </div>
    <NoticeHost />
  </div>
</template>
