import { AGENT_ROLES, MOCK_AGENTS, buildPlanPrompt, createPlannerRun, parsePlan, type PlannerRun, type Subtask } from "@greywork/agents";
import { createAcpClient, desktopHomeDir, type AcpPermissionRequestPayload, type AcpSessionConfigOption } from "@greywork/acp";
import { createAgentProviderRegistry, type AgentProviderConfig } from "@greywork/shell";
import { createAcpAgentAdapter } from "@greywork/integrations";
import { defineStore } from "pinia";
import { ref } from "vue";
import { useChatStore } from "./chat";
import { useSettingsStore } from "./settings";
import { i18n } from "../i18n";
import type { ThreadMessage } from "../types";

const t = i18n.global.t;

export interface WorkflowStep {
  id: string;
  label: string;
  status: "wait" | "active" | "done";
  desc: string;
}

const acpAdapter = createAcpAgentAdapter(createAcpClient());

/** Agent 编排：编队 / 流水线 / 循环策略 / ACP 后端派发（AgentsView 与 Chat·Cowork 数据源）。 */
export const useAgentStore = defineStore("agent", () => {
  const settings = useSettingsStore();
  const chat = useChatStore();
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
  const agentProviders = ref<AgentProviderConfig[]>(agentProviderRegistry.list());
  const selectedProviderId = ref<string>(agentProviders.value[0]?.id ?? "");
  /** 派发开关：开 = 意图发给选中 ACP 后端；关 = 内部 LLM / mock 管线 */
  const routeToAcp = ref(false);
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

  /* ===== 并行编排（方案 1：planner 分解 → 子任务并行派发） ===== */
  /** 活跃编排运行（最新在前）；AgentsView 看板数据源。 */
  const runs = ref<PlannerRun[]>([]);
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
    run.status = failed ? "failed" : "done";
    run.finishedAt = Date.now();
  }

  /** 单子任务独立会话派发；prompt-done 事件按 handle 路由完成（resolve 回执）。 */
  async function runSubtask(run: PlannerRun, sub: Subtask): Promise<void> {
    sub.status = "running";
    let handle: number;
    try {
      const provider = agentProviders.value.find((provider) => provider.id === selectedProviderId.value);
      if (!provider) throw new Error(t("errors.acpNotSelected"));
      const workspace = await resolveWorkspace();
      handle = await acpAdapter.startAgent(provider.command, settings.permissionTier, settings.sandboxMode, workspace);
      const { sessionId } = await acpAdapter.openSession(handle, workspace);
      const { threadId, message } = chat.startAcpTurn(sub.prompt, sub.role);
      subtaskSessions.set(sub.id, { handle, sessionId, threadId, messageId: message.id });
    } catch (error) {
      sub.status = "failed";
      sub.error = String(error);
      checkRunDone(run);
      return;
    }
    const pending = new Promise<void>((resolve) => {
      subtaskPending.set(sub.id, { resolve });
    });
    try {
      await acpAdapter.prompt(handle, sub.prompt);
    } catch (error) {
      sub.status = "failed";
      sub.error = String(error);
      subtaskSessions.delete(sub.id);
      subtaskPending.delete(sub.id);
      checkRunDone(run);
      return;
    }
    await pending;
  }

  function finishSubtask(run: PlannerRun, sub: Subtask, session: SubtaskSession): void {
    // 空内容兜底 + 回收子任务进程
    const message = chat.threads[session.threadId]?.find((candidate) => candidate.id === session.messageId);
    if (message && !message.content.trim()) chat.setMessageContent(message.id, t("chat.noOutput"), session.threadId);
    sub.status = "done";
    subtaskSessions.delete(sub.id);
    void acpAdapter.stop(session.handle).catch(() => undefined);
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

  /** 无 ACP 后端时的演示降级：mock 时间线顺序推进两个子任务。 */
  function fallbackRunMock(run: PlannerRun): void {
    run.subtasks = [
      { id: "sub-1", role: "builder", prompt: run.goal, status: "pending" },
      { id: "sub-2", role: "reviewer", prompt: `审查「${run.goal}」的产出`, status: "pending" },
    ];
    run.status = "running";
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

  /** 编排入口：planner 分解 → 并行执行（maxParallel）。 */
  async function dispatchRun(goal: string): Promise<void> {
    const run = createPlannerRun(goal);
    runs.value.unshift(run);
    const provider = agentProviders.value.find((provider) => provider.id === selectedProviderId.value);
    if (!acpAdapter.isAvailable() || !provider || !provider.enabled) {
      fallbackRunMock(run);
      return;
    }
    const failure = await connectAcp();
    if (failure) {
      run.status = "failed";
      run.finishedAt = Date.now();
      return;
    }
    const text = buildPlanPrompt(run.goal);
    const { threadId, message } = chat.startAcpTurn(text, "planner");
    acpStream = message;
    acpThreadId = threadId;
    acpStreamId.value = message.id;
    acpBusy.value = true;
    plannerPending = { run, threadId, messageId: message.id };
    try {
      await acpAdapter.prompt(acpHandle.value as number, text);
    } catch (error) {
      plannerPending = null;
      run.status = "failed";
      run.finishedAt = Date.now();
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
    for (const session of subtaskSessions.values()) void acpAdapter.stop(session.handle).catch(() => undefined);
    subtaskSessions.clear();
    plannerPending = null;
  }

  async function ensureListener(): Promise<void> {
    if (listening) return;
    listening = true;
    await acpAdapter.onEvent((event) => {
      if (event.kind === "session-update") {
        const payload = event.payload as {
          session_id?: string;
          update?: { sessionUpdate?: string; content?: { text?: string } };
        };
        if (payload.update?.sessionUpdate === "agent_message_chunk") {
          const text = payload.update.content?.text ?? "";
          if (!text) return;
          // 编排子任务优先：按 sessionId 路由到独立支架
          if (payload.session_id) {
            for (const session of subtaskSessions.values()) {
              if (session.sessionId === payload.session_id) {
                chat.appendMessageContent(session.messageId, text, session.threadId);
                return;
              }
            }
          }
          // 全局回合（普通派发 / planner）
          if (acpStream && acpThreadId) chat.appendMessageContent(acpStream.id, text, acpThreadId);
        }
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
        // 宿主文件系统锚定拦截（写类工具路径越出工作区）：通知流记录，不打断流
        const payload = event.payload as { title?: string | null; kind?: string; paths?: string[] };
        if (acpStream && acpThreadId)
          chat.appendMessageContent(
            acpStream.id,
            t("errors.blockedOutsideWorkspace", {
              title: payload.title ?? payload.kind ?? "write",
              paths: (payload.paths ?? []).join("、"),
            }),
            acpThreadId,
          );
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
            kickSubtasks(run);
          } else {
            run.status = "failed";
            run.finishedAt = Date.now();
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
      } else if (event.kind === "stopped") {
        chat.flushPendingContent();
        if (acpStream && acpThreadId) {
          chat.appendMessageContent(acpStream.id, `\n\n${t("chat.stopped")}`, acpThreadId);
          chat.flushPendingContent();
          acpStream = null;
          acpThreadId = null;
        }
        acpStreamId.value = null;
        acpHandle.value = null;
        acpSessionId.value = null;
        acpConfigOptions.value = [];
        acpBusy.value = false;
        pendingPermission.value = null;
      }
    });
  }

  /** 工作区目录：设置项优先，否则取桌面主目录；宿主侧仍会做绝对路径/非根校验。 */
  async function resolveWorkspace(): Promise<string> {
    const configured = settings.workspaceDir.trim();
    if (configured) return configured;
    const home = await desktopHomeDir();
    if (!home) throw new Error(t("errors.workspaceUnresolvable"));
    return home;
  }

  /** 启动 ACP 后端会话；返回错误文案（null = 成功）。 */
  async function startAcpSession(): Promise<string | null> {
    const provider = agentProviders.value.find((provider) => provider.id === selectedProviderId.value);
    if (!provider) return t("errors.acpNotSelected");
    if (!acpAdapter.isAvailable()) return t("errors.acpTransportUnavailable");
    let workspace: string;
    try {
      workspace = await resolveWorkspace();
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    await ensureListener();
    try {
      acpHandle.value = await acpAdapter.startAgent(provider.command, settings.permissionTier, settings.sandboxMode, workspace);
      const opened = await acpAdapter.openSession(acpHandle.value, workspace);
      acpSessionId.value = opened.sessionId;
      acpConfigOptions.value = opened.configOptions;
      return null;
    } catch (error) {
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
    try {
      await acpAdapter.prompt(acpHandle.value as number, text);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const current = acpThreadId ? chat.threads[acpThreadId]?.find((candidate) => candidate.id === message.id) : undefined;
      chat.setMessageContent(
        message.id,
        current?.content ? `${current.content}\n\n${t("errors.dispatchFailed", { detail })}` : t("errors.dispatchFailed", { detail }),
        acpThreadId,
      );
    } finally {
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
      acpConfigOptions.value = await acpAdapter.setSessionConfig(acpHandle.value, configId, value);
      return null;
    } catch (error) {
      return t("errors.configFailed", { detail: String(error) });
    }
  }

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
      await acpAdapter.stop(acpHandle.value);
    } catch (error) {
      if (acpStream && acpThreadId)
        chat.appendMessageContent(acpStream.id, `\n\n${t("errors.stopFailed", { detail: String(error) })}`, acpThreadId);
    }
  }

  /** 切换首页 ACP CLI 入口。切换已有连接时先释放旧 agent，避免跨 provider 复用 session。 */
  async function activateAcpProvider(id: string): Promise<string | null> {
    const provider = agentProviders.value.find((candidate) => candidate.id === id);
    if (!provider) return t("errors.acpNotSelected");
    if (!provider.enabled) return t("errors.providerNotEnabled", { name: provider.name });
    if (selectedProviderId.value !== id && acpHandle.value !== null) {
      try {
        await acpAdapter.stop(acpHandle.value);
      } catch (error) {
        return t("errors.stopCurrentFailed", { detail: String(error) });
      }
      acpHandle.value = null;
      acpSessionId.value = null;
      acpConfigOptions.value = [];
      pendingPermission.value = null;
      acpStreamId.value = null;
    }
    selectedProviderId.value = id;
    routeToAcp.value = true;
    return null;
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
      await acpAdapter.respondPermission(pending.requestId, optionId);
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

  function selectProvider(id: string): void {
    selectedProviderId.value = id;
  }

  function toggleRouteToAcp(): void {
    routeToAcp.value = !routeToAcp.value;
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
    acpStreamId,
    runs,
    maxParallel,
    setAcpConfig,
    connectAcp,
    activateAcpProvider,
    dispatchRun,
    clearOrchestration,
    acpAvailable: acpAdapter.isAvailable(),
    selectProvider,
    toggleRouteToAcp,
    dispatchToAcp,
    stopAcp,
    respondPermission,
  };
});
