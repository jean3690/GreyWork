import {
  buildPlanPrompt,
  createPlannerRun,
  createSubtask,
  parsePlan,
  type AgentRole,
  type PlannerRun,
  type Subtask,
} from "@greywork/agents";
import { createJsonStorage } from "@greywork/core";
import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { acp } from "../lib/acp-client";
import { teamRunsBackend, type TeamRunRow } from "../lib/team-runs-backend";
import { resolveWorkspaceDir } from "../lib/workspace-dir";
import { parseToolActivityPayload } from "../lib/tool-activity";
import { appEvents } from "../events";
import { i18n } from "../i18n";
import { useAgentStore, type RunEventBridge } from "./agent";
import { useChatStore } from "./chat";
import { useSettingsStore } from "./settings";

const t = i18n.global.t;

/** 编排存档上限：超出丢最旧（防 localStorage/库无限膨胀）。 */
const MAX_ARCHIVED_RUNS = 50;
const RUNS_STORAGE_KEY = "greywork.agent-runs";
const runsStorage = createJsonStorage<{ runs: PlannerRun[] }>(
  RUNS_STORAGE_KEY,
  (value): value is { runs: PlannerRun[] } =>
    typeof value === "object" && value !== null && Array.isArray((value as { runs?: unknown }).runs),
);

/** Agent 并行编排：planner 分解 → 子任务并行派发（TeamView 看板数据源）。
 *  单向依赖 agent（ACP 会话域）：provider 解析与 planner 全局回合均经 agentStore；
 *  子任务事件流由 agent 监听器按 RunEventBridge 路由回本域（本域不注册 acp 监听）。 */
