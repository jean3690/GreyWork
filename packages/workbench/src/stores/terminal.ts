import { createJsonStorage } from "@greywork/core";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { terminalBackend, type ShellInfo, type TerminalSessionInfo } from "@/lib/terminal-backend";
import { activeConversationFolder } from "@/lib/conversation-folder";
import { activeWorkspaceFolder } from "@/lib/artifact-dir";
import { resolveWorkspaceDir } from "@/lib/workspace-dir";

/**
 * 底部终端面板（交互式、多标签）的宿主状态。
 *
 * 形态对标电脑上的终端：每个标签页是一个**真 PTY** 会话（`terminal_open` 起 shell，
 * 输出走 `terminal://data` 事件）。store 只负责**会话清单与生命周期**（开/关标签页、
 * 选 shell、启动目录解析、可用性），真正的 xterm 实例与 IO 接线在
 * `features/terminal/TerminalView.vue` 里 —— store 不碰 DOM，这样「开标签 → 会话就位」
 * 这条路径可单测，不用挂载 xterm。
 *
 * 持久化只存 `open` 偏好 + 标签页清单（会话 id / 标题 / 目录 / shell）；标签的**运行状态**
 * 不落盘，由 `hydrate()` 用宿主 `terminal_list` 校准。渲染进程重载（或面板被卸载重挂）后，
 * 仍在跑的 PTY 会被接回同一个标签页 —— 进程不会因为界面刷新而丢。
 *
 * 工作目录跟随**当前工作区**：新标签页在「当前对话绑定的工作区文件夹 → 激活工作区文件夹 →
 * 设置项 / 应用私有 `~/.greyWork`」里启动，与 ACP 会话、文件树、Git 面板同一条解析链
 * （见 lib/workspace-dir）。已启动的会话保持自己的目录（shell 里 `cd` 由用户掌控），
 * 切工作区只影响之后新建的标签页。
 *
 * 可用性由 Shell 的视口同步回灌（与 activity.available 同源），标题栏开关与面板都读它。
 */

/** 会话状态：标签页标题旁的状态点。 */
export type TerminalStatus = "starting" | "running" | "exited" | "error";

/** 一个终端标签页。 */
export interface TerminalTab {
  /** 会话 id（前端生成，`terminal_open` / 事件都按它对齐）。 */
  sessionId: string;
  /** 标签标题（如 `zsh 1`）。 */
  title: string;
  /** 启动目录（空串 = 解析不出，后端落宿主默认根）。 */
  cwd: string;
  /** 选用的 shell id / 展示名。 */
  shellId: string;
  shellLabel: string;
  status: TerminalStatus;
  /** 启动失败时的错误文案。 */
  error?: string;
  /**
   * 宿主里这个会话**已经开着**（本端开过，或从上次渲染进程接回）。
   * 视图挂载时据此直接接上，而不是再 `terminal_open` 一次 —— 后者会撞「会话 id 已存在」。
   * 面板因视口变化被卸载重挂时同样靠它避免重复开会话。
   */
  attached?: boolean;
}

/** 落盘的标签页字段：运行状态 / 错误不持久化，恢复时以宿主清单为准。 */
interface PersistedTab {
  sessionId: string;
  title: string;
  cwd: string;
  shellId: string;
  shellLabel: string;
}

interface TerminalPrefs {
  open: boolean;
  /** 上次退出时开着的标签页（顺序即展示顺序）。 */
  tabs?: PersistedTab[];
  /** 上次激活的会话 id。 */
  activeId?: string;
}

function isPersistedTab(value: unknown): value is PersistedTab {
  if (typeof value !== "object" || value === null) return false;
  const tab = value as Record<string, unknown>;
  return ["sessionId", "title", "cwd", "shellId", "shellLabel"].every((key) => typeof tab[key] === "string");
}

function isPrefs(value: unknown): value is TerminalPrefs {
  if (typeof value !== "object" || value === null) return false;
  const prefs = value as Record<string, unknown>;
  if (typeof prefs.open !== "boolean") return false;
  // 旧版本只存了 `open`：缺 `tabs` / `activeId` 仍算合法（向后兼容）。
  if (prefs.tabs !== undefined && (!Array.isArray(prefs.tabs) || !prefs.tabs.every(isPersistedTab))) return false;
  return prefs.activeId === undefined || typeof prefs.activeId === "string";
}

