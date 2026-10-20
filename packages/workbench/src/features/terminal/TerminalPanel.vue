<script setup lang="ts">
/**
 * 底部终端面板：多标签交互式终端（真 PTY）。
 *
 * 形态与 ActivityBand 一致 —— 底部通栏、高度在 0 ↔ 偏好高度间过渡（上边缘可拖拽 / 键盘调高，
 * 偏好落盘），收起时内容保持挂载（`v-show`，滚动历史与运行中的会话都不丢）。区别只在内容：
 * 一条标签栏（标签 = 独立 shell 会话）+ 每个标签一个 xterm 视图（见 `TerminalView`）。
 *
 * 支持左右分屏：右栏显示另一个标签（`terminal.splitId`），两个窗格各挂一个真 xterm；
 * 分屏只改窗格几何，不重挂组件，所以滚动历史不丢。
 *
 * 它是**交互式**的：每个标签页是一个真 PTY 子进程，`vim` / `top` / 密码输入都可用。
 * 会话生命周期（开/关/重启、选 shell、启动目录）收在 store（`useTerminalStore`）；这里
 * 只负责标签栏与选择器的渲染与交互接线。
 *
 * 可用性由 Shell 的视口同步回灌（`terminal.available`），标题栏开关与面板读同一处。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch, type ComponentPublicInstance } from "vue";
import Icon from "@/features/shared/Icon.vue";
import Hint from "@/features/shared/Hint.vue";
import TerminalView from "@/features/terminal/TerminalView.vue";
import { MAX_TERMINAL_PANEL_PX, MIN_TERMINAL_PANEL_PX, TERMINAL_PANEL_HEIGHT_PX } from "@/lib/layout";
import { useTerminalStore, type TerminalStatus, type TerminalTab } from "@/stores/terminal";
import { i18n } from "@/i18n";

const terminal = useTerminalStore();
/** 外壳组件不装 i18n 插件也要能渲染，故用全局实例而非 useI18n。 */
const t = i18n.global.t;

const buttonClass =
  "grid size-6 shrink-0 cursor-pointer place-items-center rounded-[calc(6px*var(--gw-radius-scale))] text-dim2 transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:opacity-40";

/** 标签页右键/选择器共用的紧凑下拉（与 SearchPanel 的工作区筛选同一形态）。 */
const selectClass =
  "h-5 max-w-[130px] cursor-pointer rounded-[calc(5px*var(--gw-radius-scale))] border border-line bg-panel px-1 text-[10.5px] text-foreground outline-none";

/** 激活标签页（无标签页时为 null）。 */
const active = computed(() => terminal.activeTab);

/** 面板根元素：判断 Ctrl+F 的焦点是否落在终端里（否则留给编辑器 / 浏览器）。 */
const panelEl = ref<HTMLElement | null>(null);

/** 查找条只属于激活标签：切标签 / 收起面板时一并关掉。 */
const searchOpen = ref(false);
watch([() => terminal.activeId, () => terminal.open], () => {
  searchOpen.value = false;
});

/* ===== 分屏 ===== */

/** 右侧分屏的标签页（不分屏时为 null）。 */
const splitTab = computed(() => terminal.splitTab);

/** 某个标签是否在可见窗格里（分屏时是左右两栏，否则只有激活项）。 */
function paneVisible(tab: TerminalTab): boolean {
  if (!splitTab.value) return tab.sessionId === terminal.activeId;
  return tab.sessionId === terminal.activeId || tab.sessionId === splitTab.value.sessionId;
}

/** 窗格几何：不分屏铺满，分屏各占一半（绝对定位，切分屏不重挂 xterm）。 */
function paneStyle(tab: TerminalTab): Record<string, string> {
  if (!splitTab.value) return { left: "0", right: "0" };
  return tab.sessionId === terminal.activeId ? { left: "0", right: "50%" } : { left: "50%", right: "0" };
}

/**
 * 分屏 / 取消分屏。没有第二个标签时先开一个（把原来的激活项留在左栏，
 * 新会话放右栏），这样「点分屏」永远有东西可看。
 */
