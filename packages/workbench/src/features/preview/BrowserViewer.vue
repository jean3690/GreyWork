<script setup lang="ts">
/**
 * 内嵌浏览器：宿主子 webview 的「外壳」。
 *
 * 真正的网页跑在宿主创建的原生子 webview 里（apps/desktop/src-tauri/src/browser.rs），
 * 本组件只画地址栏 / 工具条，并把一个铺满剩余空间的槽位矩形实时同步给宿主。子 webview
 * 是原生层，永远压在主窗口 DOM 之上、位置只能由宿主移动，所以这里的同步只有两件事：
 *
 * - **几何**：ResizeObserver + 窗口 resize + 布局 watch 汇入一个 rAF 去抖的同步，
 *   矩形在 0.5px 容差内没变就不发（见 lib/browser-bounds）；
 * - **可见性**：面板折叠 / 禁用 / 窗口失焦 / 有宿主弹层时把 webview 藏起来 ——
 *   原生层会盖住弹层并吞掉点击，这是「内嵌原生 webview」唯一稳的遮挡策略；
 *   藏的时候槽位给一块「已暂停」占位，否则用户会以为页面白屏了。
 *
 * 生命周期：卸载时若 store 里已无浏览器标签（用户关掉了 tab）就销毁子 webview；
 * 若只是切到别的预览 / 文件区，则只藏不关 —— 切回来不该丢页面状态。
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { browserBackend, normalizeBrowserUrl, openInSystemBrowser, type BrowserRect, type BrowserStateEvent } from "@/lib/browser-backend";
import { isOverlayPresent, rectEquals, rectOf } from "@/lib/browser-bounds";
import { usePreviewStore } from "@/stores/preview";
import { i18n } from "@/i18n";
import Icon from "@/features/shared/Icon.vue";
import Hint from "@/features/shared/Hint.vue";
import type { PreviewTab } from "@/stores/preview";

const props = defineProps<{ tab: PreviewTab }>();
const t = i18n.global.t;
const preview = usePreviewStore();
const route = useRoute();

/** 桌面态才有宿主子 webview；其余运行时给一块说明占位（浏览器标签本就不该出现）。 */
const supported = browserBackend.supported();

const address = ref(props.tab.path);
const state = ref<BrowserStateEvent>({
  url: props.tab.path,
  title: props.tab.name,
  loading: false,
  canGoBack: false,
  canGoForward: false,
});
const overlayPresent = ref(false);
const windowFocused = ref(true);
const hostError = ref<string | null>(null);
/** 加载超过 15s 视为卡住：给一个「用系统浏览器打开」的逃生口（宿主没有 load-failed 回调）。 */
const stuck = ref(false);

const slotEl = ref<HTMLElement | null>(null);

const STUCK_MS = 15_000;

let unlistenState: (() => void) | null = null;
let unlistenFocus: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;
let mutationObserver: MutationObserver | null = null;
let stuckTimer: ReturnType<typeof setTimeout> | null = null;
let syncQueued = false;
let lastRect: BrowserRect | null = null;
let lastVisible: boolean | null = null;

function setError(cause: unknown): void {
  hostError.value = cause instanceof Error ? cause.message : String(cause);
}

function queueSync(): void {
  if (syncQueued || !supported) return;
  syncQueued = true;
  requestAnimationFrame(() => {
    syncQueued = false;
    void sync();
  });
}

/** 槽位几何 + 可见性一并同步；可见与几何互相独立（藏的时候不追矩形，省无谓的往返）。 */
async function sync(): Promise<void> {
  const slot = slotEl.value;
  if (!slot) return;
  overlayPresent.value = isOverlayPresent();
  const visible = preview.available && !preview.collapsed && windowFocused.value && !overlayPresent.value;
  if (!visible) {
    if (lastVisible !== false) {
      lastVisible = false;
      await browserBackend.setVisible(false).catch(setError);
    }
    return;
  }
  const rect = rectOf(slot);
  if (lastRect === null || !rectEquals(lastRect, rect)) {
    lastRect = rect;
    await browserBackend.setBounds(rect).catch(setError);
  }
  if (lastVisible !== true) {
    lastVisible = true;
    await browserBackend.setVisible(true).catch(setError);
  }
}

