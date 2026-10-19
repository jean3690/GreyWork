<script setup lang="ts">
/**
 * 单个终端标签页：xterm 实例 + 与 PTY 会话的 IO 接线。
 *
 * 一个标签页对应一个后端会话（`tab.sessionId`）。挂载即：
 * 1. 建 xterm（fit 插件按容器尺寸算行列）；
 * 2. **先订阅** `terminal://data` / `terminal://exit`（按 sessionId 过滤），
 * 3. 再 `terminal_open` —— 顺序不能反，否则 shell 已回显的首屏提示符会在订阅生效前发出而丢掉；
 * 4. 键盘输入经 `terminal_write` 回写，容器尺寸变化经 `terminal_resize` 通知内核。
 *
 * `tab.attached` 为真表示会话**已经开在宿主里**（渲染进程重载后接回、面板卸载重挂）：
 * 此时跳过 `terminal_open`，只订阅事件接上 —— 再开一次会撞「会话 id 已存在」。
 *
 * 非激活标签用 `v-show` 隐藏但保持挂载：切标签不重建终端、不丢滚动历史。
 * 会话生命周期（开/关/重启/状态）收在 store，这里只负责「已有 sessionId 的渲染与 IO」。
 */
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { listen } from "@greywork/host-ipc";
import { terminalBackend } from "@/lib/terminal-backend";
import type { TerminalTab } from "@/stores/terminal";
import { i18n } from "@/i18n";

const props = defineProps<{ tab: TerminalTab }>();
/** 外壳组件不装 i18n 插件也要能渲染，故用全局实例而非 useI18n。 */
const t = i18n.global.t;

/**
 * 亮「正在启动」进度的延迟。shell 起来后要跑完 rc（nvm / conda / oh-my-zsh…）才回提示符，
 * 慢的机器上好几秒；这期间终端是空的，不给进度会像「没连上」。快 shell 不闪。
 */
const SPINNER_DELAY_MS = 350;
const emit = defineEmits<{
  (event: "opened", sessionId: string): void;
  (event: "exited", sessionId: string): void;
  (event: "failed", sessionId: string, message: string): void;
}>();

const host = ref<HTMLElement | null>(null);
let term: Terminal | null = null;
let fit: FitAddon | null = null;
let observer: ResizeObserver | null = null;
let stopData: (() => void) | null = null;
let stopExit: (() => void) | null = null;
/** 会话是否已成功建立：未建立前不发输入 / 改尺寸（此时写会被后端判「会话不存在」）。 */
let live = false;
/** 会话已建立、但 shell 还没吐过任何输出（rc 还在跑）：亮「正在启动」，首屏数据一到即收。 */
const showSpinner = ref(false);
let spinnerTimer: ReturnType<typeof setTimeout> | null = null;

function clearSpinner(): void {
  if (spinnerTimer) {
    clearTimeout(spinnerTimer);
    spinnerTimer = null;
  }
  showSpinner.value = false;
}

/**
 * xterm 主题。xterm 只认**字面颜色值**（不解析 CSS 变量），所以这里硬编码一组与
 * `--console`（#0a111b，终端固定深底）配套的配色；改终端配色只能改这里。
 */
const THEME = {
  background: "#0a111b",
  foreground: "#c0caf5",
  cursor: "#7aa2f7",
  cursorAccent: "#0a111b",
  selectionBackground: "#28344a",
  black: "#1a2233",
  red: "#f7768e",
  green: "#9ece6a",
  yellow: "#e0af68",
  blue: "#7aa2f7",
  magenta: "#bb9af7",
  cyan: "#7dcfff",
  white: "#a9b1d6",
  brightBlack: "#414868",
  brightRed: "#ff7a93",
  brightGreen: "#b9f27c",
  brightYellow: "#ff9e64",
  brightBlue: "#7da6ff",
  brightMagenta: "#bb9af7",
  brightCyan: "#0db9d7",
  brightWhite: "#c0caf5",
} as const;

/** `terminal://data` 的载荷。 */
interface TerminalDataPayload {
  sessionId: string;
  data: string;
}

interface TerminalExitPayload {
  sessionId: string;
}

