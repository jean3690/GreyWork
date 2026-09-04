import {
  AGENT_ROLES,
  MOCK_AGENTS,
  buildPlanPrompt,
  createPlannerRun,
  createSubtask,
  parsePlan,
  type AgentRole,
  type PlannerRun,
  type Subtask,
} from "@greywork/agents";
import {
  createAcpClient,
  type AcpPermissionRequestPayload,
  type AcpSessionConfigOption,
  type McpProbeReport,
  type McpServerConfig,
  type McpSkippedServer,
} from "@greywork/acp";
import { createJsonStorage } from "@greywork/core";
import { createAgentProviderRegistry, type AgentProviderConfig } from "@greywork/shell";
import { agentsBackend, type AgentProviderRow } from "../lib/agents-backend";
import { teamRunsBackend, type TeamRunRow } from "../lib/team-runs-backend";
import { defineStore } from "pinia";
import { ref, watch } from "vue";
import { useChatStore } from "./chat";
import { useSettingsStore } from "./settings";
import { useWorkspaceStore } from "./workspace";
import { i18n } from "../i18n";
import { appEvents } from "../events";
import { parseToolActivityPayload } from "../lib/tool-activity";
import type { ThreadMessage } from "../types";
import { resolveWorkspaceDir } from "../lib/workspace-dir";
import { activeConversationFolder } from "../lib/conversation-folder";

const t = i18n.global.t;

export interface WorkflowStep {
  id: string;
  label: string;
  status: "wait" | "active" | "done";
  desc: string;
}

const acp = createAcpClient();

/** 编排存档上限：超出丢最旧（防 localStorage/库无限膨胀）。 */
const MAX_ARCHIVED_RUNS = 50;
const RUNS_STORAGE_KEY = "greywork.agent-runs";
const runsStorage = createJsonStorage<{ runs: PlannerRun[] }>(
  RUNS_STORAGE_KEY,
  (value): value is { runs: PlannerRun[] } =>
    typeof value === "object" && value !== null && Array.isArray((value as { runs?: unknown }).runs),
);

const PROVIDERS_STORAGE_KEY = "greywork.agent-providers";
const providersStorage = createJsonStorage<{ providers: AgentProviderConfig[] }>(
  PROVIDERS_STORAGE_KEY,
  (value): value is { providers: AgentProviderConfig[] } =>
    typeof value === "object" && value !== null && Array.isArray((value as { providers?: unknown }).providers),
);

/** 后端选择偏好（场景一 Guid 预选持久化）：provider id；null = Local LLM。 */
interface ProviderPreference {
  providerId: string | null;
}
const providerPrefStorage = createJsonStorage<ProviderPreference>(
  "greywork.acp-provider",
  (value): value is ProviderPreference => typeof value === "object" && value !== null && "providerId" in value,
);