function armStuckTimer(): void {
  disarmStuckTimer();
  stuckTimer = setTimeout(() => {
    stuck.value = true;
  }, STUCK_MS);
}

function disarmStuckTimer(): void {
  if (stuckTimer) clearTimeout(stuckTimer);
  stuckTimer = null;
  stuck.value = false;
}

function onState(next: BrowserStateEvent): void {
  state.value = next;
  if (next.url) address.value = next.url;
  if (next.title) preview.setName(props.tab.id, next.title);
  if (next.loading) armStuckTimer();
  else disarmStuckTimer();
}

/** 地址栏回车 / 工具条导航。同址 no-op —— 重载走刷新按钮，语义分开。 */
function go(target: string): void {
  const normalized = normalizeBrowserUrl(target);
  if (!normalized || normalized === state.value.url) return;
  hostError.value = null;
  address.value = normalized;
  void browserBackend.navigate(normalized).catch(setError);
}

function openExternal(): void {
  void openInSystemBrowser(state.value.url || props.tab.path).catch(setError);
}

/** OS 窗口焦点，不是 DOM blur —— 点进子 webview 会 blur 宿主文档，用 DOM 焦点会把
 * webview 藏在用户正要交互的那一刻。 */
async function watchWindowFocus(): Promise<() => void> {
  try {
    return await getCurrentWindow().onFocusChanged((event) => {
      windowFocused.value = event.payload;
      queueSync();
    });
  } catch {
    return () => {};
  }
}

function startObservers(): void {
  const slot = slotEl.value;
  if (!slot) return;
  resizeObserver = new ResizeObserver(() => queueSync());
  resizeObserver.observe(slot);
  window.addEventListener("resize", queueSync);
  // 弹层走 portal 挂到 body 各处，没有统一入口（见 lib/browser-bounds 的清单），只能观察。
  mutationObserver = new MutationObserver(() => queueSync());
  mutationObserver.observe(document.body, { childList: true, subtree: true });
}

function stopObservers(): void {
  resizeObserver?.disconnect();
  resizeObserver = null;
  window.removeEventListener("resize", queueSync);
  mutationObserver?.disconnect();
  mutationObserver = null;
  unlistenState?.();
  unlistenState = null;
  unlistenFocus?.();
  unlistenFocus = null;
}

onMounted(async () => {
  if (!supported) return;
  unlistenState = await browserBackend.onState(onState);
  unlistenFocus = await watchWindowFocus();
  // 等首帧布局落定再开：此刻 slot 还没铺开，rect 是 0。
  await nextTick();
  const slot = slotEl.value;
  if (!slot) return;
  const rect = rectOf(slot);
  lastRect = rect;
  await browserBackend.open(props.tab.path, rect).catch(setError);
  lastVisible = true;
  startObservers();
});

onBeforeUnmount(() => {
  stopObservers();
  disarmStuckTimer();
  if (!supported) return;
  // tab 已被关掉 → 销毁；只是切走（面板 / 路由变化）→ 藏起来保留页面状态。
  if (preview.tabs.some((tab) => tab.kind === "browser")) {
    lastVisible = false;
    void browserBackend.setVisible(false).catch(() => {});
  } else {
    void browserBackend.close().catch(() => {});
  }
});

watch(
  () => props.tab.path,
  (next) => {
    address.value = next;
    hostError.value = null;
    if (!supported) return;
    void browserBackend.navigate(next).catch(setError);
  },
);

// 面板宽度 / 折叠 / 视口与路由变化都会改动槽位几何；ResizeObserver 只看得见 slot 自身，
// 布局模式的整树变化（如引导页 ↔ 对话页）靠这两个 watch 兜住。
watch(
  () => [preview.available, preview.collapsed, preview.effectiveWidthPx] as const,
  () => queueSync(),
);
watch(
  () => route.fullPath,
  () => queueSync(),
);
</script>