/** base64 → 原始字节。交 `Uint8Array` 给 xterm，让它按 UTF-8 续接被读线程切断的多字节字符。 */
function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** 只在容器有真实尺寸时 fit —— 非激活标签（display:none）为 0，fit 会算出坏尺寸。 */
function fitIfVisible(): void {
  const element = host.value;
  if (!element || element.offsetWidth === 0 || element.offsetHeight === 0) return;
  try {
    fit?.fit();
  } catch {
    // 容器尚未完成布局：下一次 ResizeObserver 回调会再来。
  }
}

function fail(message: string): void {
  clearSpinner();
  emit("failed", props.tab.sessionId, message);
  term?.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`);
}

async function start(): Promise<void> {
  await nextTick();
  const element = host.value;
  if (!element) return;

  const instance = new Terminal({
    fontFamily: '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace',
    fontSize: 12,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 5000,
    theme: THEME,
  });
  const fitAddon = new FitAddon();
  instance.loadAddon(fitAddon);
  instance.open(element);
  term = instance;
  fit = fitAddon;
  fitIfVisible();
  // shell 起来到回提示符之间是空屏，超过延迟就亮进度（见 SPINNER_DELAY_MS）。
  spinnerTimer = setTimeout(() => {
    spinnerTimer = null;
    showSpinner.value = true;
  }, SPINNER_DELAY_MS);

  try {
    // 先订阅、后开会话（见文件头注释）。
    const sessionId = props.tab.sessionId;
    stopData = await listen<TerminalDataPayload>("terminal://data", (event) => {
      if (event.payload?.sessionId !== sessionId) return;
      // 收到首屏输出即认为 shell 就绪（提示符 / 横幅都算）。
      clearSpinner();
      term?.write(decodeBase64(event.payload.data));
    });
    stopExit = await listen<TerminalExitPayload>("terminal://exit", (event) => {
      if (event.payload?.sessionId !== sessionId) return;
      clearSpinner();
      live = false;
      emit("exited", sessionId);
      term?.write("\r\n\x1b[2m[进程已退出]\x1b[0m\r\n");
    });

    instance.onData((data) => {
      if (live) void terminalBackend.write(sessionId, data);
    });
    instance.onResize(({ cols, rows }) => {
      if (live) void terminalBackend.resize(sessionId, cols, rows);
    });

    if (props.tab.attached) {
      // 宿主里这个会话还开着（渲染进程重载 / 面板被卸载重挂）：只接上，不再开一个。
      // 断开期间的输出不会重放 —— 事件总线不缓存，重连后是干净屏，敲一下回车即有提示符。
      clearSpinner();
      if (props.tab.status === "exited" || props.tab.status === "error") {
        instance.write("\r\n\x1b[2m[进程已退出]\x1b[0m\r\n");
      } else {
        live = true;
        emit("opened", sessionId);
        instance.focus();
      }
    } else {
      await terminalBackend.open({
        sessionId,
        cwd: props.tab.cwd || undefined,
        shell: props.tab.shellId || undefined,
        cols: instance.cols,
        rows: instance.rows,
      });
      live = true;
      emit("opened", sessionId);
      instance.focus();
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(() => {
      if (live) fitIfVisible();
    });
    observer.observe(element);
  }
}

onMounted(() => {
  void start();
});

onBeforeUnmount(() => {
  live = false;
  clearSpinner();
  observer?.disconnect();
  observer = null;
  stopData?.();
  stopExit?.();
  term?.dispose();
  term = null;
  fit = null;
});
</script>

<template>
  <div class="relative h-full w-full">
    <div ref="host" data-testid="terminal-view" class="h-full w-full" />

    <!-- shell 启动期（跑 rc）空屏提示：不挡输入，首屏输出一到即消失 -->
    <div v-if="showSpinner" data-testid="terminal-starting" class="pointer-events-none absolute inset-x-0 top-0 flex justify-center pt-2">
      <span
        class="flex items-center gap-2 rounded-[calc(6px*var(--gw-radius-scale))] border border-line bg-panel/85 px-2.5 py-1 text-[11px] text-dim2"
        :title="t('terminal.startingHint')"
      >
        <span class="size-1.5 animate-pulse rounded-full bg-cyan" aria-hidden="true" />
        {{ t("terminal.starting") }}
      </span>
    </div>
  </div>
</template>
