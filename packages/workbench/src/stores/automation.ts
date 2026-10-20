import { createJsonStorage } from "@greywork/core";
import { defineStore } from "pinia";
import { ref, watch } from "vue";
import { listen } from "@greywork/host-ipc";
import {
  automationsBackend,
  type AutomationDuePayload,
  type AutomationDueRow,
  type AutomationRunRow,
  type AutomationTaskRow,
} from "../lib/automations-backend";
import { useChatStore } from "./chat";
import { useAgentStore } from "./agent";
import { useSessionStore } from "./session";
import { useWorkspaceStore } from "./workspace";
import { notify } from "./notice";
import { validateCron } from "../lib/cron";
import { i18n } from "../i18n";

const t = i18n.global.t;

/** 自动化任务：按时/规则触发的预设指令，Run Now 经 chat 派管线复跑并落产物。 */
export interface AutomationTask {
  id: string;
  name: string;
  /** 触发描述（如「每天 09:00」）。 */
  schedule: string;
  /** 标准 cron 5 段表达式（分 时 日 月 周）；null/缺省 = 手动触发（仅 Run Now）。 */
  cron?: string | null;
  /**
   * 一次性任务的触发时刻（epoch ms）；null/缺省 = 按 cron 循环。
   *
   * 与 `cron` 互斥：cron 没有年份字段，表达不了「就跑这一次」，所以一次性任务
   * 只写 `onceAt`（宿主按时间戳判定 + 跑过即不再触发），并在跑完后自动停用。
   */
  onceAt?: number | null;
  /** 执行后端：ACP 后端 id（带工具跑）；null/缺省 = 本机模型管线。 */
  acpProviderId?: string | null;
  /** 目标工作区/项目。 */
  target: string;
  /** 实际下发的指令文本（复跑 mock/真实管线）。 */
  intent: string;
  enabled: boolean;
  /** 最近一次运行时间戳（epoch ms；0=从未）。 */
  lastRun: number;
  /** 是否正在执行（Run Now 进行中）。 */
  running: boolean;
}

interface SavedAutomations {
  list?: AutomationTask[];
}

const automationsStorage = createJsonStorage<SavedAutomations>(
  "greywork.automations",
  (value): value is SavedAutomations => typeof value === "object" && value !== null && !Array.isArray(value),
);

interface SavedRuns {
  runs?: AutomationRunRow[];
}

/** 运行记录本地缓存（浏览器态真源；桌面态由 SQLite 覆盖）。 */
const runsStorage = createJsonStorage<SavedRuns>(
  "greywork.automation-runs",
  (value): value is SavedRuns => typeof value === "object" && value !== null && !Array.isArray(value),
);

/** 运行记录内存/缓存上限（与库侧每任务 50 条各自独立；这里是跨任务总量护栏）。 */
const RUNS_CAP = 200;

let seq = 0;
function uid(): string {
  seq += 1;
  return `at-${seq}`;
}

/** 任务专属会话 id：确定性派生自任务 id（不入库、不加列；删除任务即连带删除会话）。 */
function taskSessionId(taskId: string): string {
  return `auto-${taskId}`;
}

const DEFAULT_AUTOMATIONS: AutomationTask[] = [
  {
    id: "at-seed-1",
    name: "整理项目状态",
    schedule: "每天 09:00",
    cron: "0 9 * * *",
    target: "普通对话",
    intent: "梳理项目本周改动并生成日报",
    enabled: false,
    lastRun: 0,
    running: false,
  },
  {
    id: "at-seed-2",
    name: "自动生成周报",
    schedule: "每周五 18:00",
    cron: "0 18 * * 5",
    target: "普通对话",
    intent: "生成一份周报，包含数据表，并导出 Excel 和 PPT 简报",
    enabled: false,
    lastRun: 0,
    running: false,
  },
  {
    id: "at-seed-3",
    name: "依赖安全巡检",
    schedule: "每天 03:00",
    cron: "0 3 * * *",
    target: "全部项目",
    intent: "跑一遍测试，修复失败的用例",
    enabled: false,
    lastRun: 0,
    running: false,
  },
];