export const useRunsStore = defineStore("runs", () => {
  const chat = useChatStore();
  const settings = useSettingsStore();
  const agentStore = useAgentStore();

  /** 活跃编排运行（最新在前）；TeamView 看板数据源。 */
  const runs = ref<PlannerRun[]>([]);
  /** 已结束运行存档（内存镜像 = localStorage / SQLite 内容；结束即追加）。 */
  const archivedRuns = ref<PlannerRun[]>([]);

  /** 结束运行入档：同 id 幂等；超上限丢最旧；随后双写持久化。 */
  function archiveRun(run: PlannerRun): void {
    if (archivedRuns.value.some((candidate) => candidate.id === run.id)) return;
    archivedRuns.value.push(run);
    if (archivedRuns.value.length > MAX_ARCHIVED_RUNS) {
      archivedRuns.value.splice(0, archivedRuns.value.length - MAX_ARCHIVED_RUNS);
    }
    persistArchivedRuns();
  }

  function persistArchivedRuns(): void {
    runsStorage.write({ runs: archivedRuns.value });
    if (teamRunsBackend.active()) {
      const rows: TeamRunRow[] = archivedRuns.value.map((run) => ({ id: run.id, payload: run }));
      void teamRunsBackend.save(rows).catch((error: unknown) => {
        console.error("[runs] 编排存档同步失败，将下次重试", error);
      });
    }
  }

  /** 桌面态启动接管：库存档 → 并入 runs 列表（历史在活跃之后）；未接管 → 本地缓存首落库。 */
  const runsHydrated: Promise<void> | null = (() => {
    const cached = runsStorage.read();
    if (cached?.runs.length) {
      archivedRuns.value = cached.runs;
      for (const run of cached.runs) {
        if (!runs.value.some((candidate) => candidate.id === run.id)) runs.value.push(run);
      }
    }
    if (!teamRunsBackend.active()) return null;
    return teamRunsBackend
      .load()
      .then((rows) => {
        if (rows) {
          const archived = rows.map((row) => row.payload as PlannerRun).filter((run) => run && typeof run.id === "string");
          archivedRuns.value = archived;
          for (const run of archived) {
            if (!runs.value.some((candidate) => candidate.id === run.id)) runs.value.push(run);
          }
        } else {
          persistArchivedRuns(); // 首启：本地缓存/空存档成为库真源（写接管标记）
        }
      })
      .catch((error: unknown) => {
        console.error("[runs] 编排存档加载失败，沿用本地缓存", error);
      });
  })();
  /**
   * 并行子任务上限：每个子任务一个独立 ACP 进程，避免资源失控。
   * 取自设置项（可在 team 设置页调整），改 computed 后自动传导到 cowork 引擎
   * （stores/cowork.ts 传的是 `() => runsStore.maxParallel`，engine 每次求值）。
   */
  const maxParallel = computed(() => settings.maxParallel);
  /** 子任务会话映射：subtaskId → 独立 handle/session 与支架定位。 */
  interface SubtaskSession {
    handle: number;
    sessionId: string;
    threadId: string;
    messageId: string;
  }
  const subtaskSessions = new Map<string, SubtaskSession>();
  /** 子任务完成回执：prompt-done（按 handle 路由）时 resolve，驱动并发泵。 */
  const subtaskPending = new Map<string, { resolve: () => void }>();
  /** planner 回合在途的 run（agent 侧 turnHooks 经 hook ctx 回调；此标记用于配对 + 悬置守卫）。 */
  let plannerCtx: { run: PlannerRun } | null = null;
  let subtaskRunning = 0;
  const subtaskQueue: { run: PlannerRun; sub: Subtask }[] = [];
  /** fallback mock 编排的定时器（与 chat.clearSim 对齐）。 */
  let orchestrationTimers: ReturnType<typeof setTimeout>[] = [];

  function findSubtaskByHandle(handle: number): { run: PlannerRun; sub: Subtask; session: SubtaskSession } | null {
    for (const [subId, session] of subtaskSessions) {
      if (session.handle === handle) {
        const run = runs.value.find((candidate) => candidate.subtasks.some((s) => s.id === subId));
        const sub = run?.subtasks.find((s) => s.id === subId);
        if (run && sub) return { run, sub, session };
      }
    }
    return null;
  }

  function checkRunDone(run: PlannerRun): void {
    if (run.subtasks.some((s) => s.status === "pending" || s.status === "running")) return;
    const failed = run.subtasks.some((s) => s.status === "failed");
    const wasFinal = run.status === "done" || run.status === "failed";
    run.status = failed ? "failed" : "done";
    run.finishedAt = Date.now();
    publishRunStatus(run);
    if (!wasFinal) archiveRun(run); // 结束存档（幂等：终态只入档一次）
  }

  /** 发布编排状态变化事件（异步任务完成通知；通知系统/状态栏等可订阅）。 */
  function publishRunStatus(run: PlannerRun): void {
    appEvents.emit("run:status", {
      runId: run.id,
      status: run.status,
      done: run.subtasks.filter((s) => s.status === "done").length,
      total: run.subtasks.length,
    });
  }

  /** 单子任务独立会话派发；完成完全由 prompt-done 事件（按 handle 路由）驱动。 */
  async function runSubtask(run: PlannerRun, sub: Subtask): Promise<void> {
    sub.status = "running";
    let handle: number;
    try {
      const provider = agentStore.agentProviders.find((provider) => provider.id === agentStore.selectedProviderId);
      if (!provider) throw new Error(t("errors.acpNotSelected"));
      const workspace = await resolveWorkspaceDir();
      handle = await acp.startAgent(provider.command, settings.effectivePermissionTier, settings.sandboxMode, workspace);
      const { sessionId } = await acp.openSession(handle, workspace, settings.enabledMcpServers);
      const { threadId, message } = chat.startAcpTurn(sub.prompt, sub.role);
      subtaskSessions.set(sub.id, { handle, sessionId, threadId, messageId: message.id });
    } catch (error) {
      sub.status = "failed";
      sub.error = String(error);
      checkRunDone(run);
      return;
    }
    // 回执：prompt-done / 取消 / prompt 层错误任一先到即解除，驱动并发泵。
    const pending = new Promise<void>((resolve) => {
      subtaskPending.set(sub.id, { resolve });
    });
    // 发起 prompt，不 await 其返回值（agent 回合结束经事件路由完成，避免进程级时序竞态）。
    acp.prompt(handle, sub.prompt).catch((error) => {
      if (subtaskSessions.has(sub.id)) {
        sub.status = "failed";
        sub.error = String(error);
        subtaskSessions.delete(sub.id);
        checkRunDone(run);
      }
      subtaskPending.get(sub.id)?.resolve();
      subtaskPending.delete(sub.id);
    });
    await pending;
  }

  function finishSubtask(run: PlannerRun, sub: Subtask, session: SubtaskSession, error?: string): void {
    const errorText = error?.trim() ?? "";
    // 空内容兜底 + 回收子任务进程。失败回合（error 有值）落失败文案并如实标记 failed，
    // 而不是「无文本输出 + done」——挂掉的后端不该被算成完成。
    const message = chat.threads[session.threadId]?.find((candidate) => candidate.id === session.messageId);
    if (message && errorText) {
      const text = t("chat.llmCallFailed", { detail: errorText });
      if (!message.content.trim()) chat.setMessageContent(message.id, text, session.threadId);
      else {
        chat.appendMessageContent(message.id, `\n\n${text}`, session.threadId);
        chat.flushPendingContent();
      }
      sub.error = errorText;
    } else if (message && !message.content.trim()) {
      chat.setMessageContent(message.id, t("chat.noOutput"), session.threadId);
    }
    sub.status = errorText ? "failed" : "done";
    subtaskSessions.delete(sub.id);
    void Promise.resolve(acp.stop(session.handle)).catch(() => undefined);
    checkRunDone(run);
  }

  /** 并发泵：保持活跃子任务 ≤ maxParallel，逐个从队列拉起。 */
  function pumpSubtasks(): void {
    while (subtaskRunning < maxParallel.value && subtaskQueue.length > 0) {
      const next = subtaskQueue.shift();
      if (!next) break;
      subtaskRunning += 1;
      void runSubtask(next.run, next.sub).finally(() => {
        subtaskRunning -= 1;
        pumpSubtasks();
      });
    }
  }

  function kickSubtasks(run: PlannerRun): void {
    for (const sub of run.subtasks) subtaskQueue.push({ run, sub });
    pumpSubtasks();
  }

  /* ===== Replan：执行中调整计划（取消 / 重试 / 追加子任务） ===== */

  function findRun(runId: string): PlannerRun | undefined {
    return runs.value.find((candidate) => candidate.id === runId);
  }

  /** 取消子任务：pending 直接出队；running 先停进程并解除回执（避免 runSubtask 挂起）。 */
  async function cancelSubtask(runId: string, subId: string): Promise<void> {
    const run = findRun(runId);
    const index = run?.subtasks.findIndex((candidate) => candidate.id === subId);
    if (!run || index === undefined || index < 0) return;
    run.subtasks.splice(index, 1);
    const queueIndex = subtaskQueue.findIndex((entry) => entry.sub.id === subId);
    if (queueIndex >= 0) subtaskQueue.splice(queueIndex, 1);
    const session = subtaskSessions.get(subId);
    if (session) {
      subtaskSessions.delete(subId);
      subtaskPending.get(subId)?.resolve();
      subtaskPending.delete(subId);
      void Promise.resolve(acp.stop(session.handle)).catch(() => undefined);
    }
    checkRunDone(run);
  }

  /** 重试失败子任务：重置为 pending 重新入队，run 恢复 running。 */
  function retrySubtask(runId: string, subId: string): void {
    const run = findRun(runId);
    const sub = run?.subtasks.find((candidate) => candidate.id === subId);
    if (!run || !sub || sub.status !== "failed") return;
    sub.status = "pending";
    sub.error = undefined;
    run.status = "running";
    run.finishedAt = undefined;
    publishRunStatus(run);
    subtaskQueue.push({ run, sub });
    pumpSubtasks();
  }

  /** 追加子任务（replan）：并入队；run 已结束（done/failed）时恢复 running。 */
  function addSubtask(runId: string, role: AgentRole, prompt: string): void {
    const run = findRun(runId);
    if (!run) return;
    const sub = createSubtask(role, prompt);
    run.subtasks.push(sub);
    if (run.status === "done" || run.status === "failed") {
      run.status = "running";
      run.finishedAt = undefined;
      publishRunStatus(run);
    }
    subtaskQueue.push({ run, sub });
    pumpSubtasks();
  }

  /** 无 ACP 后端时的演示降级：mock 时间线顺序推进两个子任务。 */
  function fallbackRunMock(run: PlannerRun): void {
    run.subtasks = [
      { id: "sub-1", role: "builder", prompt: run.goal, status: "pending" },
      { id: "sub-2", role: "reviewer", prompt: `审查「${run.goal}」的产出`, status: "pending" },
    ];
    run.status = "running";
    publishRunStatus(run);
    let delay = 150;
    for (const sub of [...run.subtasks]) {
      orchestrationTimers.push(setTimeout(() => (sub.status = "running"), delay));
      delay += 300;
      orchestrationTimers.push(
        setTimeout(() => {
          sub.status = "done";
          checkRunDone(run);
        }, delay),
      );
      delay += 100;
    }
  }

  /**
   * 编排意图识别入口：输入以「自动执行 / 编排」开头（可带冒号）时触发并行编排并返回 true；
   * 其余输入返回 false（调用方走普通管线）。Local 模式聊天框与 Guid 输入共用。
   */
  function maybeOrchestrate(input: string): boolean {
    const trimmed = input.trim();
    const matched = /^(?:自动执行|编排)[:：]?\s*(.*)$/.exec(trimmed);
    if (!matched) return false;
    const goal = matched[1]?.trim() || trimmed;
    void dispatchRun(goal);
    return true;
  }

  /** 编排入口：planner 分解 → 并行执行（maxParallel）。
   *  planner 阶段复用 agent 全局会话发回合（经 sendGlobalTurn），回合终局由 hooks 回调本域解析计划。 */
  async function dispatchRun(goal: string): Promise<void> {
    const run = createPlannerRun(goal);
    runs.value.unshift(run);
    publishRunStatus(run);
    const provider = agentStore.agentProviders.find((provider) => provider.id === agentStore.selectedProviderId);
    if (!acp.isAvailable() || !provider || !provider.enabled) {
      fallbackRunMock(run);
      return;
    }
    if (agentStore.acpBusy) {
      // 防御：全局回合在途时拒绝叠回合（原实现无守卫；真实 UI 入口 busy 时不会触发编排）。
      run.status = "failed";
      run.finishedAt = Date.now();
      publishRunStatus(run);
      return;
    }
    const failure = await agentStore.connectAcp();
    if (failure) {
      run.status = "failed";
      run.finishedAt = Date.now();
      publishRunStatus(run);
      return;
    }
    const text = buildPlanPrompt(run.goal);
    plannerCtx = { run };
    await agentStore.sendGlobalTurn(text, "planner", {
      reuseGlobalSession: true, // 编排路径先 connectAcp，不做「会话归属线程」隔离检查（与旧 dispatchRun 一致）
      hooks: {
        preserveThought: true,
        onPromptError: (ctx) => {
          plannerCtx = null;
          run.status = "failed";
          run.finishedAt = Date.now();
          publishRunStatus(run);
          chat.setMessageContent(ctx.messageId, `[Planner 失败] ${String(ctx.error)}`, ctx.threadId);
          return true; // 已自写支架文案，跳过默认 [ACP 派发失败]
        },
        onPromptDone: (ctx) => {
          // agent 已完成脚手架收尾（noOutput 兜底 / 清场）；悬置守卫：clearOrchestration 后不再消费
          if (plannerCtx?.run !== run) return;
          plannerCtx = null;
          const message = chat.threads[ctx.threadId]?.find((candidate) => candidate.id === ctx.messageId);
          const plan = parsePlan(message?.content ?? "");
          if (plan) {
            run.subtasks = plan;
            run.status = "running";
            publishRunStatus(run);
            kickSubtasks(run);
          } else {
            run.status = "failed";
            run.finishedAt = Date.now();
            publishRunStatus(run);
            if (message) chat.appendMessageContent(ctx.messageId, `\n\n${t("agents.planFailed")}`, ctx.threadId);
            chat.flushPendingContent();
          }
        },
      },
    });
  }

  function clearOrchestration(): void {
    orchestrationTimers.forEach(clearTimeout);
    orchestrationTimers = [];
    subtaskQueue.length = 0;
    for (const [, pending] of subtaskPending) pending.resolve();
    subtaskPending.clear();
    for (const session of subtaskSessions.values()) void Promise.resolve(acp.stop(session.handle)).catch(() => undefined);
    subtaskSessions.clear();
    plannerCtx = null;
  }

  /* ===== 事件桥：agent 监听器把子任务事件路由回本域（本域不注册 acp 监听） ===== */

  const runBridge: RunEventBridge = {
    /** session-update：sessionId 命中子任务会话即写独立支架（工具时间线 + chunk 文本），与旧 routed 分支逐行对齐。 */
    routeSessionUpdate: (payload) => {
      const parsed = payload as { sessionId?: unknown; update?: { sessionUpdate?: string; content?: { text?: string } } };
      if (typeof parsed.sessionId !== "string") return false;
      let target: SubtaskSession | undefined;
      for (const session of subtaskSessions.values()) {
        if (session.sessionId === parsed.sessionId) {
          target = session;
          break;
        }
      }
      if (!target) return false;
      // 解析 agent_message 中携带的工具调用部分（read/edit/bash/search …），并入子任务支架的 tools 时间线。
      const toolActivities = parseToolActivityPayload(payload);
      if (toolActivities.length > 0) chat.appendTools(toolActivities, target.messageId, target.threadId);
      if (parsed.update?.sessionUpdate === "agent_message_chunk") {
        const text = parsed.update.content?.text ?? "";
        if (text) chat.appendMessageContent(target.messageId, text, target.threadId);
      }
      return true;
    },
    /** prompt-done：按 handle 命中子任务 → finishSubtask + 解除回执（驱动并发泵）。error = 回合失败原因。 */
    routeSubtaskDone: (handle, error) => {
      const entry = findSubtaskByHandle(handle);
      if (!entry) return false;
      const { run, sub, session } = entry;
      finishSubtask(run, sub, session, error);
      subtaskPending.get(sub.id)?.resolve();
      subtaskPending.delete(sub.id);
      return true;
    },
    /** 在途子任务句柄：agent 推档位（applyPermissionTier）时一并同步。 */
    collectActiveHandles: () => [...subtaskSessions.values()].map((session) => session.handle),
  };
  agentStore.attachRunBridge(runBridge);

  return {
    runs,
    /** 编排存档启动接管完成信号（null = 浏览器态无后端）；await 后历史已并入 runs。 */
    runsHydrated,
    maxParallel,
    dispatchRun,
    maybeOrchestrate,
    cancelSubtask,
    retrySubtask,
    addSubtask,
    clearOrchestration,
  };
});