async function toggleSplit(): Promise<void> {
  if (terminal.splitId) {
    terminal.setSplit("");
    return;
  }
  const other = terminal.tabs.find((tab) => tab.sessionId !== terminal.activeId);
  if (other) {
    terminal.setSplit(other.sessionId);
    return;
  }
  const previous = terminal.activeId;
  const created = await terminal.addTab();
  if (!created) return;
  if (previous) terminal.setActive(previous);
  terminal.setSplit(created);
}

/* ===== 高度拖拽（偏好落盘） ===== */

/** 拖拽调高的进行中控制器（卸载时中止，避免监听器泄漏）。 */
let resizeDrag: AbortController | null = null;
/** 正在拖拽：关掉高度过渡，否则面板会追着鼠标慢半拍。 */
const resizing = ref(false);

function onResizeStart(event: PointerEvent): void {
  if (event.button !== 0) return;
  event.preventDefault();
  resizeDrag?.abort();
  const controller = new AbortController();
  resizeDrag = controller;
  resizing.value = true;
  const startY = event.clientY;
  const startHeight = terminal.heightPx;
  const previousCursor = document.body.style.cursor;
  const previousSelect = document.body.style.userSelect;
  document.body.style.cursor = "row-resize";
  document.body.style.userSelect = "none";
  const finish = (): void => {
    controller.abort();
    resizeDrag = null;
    resizing.value = false;
    document.body.style.cursor = previousCursor;
    document.body.style.userSelect = previousSelect;
  };
  window.addEventListener(
    "pointermove",
    (move) => {
      // 面板贴着窗口底边：鼠标往上（clientY 变小）→ 面板变高。
      terminal.setHeight(startHeight + (startY - move.clientY));
    },
    { signal: controller.signal },
  );
  window.addEventListener("pointerup", finish, { signal: controller.signal });
  window.addEventListener("pointercancel", finish, { signal: controller.signal });
}

/** 键盘调高：方向键 ±8px（Shift 步进 40），Home/End 到上下限。 */
function onResizeKeydown(event: KeyboardEvent): void {
  const step = event.shiftKey ? 40 : 8;
  if (event.key === "ArrowUp") terminal.setHeight(terminal.heightPx + step);
  else if (event.key === "ArrowDown") terminal.setHeight(terminal.heightPx - step);
  else if (event.key === "Home") terminal.setHeight(MIN_TERMINAL_PANEL_PX);
  else if (event.key === "End") terminal.setHeight(MAX_TERMINAL_PANEL_PX);
  else return;
  event.preventDefault();
}

function resetHeight(): void {
  terminal.setHeight(TERMINAL_PANEL_HEIGHT_PX);
}

/** 已结束的激活标签页（shell 退出 / 启动失败）：「重启」入口只对它显示，避免误点杀掉活会话。 */
const deadTab = computed(() =>
  active.value && (active.value.status === "exited" || active.value.status === "error") ? active.value : null,
);

/** 标签状态点颜色。 */
function dotClass(status: TerminalStatus): string {
  if (status === "running") return "bg-mint";
  if (status === "error") return "bg-[#d9534f]";
  if (status === "exited") return "bg-dim2";
  return "bg-cyan animate-pulse";
}

function tabClass(sessionId: string): string {
  return [
    "flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-[calc(6px*var(--gw-radius-scale))] px-1.5 text-[11.5px] transition-colors",
    "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan",
    sessionId === terminal.activeId ? "bg-panel text-foreground" : "text-dim hover:text-foreground",
  ].join(" ");
}

function onShellChange(event: Event): void {
  terminal.setPendingShell((event.target as HTMLSelectElement).value);
}

/* ===== 标签操作：拖拽重排 / 双击重命名 / 中键关闭 ===== */

/** 正在被拖的标签 id（用来给其它标签降透明度，给一个「拖到了哪」的反馈）。 */
const draggingId = ref<string | null>(null);
/** 正在重命名的标签 id 与草稿（同一时刻只有一个）。 */
const renamingId = ref("");
const renameDraft = ref("");