function toRow(task: AutomationTask): AutomationTaskRow {
  return {
    id: task.id,
    name: task.name,
    schedule: task.schedule,
    cron: task.cron ?? null,
    onceAt: task.onceAt ?? null,
    acpProviderId: task.acpProviderId ?? null,
    target: task.target,
    intent: task.intent,
    enabled: task.enabled,
    lastRun: task.lastRun,
  };
}

/**
 * 一次性任务的收尾判定：跑过（lastRun > 0）就不再启用。
 *
 * 宿主在入队时就会写 last_run（应用不在场时接着由 host_exec 兜底执行），所以从库里
 * 读回来时通常是「跑过但 enabled 仍为 1」——只看本会话是否执行过会漏掉这条路径。
 */
function settleOnceTask(task: AutomationTask): AutomationTask {
  if (!task.onceAt || task.lastRun <= 0) return task;
  return { ...task, enabled: false };
}

/** 自动化：任务清单持久化（桌面真源 SQLite + localStorage 缓存）+ Run Now 下发 chat 管线。 */
export const useAutomationStore = defineStore("automation", () => {
  const list = ref<AutomationTask[]>([]);
  /** 运行记录（新→旧）；浏览器态来自 localStorage，桌面态由 SQLite 覆盖并含宿主兜底跑。 */
  const runs = ref<AutomationRunRow[]>([]);
  /** 会话存储：每条任务跑在自己的专属会话里（`auto-<taskId>`，见 ensureTaskSession）。 */
  const sessionStore = useSessionStore();
  /** 工作区存储：任务绑定的运行目录写在专属会话的 workspaceId 上（任务行不存该字段）。 */
  const workspaceStore = useWorkspaceStore();
  /** 浏览器态本地记录的合成 id（负数，绝不与库侧正整数自增 id 冲突）。 */
  let localRunSeq = -1;

  /** 专属会话的标题（跟着任务名走，改名即改会话标题）。 */
  function sessionTitle(task: AutomationTask): string {
    return t("automation.sessionTitle", { name: task.name });
  }

  /** 取/建任务专属会话（不激活）：任务的所有运行都落在这一条会话里，与用户当前对话完全隔离。 */
  function ensureTaskSession(task: AutomationTask): string {
    const id = taskSessionId(task.id);
    sessionStore.ensureUnactivated(id, sessionTitle(task));
    return id;
  }

  /** 任务专属会话当前绑定的工作区 id（编辑器回填用；未建会话 = null）。 */
  function taskWorkspaceId(id: string): string | null {
    return sessionStore.getSession(taskSessionId(id))?.workspaceId ?? null;
  }

  /**
   * 把任务绑定到某工作区：写在其专属会话的 `workspaceId` 上，**任务行不存该字段**。
   *
   * 已存在的会话也要改写绑定（`ensureUnactivated` 只在新建时落 workspaceId）；
   * `target` 仅作展示（列表 / 确认卡），与绑定同步以免两处口径漂移。
   */
  function setTaskWorkspace(id: string, workspaceId: string | null): void {
    const task = list.value.find((a) => a.id === id);
    if (!task) return;
    const session = sessionStore.ensureUnactivated(taskSessionId(id), sessionTitle(task), workspaceId);
    if (session.workspaceId !== workspaceId) {
      session.workspaceId = workspaceId;
      sessionStore.markDirty();
    }
    task.target = workspaceId
      ? (workspaceStore.workspaceById(workspaceId)?.name ?? t("automation.defaultTarget"))
      : t("automation.defaultTarget");
    persist();
  }

  /** 复制一条任务：新 id、名字加后缀、停用、未跑过；沿用原任务的工作区绑定。 */
  function duplicate(id: string): AutomationTask | null {
    const source = list.value.find((a) => a.id === id);
    if (!source) return null;
    const copy = add({
      name: t("automation.copyName", { name: source.name }),
      intent: source.intent,
      schedule: source.schedule,
      cron: source.cron ?? null,
      onceAt: source.onceAt ?? null,
      acpProviderId: source.acpProviderId ?? null,
      enabled: false,
      lastRun: 0,
    });
    const workspaceId = taskWorkspaceId(id);
    if (workspaceId) setTaskWorkspace(copy.id, workspaceId);
    return copy;
  }

  /** 批量启停：一次改多条并只落盘一次。 */
  function setManyEnabled(ids: readonly string[], enabled: boolean): void {
    const set = new Set(ids);
    for (const task of list.value) if (set.has(task.id)) task.enabled = enabled;
    persist();
  }

  /** 批量删除：连带各任务的专属会话一起删。 */
  function removeMany(ids: readonly string[]): void {
    const set = new Set(ids);
    for (const id of set) {
      const sessionId = taskSessionId(id);
      if (sessionStore.getSession(sessionId)) sessionStore.deleteSession(sessionId);
    }
    list.value = list.value.filter((a) => !set.has(a.id));
    persist();
  }

  /** 导出为 JSON 文本（含工作区绑定，导入端据此还原）。 */
  function exportJson(): string {
    const tasks = list.value.map((task) => ({ ...toRow(task), workspaceId: taskWorkspaceId(task.id) }));
    return JSON.stringify({ version: 1, tasks }, null, 2);
  }

  /**
   * 导入 JSON 文本：接受 `{ tasks: [...] }` 或裸数组。逐条校验（name/intent 必填、
   * cron 合法），全部以**新 id** 追加（避免与现有任务冲突），默认停用且未跑过。
   */
  function importJson(text: string): { added: number } | { error: string } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { error: t("automation.importInvalid") };
    }
    const rows = Array.isArray(parsed) ? parsed : (parsed as { tasks?: unknown } | null)?.tasks;
    if (!Array.isArray(rows)) return { error: t("automation.importInvalid") };
    let added = 0;
    for (const raw of rows) {
      if (typeof raw !== "object" || raw === null) continue;
      const row = raw as Record<string, unknown>;
      const name = typeof row.name === "string" && row.name.trim() ? row.name.trim() : null;
      const intent = typeof row.intent === "string" && row.intent.trim() ? row.intent.trim() : null;
      if (!name || !intent) continue;
      const cron = typeof row.cron === "string" && row.cron.trim() !== "" && validateCron(row.cron) === null ? row.cron : null;
      const onceAt = typeof row.onceAt === "number" && Number.isFinite(row.onceAt) ? row.onceAt : null;
      const acpProviderId = typeof row.acpProviderId === "string" && row.acpProviderId ? row.acpProviderId : null;
      const created = add({
        name,
        intent,
        schedule: typeof row.schedule === "string" && row.schedule.trim() ? row.schedule : t("automation.manualTrigger"),
        cron,
        onceAt,
        acpProviderId,
        enabled: false,
        lastRun: 0,
      });
      if (typeof row.workspaceId === "string" && row.workspaceId) setTaskWorkspace(created.id, row.workspaceId);
      added += 1;
    }
    if (added === 0) return { error: t("automation.importEmpty") };
    return { added };
  }

  function loadPersisted(): void {
    const saved = automationsStorage.read();
    const base = saved?.list && Array.isArray(saved.list) && saved.list.length ? saved.list : DEFAULT_AUTOMATIONS.map((a) => ({ ...a }));
    list.value = base.map((a) => ({ ...a, running: false }));
    const savedRuns = runsStorage.read();
    runs.value = Array.isArray(savedRuns?.runs) ? savedRuns.runs.slice(0, RUNS_CAP) : [];
  }
  loadPersisted();

  /** 桌面态启动接管：库已接管 → 库内容覆盖本地；未接管 → 本地种子作为真源首落库。 */
  const backendHydratePromise = (() => {
    if (!automationsBackend.active()) return null;
    return automationsBackend
      .load()
      .then((tasks) => {
        if (tasks) {
          // 库真源优先：running 瞬时态不落库，统一置 false
          list.value = tasks.map((task) => ({ ...task, running: false })).map(settleOnceTask);
        } else {
          persist(); // 首启：种子/缓存成为库真源
        }
        void refreshRuns(); // 库接管后运行记录以库为真源（含宿主无人值守兜底跑）
      })
      .catch((error: unknown) => {
        console.error("[automation] SQLite 加载失败，沿用本地缓存", error);
        notify({ kind: "warning", key: "automation-load", title: t("errors.automationSyncFailed"), detail: String(error) });
      });
  })();

  function persist(): void {
    automationsStorage.write({ list: list.value });
    if (automationsBackend.active()) {
      // 后端真源同步：失败不回滚内存（下次 persist 自愈）。
      void automationsBackend.save(list.value.map(toRow)).catch((error: unknown) => {
        console.error("[automation] SQLite 同步失败，将下次重试", error);
        notify({ kind: "error", key: "automation-sync", title: t("errors.automationSyncFailed"), detail: String(error) });
      });
    }
  }

  /** 运行记录落盘（浏览器态真源）；库侧由 runRecord 各自裁剪，这里只维护本地缓存。 */
  function persistRuns(): void {
    runsStorage.write({ runs: runs.value.slice(0, RUNS_CAP) });
  }

  /** 从库重载运行记录（含宿主兜底跑）；浏览器态无后端 → 保留本地。 */
  async function refreshRuns(): Promise<void> {
    if (!automationsBackend.active()) return;
    try {
      runs.value = await automationsBackend.runsLoad();
    } catch (error: unknown) {
      console.error("[automation] 运行记录加载失败", error);
    }
  }

  /**
   * 记一条运行结果：先本地即时入列（视图立刻可见），桌面态再落库并回读规范化
   * （库分配自增 id，且顺带并入宿主兜底跑）。失败不影响本地展示。
   */
  function recordRun(entry: Omit<AutomationRunRow, "id">): void {
    runs.value = [{ ...entry, id: localRunSeq }, ...runs.value].slice(0, RUNS_CAP);
    localRunSeq -= 1;
    persistRuns();
    if (automationsBackend.active()) {
      void automationsBackend
        .runRecord(entry)
        .then(() => refreshRuns())
        .catch((error: unknown) => {
          console.error("[automation] 运行记录同步失败", error);
        });
    }
  }

  function add(task?: Partial<AutomationTask>): AutomationTask {
    const item: AutomationTask = {
      id: uid(),
      name: "新建自动化任务",
      schedule: t("automation.manualTrigger"),
      cron: null,
      onceAt: null,
      acpProviderId: null,
      target: "未绑定工作区",
      intent: "生成一份周报",
      enabled: false,
      lastRun: 0,
      running: false,
      ...task,
    };
    list.value.unshift(item);
    persist();
    return item;
  }

  function remove(id: string): void {
    // 专属会话跟着任务一起删：任务没了，它的对话（与产物）不该留在会话列表里占位。
    const sessionId = taskSessionId(id);
    if (sessionStore.getSession(sessionId)) sessionStore.deleteSession(sessionId);
    list.value = list.value.filter((a) => a.id !== id);
    persist();
  }

  function setEnabled(id: string, enabled: boolean): void {
    const task = list.value.find((a) => a.id === id);
    if (task) {
      task.enabled = enabled;
      persist();
    }
  }

  function update(id: string, patch: Partial<AutomationTask>): void {
    const task = list.value.find((a) => a.id === id);
    if (task) {
      Object.assign(task, patch);
      // 改名时同步专属会话的标题，会话列表里不残留旧名字。
      if (patch.name !== undefined) {
        const sessionId = taskSessionId(id);
        if (sessionStore.getSession(sessionId)) sessionStore.renameSession(sessionId, sessionTitle(task));
      }
      persist();
    }
  }

  /* ===== 执行路由：本机模型管线 vs 指定 ACP 后端 =====
   * 任务绑定 acpProviderId 时走 ACP（带工具、按所选后端执行）；否则走既有 chat 管线。
   * ACP 在本应用是全局单会话（与对话页共用），到期执行会切换当前后端——这是既有
   * 架构约束，编辑器里已明示；换成按任务建会话是另一个量级的改造。 */
  type RunMode = "llm" | "acp";

  /** 任一条管线是否有回合在跑：两条管线共用同一会话视图，故调度上互斥。 */
  function turnActive(): boolean {
    const agent = useAgentStore();
    return useChatStore().busy || agent.acpBusy || agent.acpConnecting;
  }

  /**
   * 把指令交给执行后端，落到**任务专属线程**：本机模型走 chat 管线（submitTextIn 直写该线程，
   * 不碰 activeThreadId），ACP 先切后端再按线程派发。返回失败信息（null = 已成功下发）；
   * 后端被删 / 未启用 / 连不上都在这里落地。
   *
   * `retryable` 区分「配置错误」（后端被删/停用，重试无意义）与「瞬时错误」（连不上/暂不可用）。
   */
  async function dispatchIntent(
    threadId: string,
    acpProviderId: string | null,
    intent: string,
  ): Promise<{ failure: string; retryable: boolean } | null> {
    if (!acpProviderId) {
      useChatStore().submitTextIn(threadId, intent);
      return null;
    }
    const agent = useAgentStore();
    const provider = agent.agentProviders.find((candidate) => candidate.id === acpProviderId);
    if (!provider) return { failure: t("errors.acpNotSelected"), retryable: false };
    if (!provider.enabled) return { failure: t("errors.providerNotEnabled", { name: provider.name }), retryable: false };
    if (agent.selectedProviderId !== provider.id || !agent.routeToAcp) {
      const failure = await agent.activateAcpProvider(provider.id);
      if (failure) return { failure, retryable: true };
    }
    // threadId 使 ACP 回合入流到任务的专属会话：会话隔离检查认线程，acpSessionThreadId
    // 变了自然为该线程另起 ACP 会话（与用户自己的对话互不串上下文）。
    await agent.dispatchToAcp(intent, [], [], threadId);
    return null;
  }

  /* ===== 失败重试 =====
   * 只对**瞬时失败**（连不上 / 后端暂不可用）退避重试；配置类错误（后端被删/停用）
   * 立即失败——重试救不回配置，只会拖慢反馈。本机模型管线没有下发阶段失败，故不涉及重试。 */
  const MAX_ATTEMPTS = 3;
  /** attempt 1、2 失败后的退避（ms）；不足时取最后一档。 */
  const RETRY_BACKOFF_MS = [3_000, 10_000];

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** 带重试下发：返回最终失败文案（null = 成功）；重试后才成功时补一条恢复通知。 */
  async function dispatchWithRetry(threadId: string, acpProviderId: string | null, intent: string, label: string): Promise<string | null> {
    for (let attempt = 1; ; attempt += 1) {
      const result = await dispatchIntent(threadId, acpProviderId, intent);
      if (!result) {
        if (attempt > 1) {
          notify({ kind: "success", key: `automation-recovered-${label}`, title: t("automation.retryRecovered", { name: label }) });
        }
        return null;
      }
      if (!result.retryable || attempt >= MAX_ATTEMPTS) return result.failure;
      notify({
        kind: "warning",
        key: `automation-retry-${label}`,
        title: t("automation.retryScheduled", { name: label, attempt, total: MAX_ATTEMPTS }),
        detail: result.failure,
      });
      await delay(RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)]);
    }
  }

  /* ===== Run Now 在途跟踪 =====
   * 管线没有「本任务完成」回执，只有全局忙态 —— 所以用翻转检测近似：
   * 下发后忙态从 true → false 的一次翻转视为本次运行结束；另有 10 分钟保险丝兜底
   * （防忙态观察错位把任务永远钉在「运行中」）。一次只跑一个。 */
  const RUN_FUSE_MS = 10 * 60_000;
  let inflight: { id: string; mode: RunMode; sawBusy: boolean } | null = null;
  let fuseTimer: ReturnType<typeof setTimeout> | null = null;
  /** 最近一次 Run Now 下发的会话 id（视图「查看会话」入口）。 */
  const lastRunSessionId = ref<string | null>(null);

  function clearInflight(): void {
    if (fuseTimer !== null) {
      clearTimeout(fuseTimer);
      fuseTimer = null;
    }
    if (inflight) {
      const task = list.value.find((a) => a.id === inflight!.id);
      if (task) task.running = false;
      inflight = null;
    }
  }

  // 两条管线各自观察：本次运行只看自己那条的信号，别把另一条管线的忙碌当成自己的结束。
  watch(
    () => useChatStore().busy,
    (busy, wasBusy) => {
      const current = inflight;
      if (!current || current.mode !== "llm") return;
      if (busy) current.sawBusy = true;
      else if (wasBusy && current.sawBusy) clearInflight();
    },
  );

  watch(
    () => {
      const agent = useAgentStore();
      return agent.acpBusy || agent.acpConnecting;
    },
    (active, wasActive) => {
      const current = inflight;
      if (!current || current.mode !== "acp") return;
      if (active) current.sawBusy = true;
      else if (wasActive && current.sawBusy) clearInflight();
    },
  );

  /**
   * Run Now：把任务指令下发到它的执行后端，返回结果码供视图给即时反馈
   * （started / busy / missing）。running 置真直到管线忙完一轮或保险丝到期；
   * lastRun 在真正下发成功后回写（ACP 后端连不上不算跑过）。
   */
  function runNow(id: string): "started" | "busy" | "missing" {
    const task = list.value.find((a) => a.id === id);
    if (!task) return "missing";
    if (turnActive() || inflight !== null) return "busy";
    // 专属会话：任务跑在 auto-<id> 里，不占用/不顶掉用户当前正在看的会话。
    const threadId = ensureTaskSession(task);
    task.enabled = true;
    task.running = true;
    lastRunSessionId.value = threadId;
    inflight = { id, mode: task.acpProviderId ? "acp" : "llm", sawBusy: false };
    fuseTimer = setTimeout(() => {
      fuseTimer = null;
      clearInflight();
    }, RUN_FUSE_MS);
    const mode: AutomationRunRow["mode"] = task.acpProviderId ? "acp" : "llm";
    void dispatchWithRetry(threadId, task.acpProviderId ?? null, task.intent, task.name).then((failure) => {
      if (!failure) {
        task.lastRun = Date.now();
        recordRun({
          taskId: id,
          name: task.name,
          status: "success",
          detail: null,
          sessionId: threadId,
          mode,
          ranAt: task.lastRun,
        });
      } else {
        clearInflight();
        recordRun({ taskId: id, name: task.name, status: "failed", detail: failure, sessionId: null, mode, ranAt: Date.now() });
        notify({
          kind: "error",
          key: "automation-run-failed",
          title: t("errors.automationRunFailed"),
          detail: `${task.name}：${failure}`,
        });
      }
      persist();
    });
    persist();
    return "started";
  }

  /* ===== 宿主到期队列（automation_due 表）消费 =====
   * 可靠化语义：到期任务由宿主持久化入队并广播唤醒；渲染端单消费循环
   * 拉取（60min 窗口）逐条执行 finish。busy 不丢不跳——任务留在队列，
   * 由 30s 轮询/due 事件唤醒补跑；webview reload 期间积压任务 hydrate
   * 后补跑。取代旧「busy 跳过记 lastRun 假成功、广播丢失即丢」语义。 */
  /** 队列轮询间隔（ms）：与宿主 tick 同频；busy 结束的任务最多延迟一轮执行。 */
  const DUE_POLL_MS = 30_000;

  /** 消费循环互斥（防重入双跑）。 */
  let consuming = false;

  type DueExecResult = "done" | "busy" | "missing" | "failed";

  /**
   * 执行一条到期任务：任一条管线忙 → busy（任务保留队列下轮重试）；任务已不在
   * 清单 → missing（防御分支，正常由库级联删除）；执行后端不可用 → failed。
   * 执行后端取自队列快照（入队时刻的选择），与 intent 同源。
   */
  async function executeDue(row: AutomationDueRow): Promise<DueExecResult> {
    if (turnActive()) return "busy";
    const task = list.value.find((a) => a.id === row.taskId);
    if (!task) return "missing";
    const mode: AutomationRunRow["mode"] = row.acpProviderId ? "acp" : "llm";
    // 专属会话：到期执行同样落在 auto-<taskId> 那条会话里，不挤进用户当前对话。
    const threadId = ensureTaskSession(task);
    const failure = await dispatchWithRetry(threadId, row.acpProviderId, row.intent, row.name);
    if (failure) {
      recordRun({ taskId: row.taskId, name: row.name, status: "failed", detail: failure, sessionId: null, mode, ranAt: Date.now() });
      notify({
        kind: "error",
        key: "automation-run-failed",
        title: t("errors.automationRunFailed"),
        detail: `${row.name}：${failure}`,
      });
      return "failed";
    }
    task.enabled = true;
    task.lastRun = Date.now();
    recordRun({
      taskId: row.taskId,
      name: row.name,
      status: "success",
      detail: null,
      sessionId: threadId,
      mode,
      ranAt: task.lastRun,
    });
    // 一次性任务跑完即停用：宿主调度器只按 (onceAt, last_run) 判定，留 enabled=1
    // 会让界面继续显示「已启用」，下次改这条任务时也容易误以为还会再跑。
    if (task.onceAt) task.enabled = false;
    persist();
    return "done";
  }

  /**
   * 消费到期队列：拉 pending（60min 窗口）逐条执行；busy/空即停。
   * 公开导出供测试、due 事件与轮询复用。
   */
  async function consumeDue(): Promise<void> {
    if (consuming) return;
    consuming = true;
    try {
      for (;;) {
        const due = await automationsBackend.dueList();
        if (!due || due.length === 0) break;
        const result = await executeDue(due[0]);
        if (result !== "busy") {
          // done/missing/failed 都收尾（missing 无 task 可跑，标 failed 不留死队列）
          await automationsBackend.dueFinish(due[0].id, result === "done" ? "success" : "failed");
        }
        if (result !== "done") break;
      }
    } catch (error: unknown) {
      console.error("[automation] 到期队列消费失败", error);
      notify({ kind: "error", key: "automation-due", title: t("errors.automationRunFailed"), detail: String(error) });
    } finally {
      // 每轮消费后从库回读运行记录，把宿主无人值守兜底跑并入视图。
      void refreshRuns();
      consuming = false;
    }
  }

  // 桌面态：监听宿主 tick 广播唤醒 + 30s 轮询兜底 + hydrate 后补跑积压。
  // 浏览器态无后端（无 tick/队列），全部跳过。
  if (automationsBackend.active()) {
    void listen<AutomationDuePayload>("automation://due", () => {
      void consumeDue();
    }).catch((error: unknown) => {
      console.error("[automation] due 事件监听失败", error);
      notify({ kind: "warning", key: "automation-due-listen", title: t("errors.automationSyncFailed"), detail: String(error) });
    });
    setInterval(() => {
      void consumeDue();
    }, DUE_POLL_MS);
    if (backendHydratePromise) {
      void backendHydratePromise.then(() => {
        void consumeDue();
      });
    }
  }

  return {
    list,
    runs,
    lastRunSessionId,
    recordRun,
    refreshRuns,
    add,
    remove,
    setEnabled,
    update,
    duplicate,
    setManyEnabled,
    removeMany,
    exportJson,
    importJson,
    setTaskWorkspace,
    runNow,
    consumeDue,
    /** 任务专属会话 id（auto-<taskId>）；给视图「查看会话」用。 */
    taskSessionId,
    /** 任务专属会话绑定的工作区 id；给编辑器回填用。 */
    taskWorkspaceId,
    /** 桌面态启动接管完成信号（null = 浏览器态无后端）。 */
    hydrated: backendHydratePromise,
  };
});