<template>
  <div class="flex size-full min-h-0 flex-col overflow-hidden">
    <div v-if="!supported" class="flex min-h-0 flex-1 items-center justify-center px-6">
      <p class="text-center text-[12px] leading-relaxed text-dim2">{{ t("web.browserUnsupported") }}</p>
    </div>
    <template v-else>
      <!-- 工具条 + 地址栏 -->
      <div class="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1.5">
        <button
          type="button"
          data-testid="browser-back"
          :disabled="!state.canGoBack"
          class="grid size-6 shrink-0 cursor-pointer place-items-center rounded-[calc(6px*var(--gw-radius-scale))] text-dim2 transition-colors hover:bg-panel hover:text-foreground disabled:cursor-default disabled:opacity-40"
          :aria-label="t('preview.viewer.browser.back')"
          @click="browserBackend.back()"
        >
          <Icon name="arrow-left" :size="14" />
        </button>
        <button
          type="button"
          data-testid="browser-forward"
          :disabled="!state.canGoForward"
          class="grid size-6 shrink-0 cursor-pointer place-items-center rounded-[calc(6px*var(--gw-radius-scale))] text-dim2 transition-colors hover:bg-panel hover:text-foreground disabled:cursor-default disabled:opacity-40"
          :aria-label="t('preview.viewer.browser.forward')"
          @click="browserBackend.forward()"
        >
          <Icon name="arrow-right" :size="14" />
        </button>
        <button
          v-if="state.loading"
          type="button"
          data-testid="browser-stop"
          class="grid size-6 shrink-0 cursor-pointer place-items-center rounded-[calc(6px*var(--gw-radius-scale))] text-dim2 transition-colors hover:bg-panel hover:text-foreground"
          :aria-label="t('preview.viewer.browser.stop')"
          @click="browserBackend.stop()"
        >
          <Icon name="close-one" :size="14" />
        </button>
        <button
          v-else
          type="button"
          data-testid="browser-reload"
          class="grid size-6 shrink-0 cursor-pointer place-items-center rounded-[calc(6px*var(--gw-radius-scale))] text-dim2 transition-colors hover:bg-panel hover:text-foreground"
          :aria-label="t('preview.viewer.browser.reload')"
          @click="browserBackend.reload()"
        >
          <Icon name="refresh" :size="14" />
        </button>

        <span class="grid size-6 shrink-0 place-items-center text-dim2" aria-hidden="true">
          <Icon name="earth" :size="13" />
        </span>
        <input
          v-model="address"
          type="text"
          data-testid="browser-url"
          spellcheck="false"
          :placeholder="t('preview.viewer.browser.addressPlaceholder')"
          class="h-6 min-w-0 flex-1 rounded-[calc(6px*var(--gw-radius-scale))] border border-line-2 bg-panel px-2 text-[12px] text-foreground outline-none focus-visible:border-cyan"
          @keydown.enter.prevent="go(address)"
        />
        <Hint :text="t('preview.viewer.browser.openExternal')" multiline>
          <button
            type="button"
            data-testid="browser-open-external"
            class="grid size-6 shrink-0 cursor-pointer place-items-center rounded-[calc(6px*var(--gw-radius-scale))] text-dim2 transition-colors hover:bg-panel hover:text-foreground"
            :aria-label="t('preview.viewer.browser.openExternal')"
            @click="openExternal"
          >
            <Icon name="external" :size="14" />
          </button>
        </Hint>
      </div>

      <p v-if="hostError" role="alert" class="shrink-0 border-b border-line px-3 py-1.5 text-[11.5px] leading-relaxed text-orange">
        {{ hostError }}
      </p>

      <!-- 槽位：子 webview 由宿主对齐到这里 -->
      <div class="relative min-h-0 flex-1">
        <div ref="slotEl" data-testid="browser-webview-slot" class="size-full" />
        <div v-if="overlayPresent" data-testid="browser-paused" class="absolute inset-0 grid place-items-center bg-panel-2">
          <p class="text-[12px] text-dim2">{{ t("preview.viewer.browser.paused") }}</p>
        </div>
        <div
          v-if="stuck && state.loading"
          data-testid="browser-stuck"
          class="absolute inset-x-3 bottom-3 flex items-center justify-between gap-2 rounded-[calc(8px*var(--gw-radius-scale))] border border-line-2 bg-panel px-3 py-2"
        >
          <span class="text-[11.5px] text-dim2">{{ t("preview.viewer.browser.stuck") }}</span>
          <button
            type="button"
            data-testid="browser-stuck-open-external"
            class="shrink-0 cursor-pointer text-[11.5px] text-cyan hover:underline"
            @click="openExternal"
          >
            {{ t("preview.viewer.browser.openExternal") }}
          </button>
        </div>
      </div>
    </template>
  </div>
</template>