const prefsStorage = createJsonStorage<TerminalPrefs>("greywork.terminal", isPrefs);

export const useTerminalStore = defineStore("terminal", () => {
  const savedPrefs = prefsStorage.read();
  /** 默认收起：终端是「要用才拉出来」的工具，不该一开屏就占住底部。 */
  const open = ref(savedPrefs?.open ?? false);
  /**
   * 当前视口是否渲染终端（窄屏不渲染）。
   * 由 Shell 的视口同步回灌，与 preview.available / activity.available 同一来源与断点。
   */
  const available = ref(true);

  /** 打开的标签页（顺序即展示顺序）。 */
  const tabs = ref<TerminalTab[]>([]);
  /** 当前激活标签页的 sessionId；无标签页时为空串。 */
  const activeId = ref("");

  /** 本机可用 shell（`terminal_shells` 拉取）。 */
  const shells = ref<ShellInfo[]>([]);
  /** 新建标签页预选的 shell id。 */
  const pendingShellId = ref("");
  /** 是否已请求过 shell 列表（避免重复拉取）。 */
  let shellRequest: Promise<void> | null = null;

  /**
   * 新建标签页前的默认启动目录（显示用）。空串 = 尚未解析或解析失败。
   * 已开标签页各存自己的 `cwd`；这个值只服务「下一个新标签」与空态提示。
   */
  const cwd = ref("");
  const cwdBound = ref(false);

  /** 正在异步创建标签页（防连点 / 防 ensureTab 并发重复开）。 */
  let creating = false;
  /** 标题序号：同名 shell 递增（zsh 1 / zsh 2）。 */
  let labelSeq = 0;

  /** 当前绑定的工作区文件夹（对话绑定优先，其次激活工作区），null = 无绑定。 */
  const boundFolder = computed(() => activeConversationFolder() ?? activeWorkspaceFolder());

  /** 当前激活标签页（无则不返回）。 */
  const activeTab = computed(() => tabs.value.find((tab) => tab.sessionId === activeId.value) ?? tabs.value[0] ?? null);

  function persist(): void {
    prefsStorage.write({
      open: open.value,
      tabs: tabs.value.map(({ sessionId, title, cwd, shellId, shellLabel }) => ({
        sessionId,
        title,
        cwd,
        shellId,
        shellLabel,
      })),
      activeId: activeId.value,
    });
  }

  function setOpen(value: boolean): void {
    open.value = value;
    persist();
    // 展开即对齐目录并确保有一个会话：用户点开终端就是想敲命令。
    if (value) void ensureTab();
  }

  function toggle(): void {
    setOpen(!open.value);
  }

  /** 窄屏可用性回灌：不动 open 偏好（与 preview.setAvailable 同语义）。 */
  function setAvailable(value: boolean): void {
    available.value = value;
  }

  /**
   * 解析下一个新标签页的启动目录。绑定工作区直接取（同步，不打扰宿主）；未绑定才回落到
   * 设置项 / 应用私有根 —— 那一步要问宿主，失败（浏览器态等）就留空，让后端用自己的默认根。
   */
  async function syncCwd(): Promise<string> {
    const bound = boundFolder.value;
    if (bound) {
      cwd.value = bound;
      cwdBound.value = true;
      return bound;
    }
    try {
      cwd.value = await resolveWorkspaceDir();
    } catch {
      cwd.value = "";
    }
    cwdBound.value = false;
    return cwd.value;
  }

  /** 拉一次本机 shell 列表（幂等）。失败静默：列表为空时面板回落到后端默认 shell。 */
  async function loadShells(): Promise<void> {
    if (shellRequest) return shellRequest;
    shellRequest = terminalBackend
      .shells()
      .then((catalog) => {
        shells.value = catalog.shells;
        if (!pendingShellId.value) {
          pendingShellId.value = catalog.defaultId ?? catalog.shells[0]?.id ?? "";
        }
      })
      .catch(() => {
        // 宿主不可用 / 未放行：保持空表，开标签时后端仍会用默认 shell。
      });
    return shellRequest;
  }

  function setPendingShell(shellId: string): void {
    pendingShellId.value = shellId;
  }

  /** 恢复只跑一次（成功时）；宿主暂时不可用则允许下次挂载重试。 */
  let hydrateRequest: Promise<void> | null = null;

  /**
   * 接回宿主里仍在跑的会话（面板挂载时调用，幂等）。
   *
   * 渲染进程重载后内存里的标签页没了，但 PTY 还活着。顺序：
   * 1. 按上次落盘的顺序，只保留宿主里仍在跑的会话（其余视为宿主已重启，直接丢弃）；
   * 2. 宿主里有、落盘里没有的会话补成新标签（上次没来得及落盘 / 偏好被清）—— 不然它们
   *    就成了没人认领的孤儿进程；
   * 3. 没有宿主（浏览器预览）或宿主不可用：保持空清单，由 `ensureTab` 决定是否新开。
   *
   * 接回的标签一律 `attached: true`、`status: "running"`：视图只订阅、不再 `terminal_open`。
   * 断开期间 shell 的输出不会重放（事件总线不缓存），重连后是干净屏。
   *
   * 会话清单是**宿主全局**的：这里按「单窗口」假设全部认领。多窗口同时连同一宿主时会共享
   * 同一批 PTY（输入互相可见），不在当前形态内。
   */
  async function hydrate(): Promise<void> {
    if (hydrateRequest) return hydrateRequest;
    hydrateRequest = restore();
    return hydrateRequest;
  }

  async function restore(): Promise<void> {
    if (!terminalBackend.supported()) return;
    let live: TerminalSessionInfo[];
    try {
      // 会话清单与 shell 列表互不依赖，并行问。
      [live] = await Promise.all([terminalBackend.list(), loadShells()] as const);
    } catch {
      // 宿主暂时不可用：别把「没问到」当成「没有会话」，下次挂载再试。
      hydrateRequest = null;
      return;
    }

    const byId = new Map(live.map((session) => [session.sessionId, session]));
    const restored: TerminalTab[] = [];
    for (const saved of savedPrefs?.tabs ?? []) {
      const session = byId.get(saved.sessionId);
      if (!session) continue;
      byId.delete(saved.sessionId);
      restored.push({
        ...saved,
        cwd: session.cwd,
        shellId: session.shellId,
        shellLabel: session.shellLabel,
        status: "running",
        attached: true,
      });
    }
    // 宿主里还有、落盘里没有的会话：补成新标签，别让 PTY 变成没人认领的孤儿。
    for (const session of byId.values()) {
      const label = session.shellLabel || session.shellId || "shell";
      const count = restored.filter((tab) => tab.shellLabel === label).length + 1;
      restored.push({
        sessionId: session.sessionId,
        title: `${label} ${count}`,
        cwd: session.cwd,
        shellId: session.shellId,
        shellLabel: label,
        status: "running",
        attached: true,
      });
    }
    if (restored.length === 0) return;

    // 恢复期间用户可能已经点了「新建」：保留新标签，把接回的会话排在前面。
    const known = new Set(tabs.value.map((tab) => tab.sessionId));
    tabs.value = [...restored.filter((tab) => !known.has(tab.sessionId)), ...tabs.value];
    if (!tabs.value.some((tab) => tab.sessionId === activeId.value)) {
      const savedActive = savedPrefs?.activeId;
      activeId.value = savedActive && restored.some((tab) => tab.sessionId === savedActive) ? savedActive : restored[0].sessionId;
    }
    persist();
  }

  function nextSessionId(): string {
    labelSeq += 1;
    return `term-${Date.now().toString(36)}-${labelSeq}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function shellLabelOf(shellId: string): string {
    return shells.value.find((shell) => shell.id === shellId)?.label ?? shellId;
  }

  /** 新建一个标签页（不在此开会话：由 TerminalView 订阅事件后再 `terminal_open`）。 */
  async function addTab(shellId?: string): Promise<string | null> {
    if (creating) return null;
    creating = true;
    try {
      // 并行解析：启动目录（可能问宿主）与 shell 列表互不依赖，串行会白白多等一个来回。
      const [dir] = await Promise.all([syncCwd(), loadShells()]);
      const chosen = shellId || pendingShellId.value || shells.value[0]?.id || "";
      const label = shellLabelOf(chosen) || "shell";
      // 同名 shell 递增序号，多标签时标题可区分。
      const count = tabs.value.filter((tab) => tab.shellLabel === label).length + 1;
      const sessionId = nextSessionId();
      const tab: TerminalTab = {
        sessionId,
        title: `${label} ${count}`,
        cwd: dir,
        shellId: chosen,
        shellLabel: label,
        status: "starting",
      };
      tabs.value = [...tabs.value, tab];
      activeId.value = sessionId;
      open.value = true;
      persist();
      return sessionId;
    } finally {
      creating = false;
    }
  }

  /** 确保至少有一个标签页（展开终端 / 恢复时调用）。 */
  async function ensureTab(): Promise<void> {
    if (tabs.value.length > 0 || creating) return;
    await addTab();
  }

  /** 关闭标签页：从清单移除并通知后端杀进程。 */
  function closeTab(sessionId: string): void {
    const index = tabs.value.findIndex((tab) => tab.sessionId === sessionId);
    if (index === -1) return;
    tabs.value = tabs.value.filter((tab) => tab.sessionId !== sessionId);
    if (activeId.value === sessionId) {
      activeId.value = tabs.value[Math.min(index, tabs.value.length - 1)]?.sessionId ?? "";
    }
    persist();
    void terminalBackend.close(sessionId).catch(() => {
      // 会话可能已退出 / 未真正建立，关闭失败无所谓。
    });
  }

  /** 重启标签页：关掉旧会话，用同样的 shell 目录开一个新标签。 */
  function restartTab(sessionId: string): void {
    const tab = tabs.value.find((item) => item.sessionId === sessionId);
    if (!tab) return;
    const { shellId } = tab;
    closeTab(sessionId);
    void addTab(shellId);
  }

  function setActive(sessionId: string): void {
    if (tabs.value.some((tab) => tab.sessionId === sessionId)) {
      activeId.value = sessionId;
      persist();
    }
  }

  /** 拖拽重排：把标签移到目标下标（与预览栏同语义：下标是原数组里的落点）。 */
  function moveTab(sessionId: string, toIndex: number): void {
    const from = tabs.value.findIndex((tab) => tab.sessionId === sessionId);
    if (from === -1) return;
    const target = Math.max(0, Math.min(toIndex, tabs.value.length - 1));
    if (target === from) return;
    const next = [...tabs.value];
    const [moved] = next.splice(from, 1);
    next.splice(target, 0, moved);
    tabs.value = next;
    persist();
  }

  /** 重命名标签页（空标题视为取消：保留原名，不让标签变成无法辨认的空块）。 */
  function renameTab(sessionId: string, title: string): void {
    const next = title.trim();
    if (!next) return;
    update(sessionId, (tab) => (tab.title === next ? tab : { ...tab, title: next }));
    persist();
  }

  /** 按顺序切到上/下一个标签（Ctrl+PageUp / PageDown），循环。 */
  function cycleTab(delta: number): void {
    if (tabs.value.length < 2) return;
    const index = tabs.value.findIndex((tab) => tab.sessionId === activeId.value);
    const next = index === -1 ? 0 : (index + delta + tabs.value.length) % tabs.value.length;
    setActive(tabs.value[next].sessionId);
  }

  /**
   * 会话已启动（TerminalView 收到 `terminal_open` 成功，或接回了已有会话）。
   * 同时打上 `attached`：面板因视口变化被卸载重挂时，视图据此接上而不是重复开会话。
   */
  function markRunning(sessionId: string): void {
    update(sessionId, (tab) => ({ ...tab, status: "running", attached: true }));
  }

  /** 进程退出（`terminal://exit`）。 */
  function markExited(sessionId: string): void {
    update(sessionId, (tab) => (tab.status === "error" ? tab : { ...tab, status: "exited" }));
  }

  /** 会话启动失败。 */
  function markError(sessionId: string, error: string): void {
    update(sessionId, (tab) => ({ ...tab, status: "error", error }));
  }

  function update(sessionId: string, mutate: (tab: TerminalTab) => TerminalTab): void {
    tabs.value = tabs.value.map((tab) => (tab.sessionId === sessionId ? mutate(tab) : tab));
  }

  return {
    open,
    available,
    tabs,
    activeId,
    activeTab,
    shells,
    pendingShellId,
    cwd,
    cwdBound,
    boundFolder,
    setOpen,
    toggle,
    setAvailable,
    syncCwd,
    loadShells,
    hydrate,
    setPendingShell,
    addTab,
    ensureTab,
    closeTab,
    restartTab,
    setActive,
    moveTab,
    renameTab,
    cycleTab,
    markRunning,
    markExited,
    markError,
  };
});