function onTabDragStart(event: DragEvent, sessionId: string): void {
  draggingId.value = sessionId;
  // 塞个非空载荷只是让拖拽影像合法（Firefox 要求 dataTransfer 非空才触发 dragstart）。
  event.dataTransfer?.setData("text/plain", sessionId);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}

function onTabDrop(event: DragEvent, index: number): void {
  event.preventDefault();
  const sessionId = draggingId.value;
  draggingId.value = null;
  if (sessionId) terminal.moveTab(sessionId, index);
}

/** 中键关闭（终端 / 浏览器标签页的通行约定）；左键 auxclick 不误关。 */
function onTabAuxclick(event: MouseEvent, sessionId: string): void {
  if (event.button !== 1) return;
  event.preventDefault();
  terminal.closeTab(sessionId);
}

function startRename(tab: TerminalTab): void {
  renamingId.value = tab.sessionId;
  renameDraft.value = tab.title;
}

function commitRename(): void {
  const sessionId = renamingId.value;
  if (!sessionId) return;
  renamingId.value = "";
  terminal.renameTab(sessionId, renameDraft.value);
}

function cancelRename(): void {
  renamingId.value = "";
}

/** 重命名输入框挂载即聚焦并全选（直接敲新名字，不用先点一下）。 */
function focusRenameInput(element: Element | ComponentPublicInstance | null): void {
  if (!(element instanceof HTMLInputElement)) return;
  element.focus();
  element.select();
}

/**
 * 终端快捷键（面板挂载期间全局生效，与 Shell 的 Ctrl+` / Ctrl+1~4 不重叠）：
 * - `Ctrl/Cmd+Shift+T` 新建标签 —— 面板收起时也生效，按完即展开（否则得先点面板）；
 * - `Ctrl/Cmd+Shift+W` 关闭当前标签；
 * - `Ctrl/Cmd+PageUp/PageDown` 前后切标签（循环）；
 * - `Ctrl/Cmd+F` 打开查找（只在焦点位于终端面板内时接管，否则会抢走编辑器的查找）。
 *
 * 监听放在捕获阶段并 `stopPropagation`：xterm 的 textarea 在冒泡阶段把按键原样送进 PTY，
 * 不拦的话 Ctrl+F / Ctrl+Shift+W 会一边执行动作一边给 shell 发控制字符。
 */
function onWindowKeydown(event: KeyboardEvent): void {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;

  if (event.shiftKey && event.code === "KeyT") {
    event.preventDefault();
    event.stopPropagation();
    void terminal.addTab();
    return;
  }
  if (!terminal.open) return;
  if (!event.shiftKey && event.code === "KeyF") {
    if (!panelEl.value?.contains(event.target as Node)) return;
    event.preventDefault();
    event.stopPropagation();
    searchOpen.value = true;
    return;
  }
  if (event.shiftKey && event.code === "KeyW") {
    event.preventDefault();
    event.stopPropagation();
    if (terminal.activeId) terminal.closeTab(terminal.activeId);
    return;
  }
  if (!event.shiftKey && (event.code === "PageUp" || event.code === "PageDown")) {
    event.preventDefault();
    event.stopPropagation();
    terminal.cycleTab(event.code === "PageDown" ? 1 : -1);
  }
}

// 挂载即接回宿主里仍在跑的会话（渲染进程重载 / 面板重挂），再按偏好决定是否补一个新会话。
onMounted(() => {
  window.addEventListener("keydown", onWindowKeydown, true);
  void terminal.hydrate().then(() => {
    if (terminal.open) void terminal.ensureTab();
  });
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onWindowKeydown, true);
  resizeDrag?.abort();
  resizeDrag = null;
});
</script>