/** Agent 编排：编队 / 流水线 / 循环策略 / ACP 后端派发（AgentsView 与 Chat·Cowork 数据源）。 */
export const useAgentStore = defineStore("agent", () => {
  const settings = useSettingsStore();
  const chat = useChatStore();
  const workspaceStore = useWorkspaceStore();
  const agents = ref(MOCK_AGENTS.map((agent) => ({ ...agent })));
  const roles = ref(AGENT_ROLES);
  const workflowSteps = ref<WorkflowStep[]>([
    { id: "collect", label: "agents.pipeline.collect.label", status: "done", desc: "agents.pipeline.collect.desc" },
    { id: "analyze", label: "agents.pipeline.analyze.label", status: "active", desc: "agents.pipeline.analyze.desc" },
    { id: "report", label: "agents.pipeline.report.label", status: "wait", desc: "agents.pipeline.report.desc" },
    { id: "review", label: "agents.pipeline.review.label", status: "wait", desc: "agents.pipeline.review.desc" },
  ]);

  /* ===== ACP 后端（工作台接入） ===== */
  const agentProviderRegistry = createAgentProviderRegistry();
  const cachedProviders = providersStorage.read()?.providers;
  const agentProviders = ref<AgentProviderConfig[]>(cachedProviders ?? agentProviderRegistry.list());
  const savedPref = providerPrefStorage.read();
  const savedProvider = savedPref?.providerId ? agentProviders.value.find((provider) => provider.id === savedPref?.providerId) : undefined;
  const selectedProviderId = ref<string>(savedProvider?.id ?? agentProviders.value[0]?.id ?? "");
  /** 恢复上次选择：偏好 ACP agent → 预选但不连接（发送时才起 runtime）；Local → 默认。 */
  const routeToAcp = ref(Boolean(savedProvider?.enabled));

  const acpBusy = ref(false);
  const acpHandle = ref<number | null>(null);
  const acpSessionId = ref<string | null>(null);
  /** 待前端裁决的权限请求；null = 无待决项（auto 决策只进通知流） */
  const pendingPermission = ref<AcpPermissionRequestPayload | null>(null);
  /** 当前 ACP 回合写入中的 assistant 支架（chat.threads 内），流式续写目标。 */
  let acpStream: ThreadMessage | null = null;
  /** 当前 ACP 回合所在线程 id（与 acpStream 成对；流式续写不依赖 activeThreadId）。 */
  let acpThreadId: string | null = null;
  /** 流式支架的 message id（ChatView 据此切换 StreamText 渲染）。 */
  const acpStreamId = ref<string | null>(null);
  /** 事件监听只挂一次 */
  let listening = false;
  /** 连接中标记：connectAcp 防重入。 */
  const acpConnecting = ref(false);
  /** 当前会话的配置选择器（模型 / 推理力度 / 会话模式等）；空 = agent 未暴露。 */
  const acpConfigOptions = ref<AcpSessionConfigOption[]>([]);
  /** 上次建会话时实际声明给 agent 的 MCP 服务器名。 */
  const acpMcpServers = ref<string[]>([]);
  /** 上次建会话时被跳过的 MCP 服务器（能力不匹配 / 配置不全），设置页据此明示原因。 */
  const acpMcpSkipped = ref<McpSkippedServer[]>([]);
  /** ACP runtime 已连接（有 agent 进程 + 会话）；供 UI 显示重启/选择器。 */
  const acpConnected = ref(false);

  /** ACP 连接状态机（对齐 GreyWork acpStatus）：null=未启动 → connecting → connected → session_active → disconnected | error。 */
  const acpStatus = ref<"connecting" | "connected" | "session_active" | "disconnected" | "error" | null>(null);
  /** 在途回合 id：acp.prompt 立即返回，stop 时按 turnId 精确取消单回合（进程保留）。 */
  const activeTurnId = ref<number | null>(null);
  /** 在途回合起点（epoch ms）；跨会话切换存活（模块级时钟，对齐 GreyWork conversationTurnClock）。 */
  const turnStartedAtMs = ref<number | null>(null);
  /** 最近一次 usage 快照（usage 事件）；null = agent 未上报。 */
  const acpUsage = ref<{ used: number; size: number; cost?: { amount: number; currency: string } } | null>(null);
  /** 最近一次 thinking 流文本（thought 事件聚合）；回合结束保留供检查。 */
  const acpThoughtText = ref("");
  /** slash 命令目录（commands 事件）；当前无 UI 消费，仅透传。 */
  const acpCommands = ref<unknown[]>([]);

  /* ===== 并行编排（方案 1：planner 分解 → 子任务并行派发） ===== */
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
        console.error("[agent] 编排存档同步失败，将下次重试", error);
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
        console.error("[agent] 编排存档加载失败，沿用本地缓存", error);
      });
  })();
  /** 并行子任务上限：每个子任务一个独立 ACP 进程，避免资源失控。 */
  const maxParallel = ref(2);
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
  /** planner 回合进行中；prompt-done 全局分支据此解析计划并启动队列。 */
  let plannerPending: { run: PlannerRun; threadId: string; messageId: string } | null = null;
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
      const provider = agentProviders.value.find((provider) => provider.id === selectedProviderId.value);
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

  function finishSubtask(run: PlannerRun, sub: Subtask, session: SubtaskSession): void {
    // 空内容兜底 + 回收子任务进程
    const message = chat.threads[session.threadId]?.find((candidate) => candidate.id === session.messageId);
    if (message && !message.content.trim()) chat.setMessageContent(message.id, t("chat.noOutput"), session.threadId);
    sub.status = "done";
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

  /** 编排入口：planner 分解 → 并行执行（maxParallel）。 */
  async function dispatchRun(goal: string): Promise<void> {
    const run = createPlannerRun(goal);
    runs.value.unshift(run);
    publishRunStatus(run);
    const provider = agentProviders.value.find((provider) => provider.id === selectedProviderId.value);
    if (!acp.isAvailable() || !provider || !provider.enabled) {
      fallbackRunMock(run);
      return;
    }
    const failure = await connectAcp();
    if (failure) {
      run.status = "failed";
      run.finishedAt = Date.now();
      publishRunStatus(run);
      return;
    }
    const text = buildPlanPrompt(run.goal);
    const { threadId, message } = chat.startAcpTurn(text, "planner");
    acpStream = message;
    acpThreadId = threadId;
    acpStreamId.value = message.id;
    acpBusy.value = true;
    turnStartedAtMs.value = Date.now();
    plannerPending = { run, threadId, messageId: message.id };
    try {
      const { turnId } = await acp.prompt(acpHandle.value as number, text);
      activeTurnId.value = turnId;
    } catch (error) {
      activeTurnId.value = null;
      turnStartedAtMs.value = null;
      plannerPending = null;
      run.status = "failed";
      run.finishedAt = Date.now();
      publishRunStatus(run);
      chat.setMessageContent(message.id, `[Planner 失败] ${String(error)}`, threadId);
      acpStream = null;
      acpThreadId = null;
      acpStreamId.value = null;
      acpBusy.value = false;
    }
  }

  function clearOrchestration(): void {
    orchestrationTimers.forEach(clearTimeout);
    orchestrationTimers = [];
    subtaskQueue.length = 0;
    for (const [, pending] of subtaskPending) pending.resolve();
    subtaskPending.clear();
    for (const session of subtaskSessions.values()) void Promise.resolve(acp.stop(session.handle)).catch(() => undefined);
    subtaskSessions.clear();
    plannerPending = null;
  }

  async function ensureListener(): Promise<void> {
    if (listening) return;
    listening = true;
    await acp.onEvent((event) => {
      if (event.kind === "session-update") {
        const payload = event.payload as {
          sessionId?: string;
          update?: { sessionUpdate?: string; content?: { text?: string } };
        };
        // 宿主发出的是 camelCase sessionId（ACP schema 的 serde 约定）。此前这里读
        // snake_case，按 sessionId 的子任务路由从不命中，并行子任务的增量全涌进全局支架。
        const routed = payload.sessionId
          ? [...subtaskSessions.values()].find((session) => session.sessionId === payload.sessionId)
          : undefined;
        // 解析 agent_message 中携带的工具调用部分（read/edit/bash/search …），
        // 并入对应消息的 tools 时间线 —— 前端「工具聚合时间线」数据源。
        const toolActivities = parseToolActivityPayload(event.payload);
        if (toolActivities.length > 0) {
          if (routed) chat.appendTools(toolActivities, routed.messageId, routed.threadId);
          else if (acpStream && acpThreadId) chat.appendTools(toolActivities, acpStream.id, acpThreadId);
        }
        if (payload.update?.sessionUpdate === "agent_message_chunk") {
          const text = payload.update.content?.text ?? "";
          if (!text) return;
          // 子任务优先：按 sessionId 路由到独立支架；未命中即为全局回合（普通派发 / planner）。
          if (routed) chat.appendMessageContent(routed.messageId, text, routed.threadId);
          else if (acpStream && acpThreadId) chat.appendMessageContent(acpStream.id, text, acpThreadId);
        }
      } else if (event.kind === "thought") {
        // 思考流（AgentThoughtChunk）：聚合到 store 快照，并续写支架消息的 thinking
        // 字段（ThinkingBlock 数据源），不打断正文流。
        const payload = event.payload as { text?: string };
        if (!payload.text) return;
        acpThoughtText.value += payload.text;
        if (acpStream && acpThreadId) chat.appendMessageThinking(acpStream.id, payload.text, acpThreadId);
      } else if (event.kind === "usage") {
        // token 用量快照（UsageUpdate）。
        const payload = event.payload as { used?: number; size?: number; cost?: { amount: number; currency: string } };
        if (typeof payload.used === "number") {
          acpUsage.value = { used: payload.used, size: payload.size ?? 0, cost: payload.cost };
        }
      } else if (event.kind === "commands") {
        // slash 命令目录更新（AvailableCommandsUpdate）：当前无 UI 消费，仅透传状态。
        const payload = event.payload as { availableCommands?: unknown[] };
        if (payload.availableCommands) acpCommands.value = payload.availableCommands;
      } else if (event.kind === "permission-auto") {
        // 宿主按档位自动决策（daily 只读 / auto 直通）：追加一行通知，不打断流
        const payload = event.payload as AcpPermissionRequestPayload;
        if (acpStream && acpThreadId)
          chat.appendMessageContent(
            acpStream.id,
            t("errors.autoApproved", { title: payload.title ?? payload.kind, choice: payload.chosen ?? "" }),
            acpThreadId,
          );
      } else if (event.kind === "permission-blocked") {
        // 宿主权限拦截（只读档 / 工作区越界）：通知流记录，不打断流
        const payload = event.payload as { title?: string | null; kind?: string; reason?: string; paths?: string[] };
        if (acpStream && acpThreadId) {
          const detail =
            payload.reason === "read-only"
              ? t("errors.readOnlyBlocked", { title: payload.title ?? payload.kind ?? "write" })
              : t("errors.blockedOutsideWorkspace", {
                  title: payload.title ?? payload.kind ?? "write",
                  paths: (payload.paths ?? []).join("、"),
                });
          chat.appendMessageContent(acpStream.id, detail, acpThreadId);
        }
      } else if (event.kind === "config-options") {
        // 后端确认后的全量配置快照（set_config_option 响应 / ConfigOptionUpdate 通知）：
        // 回填选择器控件——对齐 GreyWork useAcpConfigOptions 的 snapshot 观测。
        const payload = event.payload as { configOptions?: AcpSessionConfigOption[] };
        if (Array.isArray(payload.configOptions) && payload.configOptions.length > 0) {
          acpConfigOptions.value = payload.configOptions;
        }
      } else if (event.kind === "permission-request") {
        // cautious / daily 非只读：转发到确认卡片（ChatView 内联渲染）
        pendingPermission.value = event.payload as AcpPermissionRequestPayload;
      } else if (event.kind === "prompt-done") {
        chat.flushPendingContent();
        const payload = event.payload as { handle?: number; response?: unknown };
        // 1) 子任务完成：按 handle 路由
        if (payload.handle !== undefined) {
          const entry = findSubtaskByHandle(payload.handle);
          if (entry) {
            const { run, sub, session } = entry;
            finishSubtask(run, sub, session);
            subtaskPending.get(sub.id)?.resolve();
            subtaskPending.delete(sub.id);
            return;
          }
        }
        // 2) planner 回合完成：解析计划并启动队列
        if (plannerPending) {
          const { run, threadId, messageId } = plannerPending;
          plannerPending = null;
          const message = chat.threads[threadId]?.find((candidate) => candidate.id === messageId);
          if (message && !message.content.trim()) chat.setMessageContent(messageId, t("chat.noOutput"), threadId);
          acpStream = null;
          acpThreadId = null;
          acpStreamId.value = null;
          acpBusy.value = false;
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
            if (message) chat.appendMessageContent(messageId, `\n\n${t("agents.planFailed")}`, threadId);
            chat.flushPendingContent();
          }
          return;
        }
        // 3) 普通全局回合（既有逻辑）
        if (acpStream && acpThreadId) {
          const message = chat.threads[acpThreadId]?.find((candidate) => candidate.id === acpStream?.id);
          if (message && !message.content.trim()) chat.setMessageContent(message.id, t("chat.noOutput"), acpThreadId);
        }
        acpStream = null;
        acpThreadId = null;
        acpStreamId.value = null;
        acpBusy.value = false;
        activeTurnId.value = null;
        turnStartedAtMs.value = null;
      } else if (event.kind === "stopped") {
        chat.flushPendingContent();
        if (acpStream && acpThreadId) {
          chat.appendMessageContent(acpStream.id, `\n\n${t("chat.stopped")}`, acpThreadId);
          chat.flushPendingContent();
          acpStream = null;
          acpThreadId = null;
        }
        acpStreamId.value = null;
        acpConnected.value = false;
        acpHandle.value = null;
        acpSessionId.value = null;
        acpConfigOptions.value = [];
        acpBusy.value = false;
        pendingPermission.value = null;
        activeTurnId.value = null;
        turnStartedAtMs.value = null;
        acpStatus.value = "disconnected";
      }
    });
  }

  /** 启动 ACP 后端会话；返回错误文案（null = 成功）。 */
  async function startAcpSession(): Promise<string | null> {
    const provider = agentProviders.value.find((provider) => provider.id === selectedProviderId.value);
    if (!provider) return t("errors.acpNotSelected");
    if (!acp.isAvailable()) return t("errors.acpTransportUnavailable");
    let workspace: string;
    try {
      // 当前会话绑定带磁盘文件夹的工作区 → 以该文件夹为 ACP 工作区（权限锚定基准）；
      // 否则回落既有解析（设置项 workspaceDir → 桌面主目录）。
      workspace = activeConversationFolder() ?? (await resolveWorkspaceDir());
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    await ensureListener();
    acpStatus.value = "connecting";
    try {
      acpHandle.value = await acp.startAgent(provider.command, settings.effectivePermissionTier, settings.sandboxMode, workspace);
      // 建会话时把启用的 MCP 服务器声明给 agent；宿主按后端能力过滤，
      // 被跳过的原因回灌到 acpMcpSkipped 供设置页明示（不静默丢配置）。
      const opened = await acp.openSession(acpHandle.value, workspace, settings.enabledMcpServers);
      acpSessionId.value = opened.sessionId;
      acpConfigOptions.value = opened.configOptions;
      acpMcpServers.value = opened.mcpServers ?? [];
      acpMcpSkipped.value = opened.skippedMcpServers ?? [];
      acpStatus.value = opened.configOptions.length > 0 ? "session_active" : "connected";
      acpConnected.value = true;
      return null;
    } catch (error) {
      acpStatus.value = "error";
      acpConnected.value = false;
      acpHandle.value = null;
      acpSessionId.value = null;
      acpConfigOptions.value = [];
      return t("errors.startFailed", { detail: String(error) });
    }
  }

  /**
   * 派发意图到选中 ACP 后端：user/assistant 消息先入当前线程，
   * 宿主事件（chunk / 权限 / 停止）驱动支架消息流式续写。
   */
  async function dispatchToAcp(text: string): Promise<void> {
    if (acpBusy.value) return;
    const { threadId, message } = chat.startAcpTurn(
      text,
      agentProviders.value.find((provider) => provider.id === selectedProviderId.value)?.name ?? "ACP",
    );
    acpStream = message;
    acpThreadId = threadId;
    acpStreamId.value = message.id;
    if (acpHandle.value === null || acpSessionId.value === null) {
      const failure = await startAcpSession();
      if (failure) {
        chat.setMessageContent(message.id, t("errors.acpStartFailed", { detail: failure }), acpThreadId);
        acpStream = null;
        acpThreadId = null;
        acpStreamId.value = null;
        return;
      }
    }
    acpBusy.value = true;
    turnStartedAtMs.value = Date.now();
    acpThoughtText.value = "";
    try {
      const { turnId } = await acp.prompt(acpHandle.value as number, text);
      activeTurnId.value = turnId;
      // 注意：成功后不清 acpStream —— prompt 只是 ack，回合增量经事件异步回流，
      // 支架必须活到 prompt-done / stopped（与 dispatchRun 一致）。
    } catch (error) {
      activeTurnId.value = null;
      turnStartedAtMs.value = null;
      const detail = error instanceof Error ? error.message : String(error);
      const current = acpThreadId ? chat.threads[acpThreadId]?.find((candidate) => candidate.id === message.id) : undefined;
      chat.setMessageContent(
        message.id,
        current?.content ? `${current.content}\n\n${t("errors.dispatchFailed", { detail })}` : t("errors.dispatchFailed", { detail }),
        acpThreadId,
      );
      acpStream = null;
      acpThreadId = null;
      acpStreamId.value = null;
      acpBusy.value = false;
    }
  }

  /** 设置会话配置选项（模型 / 推理力度等）；返回错误文案（null = 成功）。 */
  async function setAcpConfig(configId: string, value: string | boolean): Promise<string | null> {
    if (acpHandle.value === null || !acpSessionId.value) return t("errors.sessionNotStarted");
    try {
      // setSessionConfig 返回全量最新快照（含后端确认后的 currentValue）——覆盖本地
      // 控件状态，保证「选择 → 后端确认 → 回填」闭环（对齐 useAcpConfigOptions）。
      const updated = await acp.setSessionConfig(acpHandle.value, configId, value);
      if (updated.length > 0) acpConfigOptions.value = updated;
      // 记忆到当前工作区：模型 / 思考强度这类选择是「这个项目怎么干活」的一部分，
      // 切回来应当还是它。回放期间不记（见 replayingConfig），否则回放会把自己再写一遍。
      if (!replayingConfig && typeof value === "string" && workspaceStore.activeWorkspaceId) {
        workspaceStore.setAgentConfig(workspaceStore.activeWorkspaceId, { configValues: { [configId]: value } });
      }
      return null;
    } catch (error) {
      return t("errors.configFailed", { detail: String(error) });
    }
  }

  /**
   * 把当前生效档位推给所有在途 agent。
   *
   * 宿主按 handle 存档位并在每条权限请求上重读，因此这里改完即刻生效，不必重启进程 ——
   * 「降到只读跑完再升」才能保住会话上下文。编排子任务各自一个 handle，一并推。
   */
  async function applyPermissionTier(): Promise<string | null> {
    const handles = acpHandle.value === null ? [] : [acpHandle.value];
    for (const session of subtaskSessions.values()) handles.push(session.handle);
    for (const handle of handles) {
      try {
        await acp.setPermissionTier(handle, settings.effectivePermissionTier);
      } catch (error) {
        return t("errors.configFailed", { detail: String(error) });
      }
    }
    return null;
  }

  /** 一键临时降级/回升；返回错误文案（null = 成功）。 */
  async function setTempReadOnly(on: boolean): Promise<string | null> {
    settings.tempReadOnly = on;
    return applyPermissionTier();
  }

  /** 回放工作区记忆配置期间置真，抑制 setAcpConfig 的自反写入。 */
  let replayingConfig = false;

  /**
   * 应用某工作区记住的 ACP 后端与会话配置。
   *
   * 无记录时**不动当前状态**（用户可能刚在别处选好后端，切个工作区不该被重置）。
   */
  async function applyWorkspaceAgentConfig(workspaceId: string | null): Promise<void> {
    const remembered = workspaceStore.agentConfigOf(workspaceId);
    if (!remembered) return;
    if (remembered.providerId === null) {
      if (routeToAcp.value) await switchToLocalLlm();
      return;
    }
    if (remembered.providerId && (remembered.providerId !== selectedProviderId.value || !routeToAcp.value)) {
      const failure = await activateAcpProvider(remembered.providerId);
      if (failure) return; // 连不上就停在错误态，别再拿旧 handle 回放配置
    }
    const values = remembered.configValues;
    if (!values || acpHandle.value === null) return;
    replayingConfig = true;
    try {
      for (const [configId, value] of Object.entries(values)) {
        const option = acpConfigOptions.value.find((candidate) => candidate.id === configId && candidate.type === "select");
        if (option) await setAcpConfig(configId, value);
      }
    } finally {
      replayingConfig = false;
    }
  }

  // 切工作区即换「这个项目的干活方式」；immediate 关掉，避免启动就抢着建连接。
  watch(() => workspaceStore.activeWorkspaceId, applyWorkspaceAgentConfig);

  /** 主动连接当前 ACP 后端并加载会话配置（幂等：已连接直接返回）。 */
  async function connectAcp(): Promise<string | null> {
    if (acpHandle.value !== null && acpSessionId.value) return null;
    if (acpConnecting.value) return null;
    acpConnecting.value = true;
    try {
      return await startAcpSession();
    } finally {
      acpConnecting.value = false;
    }
  }

  async function stopAcp(): Promise<void> {
    if (acpHandle.value === null) return;
    try {
      // 有在途回合：精确取消该回合（agent 进程与会话保留，可继续对话）。
      if (activeTurnId.value !== null) {
        const turnId = activeTurnId.value;
        activeTurnId.value = null;
        turnStartedAtMs.value = null;
        await acp.stop(acpHandle.value, turnId);
      } else {
        await acp.stop(acpHandle.value);
        acpStatus.value = "disconnected";
        acpConnected.value = false;
      }
    } catch (error) {
      if (acpStream && acpThreadId)
        chat.appendMessageContent(acpStream.id, `\n\n${t("errors.stopFailed", { detail: String(error) })}`, acpThreadId);
    }
  }

  /** 重启当前 ACP runtime：停 agent 进程 → 重新 spawn + session/new（重新探测模型/config options）。
   *  对齐 GreyWork AcpRuntimeRestartButton——runtime 卡死/模型探测失败后的恢复路径。 */
  async function restartAcpRuntime(): Promise<string | null> {
    if (acpHandle.value === null) return null;
    try {
      await acp.stop(acpHandle.value);
    } catch (error) {
      return t("errors.stopCurrentFailed", { detail: String(error) });
    }
    acpConnected.value = false;
    acpHandle.value = null;
    acpSessionId.value = null;
    acpConfigOptions.value = [];
    pendingPermission.value = null;
    acpStreamId.value = null;
    activeTurnId.value = null;
    turnStartedAtMs.value = null;
    acpStatus.value = "disconnected";
    return startAcpSession();
  }

  /* ===== 后端目录管理（Agent 管理面：启停持久化，桌面真源 SQLite） ===== */

  function persistProviders(): void {
    providersStorage.write({ providers: agentProviders.value });
    if (agentsBackend.active()) {
      const rows: AgentProviderRow[] = agentProviders.value.map((provider) => ({ ...provider }));
      void agentsBackend.save(rows).catch((error: unknown) => {
        console.error("[agent] 后端目录同步失败，将下次重试", error);
      });
    }
  }

  /** 桌面态启动接管：库目录 → 覆盖（真源）；未接管 → 内置缺省/缓存首落库。 */
  const providersHydrated: Promise<void> | null = (() => {
    if (!agentsBackend.active()) return null;
    return agentsBackend
      .load()
      .then((providers) => {
        if (providers) {
          agentProviders.value = providers;
          // selected 在新目录中消失时回落首个 id（routeToAcp 状态保持，activate 再校验 enabled）
          if (!agentProviders.value.some((provider) => provider.id === selectedProviderId.value)) {
            selectedProviderId.value = agentProviders.value[0]?.id ?? "";
          }
          if (!routeToAcp.value && !savedProvider?.enabled && selectedProviderId.value === "") {
            selectedProviderId.value = agentProviders.value[0]?.id ?? "";
          }
        } else {
          persistProviders(); // 首启：内置缺省成为库真源
        }
      })
      .catch((error: unknown) => {
        console.error("[agent] 后端目录加载失败，沿用内置缺省", error);
      });
  })();

  /** 启停 ACP 后端：禁用当前选中且正在 ACP 路由时自动切回 Local LLM。 */
  async function setAgentProviderEnabled(id: string, enabled: boolean): Promise<void> {
    const provider = agentProviders.value.find((candidate) => candidate.id === id);
    if (!provider || provider.enabled === enabled) return;
    provider.enabled = enabled;
    persistProviders();
    if (!enabled && id === selectedProviderId.value && routeToAcp.value) {
      await switchToLocalLlm(); // 停用当前后端：完整清理 ACP 状态回 Local
    }
  }

  /** 切换首页 ACP CLI 入口。切换已有连接时先释放旧 agent，避免跨 provider 复用 session。 */
  async function activateAcpProvider(id: string): Promise<string | null> {
    const provider = agentProviders.value.find((candidate) => candidate.id === id);
    if (!provider) return t("errors.acpNotSelected");
    if (!provider.enabled) return t("errors.providerNotEnabled", { name: provider.name });
    if (selectedProviderId.value !== id && acpHandle.value !== null) {
      try {
        await acp.stop(acpHandle.value);
      } catch (error) {
        return t("errors.stopCurrentFailed", { detail: String(error) });
      }
      acpConnected.value = false;
      acpHandle.value = null;
      acpSessionId.value = null;
      acpConfigOptions.value = [];
      pendingPermission.value = null;
      acpStreamId.value = null;
    }
    selectedProviderId.value = id;
    routeToAcp.value = true;
    providerPrefStorage.write({ providerId: id });
    // 后端选择也按工作区记忆（回放时 replayingConfig 无关：providerId 幂等）
    if (workspaceStore.activeWorkspaceId) workspaceStore.setAgentConfig(workspaceStore.activeWorkspaceId, { providerId: id });
    // 选中即建会话：configOptions（模型 / 思考强度）只有 session/new 之后才有值，
    // 否则选择器要等到首次发送才出现。连接失败不阻塞选择（发送时会重试并落文案）；
    // 失败文案原样返回，调用方（AgentProviderBar）就地展示而非静默吞掉。
    return await connectAcp();
  }

  /** 权限裁决回传宿主；optionId=null 表示拒绝该次操作。 */
  async function respondPermission(optionId: string | null): Promise<void> {
    const pending = pendingPermission.value;
    if (!pending) return;
    pendingPermission.value = null;
    const choice = optionId
      ? (pending.options.find((option) => option.optionId === optionId)?.name ?? optionId)
      : t("errors.permissionDenied");
    try {
      await acp.respondPermission(pending.requestId, optionId);
      if (acpStream && acpThreadId)
        chat.appendMessageContent(
          acpStream.id,
          `\n\n${t("errors.permissionLog", { choice, title: pending.title ?? pending.kind })}`,
          acpThreadId,
        );
    } catch (error) {
      if (acpStream && acpThreadId)
        chat.appendMessageContent(acpStream.id, `\n\n${t("errors.permissionFailed", { detail: String(error) })}`, acpThreadId);
    }
  }

  /**
   * 探活一台 MCP 服务器（设置页「测试连接」）：宿主自己走一遍 initialize + tools/list。
   * 这只用于验证配置——真正连接由 agent 在会话里建立。
   */
  async function probeMcpServer(config: McpServerConfig): Promise<{ report?: McpProbeReport; error?: string }> {
    if (!acp.isAvailable()) return { error: t("errors.acpTransportUnavailable") };
    try {
      return { report: await acp.probeMcp(config) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  function selectProvider(id: string): void {
    selectedProviderId.value = id;
  }

  function toggleRouteToAcp(): void {
    routeToAcp.value = !routeToAcp.value;
  }

  /** 切回本地 LLM 管线（关闭 ACP 路由；若已连接 agent 则释放）。 */
  async function switchToLocalLlm(): Promise<void> {
    routeToAcp.value = false;
    providerPrefStorage.write({ providerId: null });
    if (workspaceStore.activeWorkspaceId) workspaceStore.setAgentConfig(workspaceStore.activeWorkspaceId, { providerId: null });
    if (acpHandle.value !== null) {
      try {
        await acp.stop(acpHandle.value);
      } catch {
        // 释放失败不阻塞切换；下次 startAcpSession 会重建。
      }
      acpConnected.value = false;
      acpHandle.value = null;
      acpSessionId.value = null;
      acpConfigOptions.value = [];
      pendingPermission.value = null;
      acpStreamId.value = null;
      activeTurnId.value = null;
      turnStartedAtMs.value = null;
      acpStatus.value = "disconnected";
    }
  }

  return {
    agents,
    roles,
    workflowSteps,
    agentProviders,
    selectedProviderId,
    routeToAcp,
    acpBusy,
    acpConnecting,
    pendingPermission,
    acpConfigOptions,
    acpMcpServers,
    acpMcpSkipped,
    acpStreamId,
    acpStatus,
    acpConnected,
    activeTurnId,
    turnStartedAtMs,
    acpUsage,
    acpThoughtText,
    acpCommands,
    runs,
    /** 编排存档启动接管完成信号（null = 浏览器态无后端）；await 后历史已并入 runs。 */
    runsHydrated,
    /** 后端目录启动接管完成信号（null = 浏览器态无后端）。 */
    providersHydrated,
    setAgentProviderEnabled,
    maxParallel,
    setAcpConfig,
    connectAcp,
    activateAcpProvider,
    dispatchRun,
    maybeOrchestrate,
    cancelSubtask,
    retrySubtask,
    addSubtask,
    clearOrchestration,
    setTempReadOnly,
    applyPermissionTier,
    applyWorkspaceAgentConfig,
    acpAvailable: acp.isAvailable(),
    selectProvider,
    toggleRouteToAcp,
    switchToLocalLlm,
    restartAcpRuntime,
    dispatchToAcp,
    stopAcp,
    respondPermission,
    probeMcpServer,
  };
});
