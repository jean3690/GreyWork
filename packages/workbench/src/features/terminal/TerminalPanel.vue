<script setup lang="ts">
/**
 * 底部终端面板：多标签交互式终端（真 PTY）。
 *
 * 形态与 ActivityBand 一致 —— 底部通栏、高度在 0 ↔ `TERMINAL_PANEL_HEIGHT_PX` 间过渡、
 * 收起时内容保持挂载（`v-show`，滚动历史与运行中的会话都不丢）。区别只在内容：一条标签栏
 * （标签 = 独立 shell 会话）+ 每个标签一个 xterm 视图（见 `TerminalView`）。
 *
 * 它是**交互式**的：每个标签页是一个真 PTY 子进程，`vim` / `top` / 密码输入都可用。
 * 会话生命周期（开/关/重启、选 shell、启动目录）收在 store（`useTerminalStore`）；这里
 * 只负责标签栏与选择器的渲染与交互接线。
 *
 * 可用性由 Shell 的视口同步回灌（`terminal.available`），标题栏开关与面板读同一处。
 */
import { computed, onMounted } from "vue";
import Icon from "@/features/shared/Icon.vue";
import Hint from "@/features/shared/Hint.vue";
import TerminalView from "@/features/terminal/TerminalView.vue";
import { TERMINAL_PANEL_HEIGHT_PX } from "@/lib/layout";
import { useTerminalStore, type TerminalStatus } from "@/stores/terminal";
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

// 挂载即拉一次 shell 列表；若上次退出时面板是展开的，补一个会话（见 store.setOpen）。
onMounted(() => {
  void terminal.loadShells();
  if (terminal.open) void terminal.ensureTab();
});
</script>

<template>
  <section
    v-if="terminal.available"
    data-testid="terminal-panel"
    class="relative shrink-0 overflow-hidden bg-panel-2 transition-[height] duration-150"
    :class="terminal.open ? 'border-t border-line-2' : ''"
    :style="{ height: terminal.open ? `${TERMINAL_PANEL_HEIGHT_PX}px` : '0px' }"
    :aria-hidden="terminal.open ? undefined : 'true'"
  >
    <div class="flex h-full flex-col">
      <!-- 标题条：与活动面板/右栏区段条同一节奏 -->
      <div class="flex h-[34px] shrink-0 items-center gap-2 border-b border-line px-3">
        <Icon name="terminal" :size="14" class="shrink-0 text-dim2" />

        <!-- 标签栏：溢出横向滚动；每个标签 = 一个 shell 会话 -->
        <div data-testid="terminal-tabs" class="flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          <div
            v-for="tab in terminal.tabs"
            :key="tab.sessionId"
            data-testid="terminal-tab"
            :class="tabClass(tab.sessionId)"
            role="presentation"
            @click="terminal.setActive(tab.sessionId)"
          >
            <span class="size-1.5 shrink-0 rounded-full" :class="dotClass(tab.status)" aria-hidden="true" />
            <span class="max-w-[140px] cursor-pointer truncate" :title="tab.cwd || tab.title">
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
        <div v-for="tab in terminal.tabs" v-show="tab.sessionId === terminal.activeId" :key="tab.sessionId" class="absolute inset-0">
          <TerminalView :tab="tab" @opened="terminal.markRunning" @exited="terminal.markExited" @failed="terminal.markError" />
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