<template>
  <section
    v-if="terminal.available"
    ref="panelEl"
    data-testid="terminal-panel"
    class="relative shrink-0 overflow-hidden bg-panel-2"
    :class="[terminal.open ? 'border-t border-line-2' : '', resizing ? 'transition-none' : 'transition-[height] duration-150']"
    :style="{ height: terminal.open ? `min(${terminal.heightPx}px, 72vh)` : '0px' }"
    :aria-hidden="terminal.open ? undefined : 'true'"
  >
    <!-- 高度拖拽把手：贴着面板上边缘；双击复位到默认高度 -->
    <div
      v-if="terminal.open"
      data-testid="terminal-resize-handle"
      class="group absolute inset-x-0 top-0 z-20 flex h-1.5 cursor-row-resize items-start justify-center"
      role="separator"
      aria-orientation="horizontal"
      :aria-label="t('terminal.resize')"
      :aria-valuemin="MIN_TERMINAL_PANEL_PX"
      :aria-valuemax="MAX_TERMINAL_PANEL_PX"
      :aria-valuenow="terminal.heightPx"
      tabindex="0"
      @pointerdown="onResizeStart"
      @keydown="onResizeKeydown"
      @dblclick="resetHeight"
    >
      <span class="pointer-events-none h-0.5 w-full bg-transparent transition-colors group-hover:bg-cyan" />
    </div>
    <div class="flex h-full flex-col">
      <!-- 标题条：与活动面板/右栏区段条同一节奏 -->
      <div class="flex h-[34px] shrink-0 items-center gap-2 border-b border-line px-3">
        <Icon name="terminal" :size="14" class="shrink-0 text-dim2" />

        <!-- 标签栏：溢出横向滚动；每个标签 = 一个 shell 会话 -->
        <div data-testid="terminal-tabs" class="flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          <div
            v-for="(tab, index) in terminal.tabs"
            :key="tab.sessionId"
            data-testid="terminal-tab"
            :data-tab-id="tab.sessionId"
            :draggable="renamingId !== tab.sessionId"
            :class="[tabClass(tab.sessionId), draggingId && draggingId !== tab.sessionId ? 'opacity-60' : '']"
            role="presentation"
            @click="terminal.setActive(tab.sessionId)"
            @dblclick="startRename(tab)"
            @auxclick="onTabAuxclick($event, tab.sessionId)"
            @dragstart="onTabDragStart($event, tab.sessionId)"
            @dragover.prevent
            @drop="onTabDrop($event, index)"
            @dragend="draggingId = null"
          >
            <span class="size-1.5 shrink-0 rounded-full" :class="dotClass(tab.status)" aria-hidden="true" />
            <input
              v-if="renamingId === tab.sessionId"
              :ref="focusRenameInput"
              v-model="renameDraft"
              data-testid="terminal-tab-rename"
              class="h-4 w-[88px] min-w-0 rounded-[calc(4px*var(--gw-radius-scale))] border border-line bg-panel px-1 text-[11.5px] text-foreground outline-none"
              :aria-label="t('terminal.rename')"
              @click.stop
              @keydown.enter.prevent="commitRename"
              @keydown.esc.prevent="cancelRename"
              @blur="commitRename"
            />
            <span v-else class="max-w-[140px] cursor-pointer truncate" :title="tab.cwd || tab.title">
              {{ tab.title }}
            </span>
            <button
              type="button"
              data-testid="terminal-tab-close"
              class="grid size-4 shrink-0 cursor-pointer place-items-center rounded-[calc(4px*var(--gw-radius-scale))] text-dim2 transition-colors hover:bg-panel-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
              :aria-label="t('terminal.closeTab', { name: tab.title })"
              @click.stop="terminal.closeTab(tab.sessionId)"
            >
              <Icon name="close" :size="10" />
            </button>
          </div>
        </div>

        <div class="flex shrink-0 items-center gap-0.5">
          <!-- 当前标签页的启动目录：命令就落在这里 -->
          <span
            v-if="active?.cwd"
            data-testid="terminal-cwd"
            class="hidden max-w-[220px] items-center gap-1 text-[10.5px] text-dim2 sm:flex"
            :title="active.cwd"
          >
            <Icon name="folder" :size="11" class="shrink-0" />
            <span class="truncate font-mono">{{ active.cwd }}</span>
          </span>

          <!-- 查找当前标签的滚动输出（Ctrl/Cmd+F 同效） -->
          <Hint v-if="active" :text="t('terminal.search')">
            <button
              type="button"
              data-testid="terminal-search-open"
              :class="buttonClass"
              :aria-label="t('terminal.search')"
              @click="searchOpen = true"
            >
              <Icon name="search" :size="13" />
            </button>
          </Hint>

          <!-- 选终端环境：决定「下一个新标签」用哪个 shell -->
          <select
            v-if="terminal.shells.length"
            data-testid="terminal-shell"
            :class="selectClass"
            :value="terminal.pendingShellId"
            :aria-label="t('terminal.shell')"
            :title="t('terminal.shell')"
            @change="onShellChange"
          >
            <option v-for="shell in terminal.shells" :key="shell.id" :value="shell.id">
              {{ shell.label }}
            </option>
          </select>

          <!-- 分屏：把另一个标签放到右栏；只有一个标签时先开一个 -->
          <Hint v-if="active" :text="terminal.splitId ? t('terminal.unsplit') : t('terminal.split')">
            <button
              type="button"
              data-testid="terminal-split"
              :class="[buttonClass, terminal.splitId ? 'text-cyan' : '']"
              :aria-label="terminal.splitId ? t('terminal.unsplit') : t('terminal.split')"
              :aria-pressed="terminal.splitId ? 'true' : 'false'"
              @click="toggleSplit"
            >
              <Icon name="split" :size="13" />
            </button>
          </Hint>

          <Hint v-if="deadTab" :text="t('terminal.restart')">
            <button
              type="button"
              data-testid="terminal-restart"
              :class="buttonClass"
              :aria-label="t('terminal.restart')"
              @click="terminal.restartTab(deadTab.sessionId)"
            >
              <Icon name="refresh" :size="13" />
            </button>
          </Hint>
          <Hint :text="t('terminal.newTab')">
            <button
              type="button"
              data-testid="terminal-new-tab"
              :class="buttonClass"
              :aria-label="t('terminal.newTab')"
              @click="terminal.addTab()"
            >
              <Icon name="plus" :size="13" />
            </button>
          </Hint>
          <button
            type="button"
            data-testid="terminal-collapse"
            :class="buttonClass"
            :aria-label="t('terminal.collapse')"
            @click="terminal.setOpen(false)"
          >
            <Icon name="down" :size="13" />
          </button>
        </div>
      </div>

      <!-- 内容区：收起时 v-show 隐藏但保持挂载，终端滚动历史不丢 -->
      <div v-show="terminal.open" class="relative min-h-0 flex-1 bg-[#0a111b]">
        <!-- 窗格用绝对定位：分屏只改几何，不重挂 xterm（滚动历史与订阅都不受影响） -->
        <div
          v-for="tab in terminal.tabs"
          v-show="paneVisible(tab)"
          :key="tab.sessionId"
          data-testid="terminal-pane"
          :data-pane="tab.sessionId === terminal.activeId ? 'main' : tab.sessionId === splitTab?.sessionId ? 'split' : 'hidden'"
          class="absolute inset-y-0"
          :class="splitTab && tab.sessionId === splitTab.sessionId ? 'border-s border-line' : ''"
          :style="paneStyle(tab)"
        >
          <TerminalView
            :tab="tab"
            :search-open="terminal.activeId === tab.sessionId && searchOpen"
            @opened="terminal.markRunning"
            @exited="terminal.markExited"
            @failed="terminal.markError"
            @close-search="searchOpen = false"
          />
        </div>

        <!-- 空态：启动失败 / 无可会话时给一个明确的「新建」入口 -->
        <div
          v-if="terminal.tabs.length === 0"
          data-testid="terminal-empty"
          class="flex size-full flex-col items-center justify-center gap-2 px-4 text-center"
        >
          <span class="text-[12px] text-dim2">{{ t("terminal.empty") }}</span>
          <button
            type="button"
            data-testid="terminal-empty-new"
            class="cursor-pointer rounded-[calc(6px*var(--gw-radius-scale))] border border-line-2 bg-panel px-2.5 py-1 text-[11.5px] text-dim transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
            @click="terminal.addTab()"
          >
            {{ t("terminal.newTab") }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
