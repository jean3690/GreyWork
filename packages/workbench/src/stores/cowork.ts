import { createAcpClient, type AcpSessionConfigOption } from "@greywork/acp";
import type { AgentProviderConfig } from "@greywork/shell";
import {
  createCoworkEngine,
  type CoworkDispatchInput,
  type CoworkEngine,
  type CoworkEvent,
  type CoworkMail,
  type CoworkRole,
  type CoworkSlotInit,
  type CoworkSpecialty,
  type CoworkTaskStatus,
  type WakeState,
} from "@greywork/cowork";
import { createIdFactory } from "@greywork/core";
import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";
import { appEvents } from "../events";
import { i18n } from "../i18n";
import { activeConversationFolder } from "../lib/conversation-folder";
import { parseToolActivityPayload } from "../lib/tool-activity";
import { resolveWorkspaceDir, isolateForRun } from "../lib/workspace-dir";
import type { ThreadMessage } from "../types";
import { notify } from "./notice";
import { useAgentStore } from "./agent";
import { useRunsStore } from "./runs";
import { useChatStore } from "./chat";
import { useSessionStore } from "./session";
import { useSettingsStore } from "./settings";
import { useWorkspaceStore } from "./workspace";

const t = i18n.global.t;

/** 独立 ACP 客户端：桌面态每次 onEvent 都是独立的 Tauri listener，不会干扰 agent store 的路由。 */
const acp = createAcpClient();
const uid = createIdFactory("cw");

/** 摘要长度：进度通知给 leader 看一眼就够，长产出走任务 result。 */
const MAX_SUMMARY = 200;
/** 写进会话的信件正文长度上限（完整正文仍在运行快照里）。 */
const MAX_MAIL_ECHO = 400;

/** 成员位 ↔ ACP 运行时绑定。非响应式：UI 只读引擎快照的投影，不碰 handle。 */
interface SlotRuntime {
  handle: number;
  sessionId: string;
  threadId: string;
  /** 当前回合的 assistant 支架消息 id；回合结束后清空。 */
  messageId: string | null;
  turnId: number | null;
}

export interface CoworkMemberInit {
  name: string;
  role: CoworkRole;
  /** teammate 的职能标签（可空 = 通用成员）；leader 忽略。 */
  specialty?: CoworkSpecialty;
  /** 该成员位专用的 ACP 后端 id；空 = 跟随全局选中的后端。 */
  providerId?: string;
  /**
   * 该成员位的会话配置（configId → 值；键来自该后端 session/new 上报的 configOptions，
   * UI 从「成员配置」探测下拉中选择）。startRun 打开成员会话后经 setSessionConfig 应用；
   * 后端未暴露的键静默跳过，旧数据无此字段 = 完全跟随后端默认。
   */
  configValues?: Record<string, string>;
}

export interface CoworkSlotView {
  id: string;
  name: string;
  role: CoworkRole;
  status: string;
  turns: number;
  threadId: string;
  specialty?: CoworkSpecialty;
  wake: WakeState;
  unread: number;
  error?: string;
}

export interface CoworkTaskView {
  id: string;
  subject: string;
  detail?: string;
  status: CoworkTaskStatus;
  ownerName: string | null;
  blockedBy: string[];
  result?: string;
}

export interface CoworkActivityView {
  id: string;
  kind: CoworkMail["kind"];
  fromName: string;
  toName: string;
  body: string;
  summary?: string;
  createdAt: number;
  read: boolean;
}

const summarize = (output: string): string | undefined => {
  // 去掉协作指令围栏后取最后一段有内容的文字：那通常就是这一回合的结论。
  const plain = output.replace(/```cowork[\s\S]*?```/gi, "").trim();
  if (!plain) return undefined;
  const paragraphs = plain.split(/\n{2,}/).filter((part) => part.trim().length > 0);
  const last = (paragraphs[paragraphs.length - 1] ?? plain).trim();
  return last.length > MAX_SUMMARY ? `${last.slice(0, MAX_SUMMARY)}…` : last;
};

/** Cowork 协作运行：把 @greywork/cowork 引擎接到真实 ACP 会话与会话存储上。 */
export const useCoworkStore = defineStore("cowork", () => {
  const agentStore = useAgentStore();
  const runsStore = useRunsStore();
  const chat = useChatStore();
  const sessionStore = useSessionStore();
  const settings = useSettingsStore();
  const workspaceStore = useWorkspaceStore();

  const engine = shallowRef<CoworkEngine | null>(null);
  /** 引擎持有的是普通对象（便于整体序列化），故用版本号驱动视图重算。 */
  const revision = ref(0);
  const starting = ref(false);
  const lastError = ref<string | null>(null);
  const runtimes = new Map<string, SlotRuntime>();
  let listening = false;

  const touch = (): void => {
    revision.value += 1;
  };

  const nameOf = (slotId: string): string => {
    if (slotId === "user") return t("cowork.user");
    return engine.value?.run.slots.find((slot) => slot.id === slotId)?.name ?? slotId;
  };

  const slotBySession = (sessionId: unknown): string | null => {
    if (typeof sessionId !== "string") return null;
    for (const [slotId, runtime] of runtimes) {
      if (runtime.sessionId === sessionId) return slotId;
    }
    return null;
  };

  const slotByHandle = (handle: unknown): string | null => {
    if (typeof handle !== "number") return null;
    for (const [slotId, runtime] of runtimes) {
      if (runtime.handle === handle) return slotId;
    }
    return null;
  };

  const goal = computed<string>(() => {
    void revision.value;
    return engine.value?.run.goal ?? "";
  });

  const status = computed<string | null>(() => {
    void revision.value;
    return engine.value?.run.status ?? null;
  });

  const pausedReason = computed<string | null>(() => {
    void revision.value;
    return engine.value?.run.pausedReason ?? null;
  });

  const slots = computed<CoworkSlotView[]>(() => {
    void revision.value;
    const current = engine.value;
    if (!current) return [];
    return current.run.slots.map((slot) => ({
      id: slot.id,
      name: slot.name,
      role: slot.role,
      status: slot.status,
      turns: slot.turns,
      threadId: slot.threadId,
      specialty: slot.specialty,
      wake: current.wakeStateOf(slot.id),
      unread: current.run.mail.filter((mail) => !mail.read && mail.to === slot.id).length,
      error: slot.error,
    }));
  });

  const tasks = computed<CoworkTaskView[]>(() => {
    void revision.value;
    const current = engine.value;
    if (!current) return [];
    return current.run.tasks.map((task) => ({
      id: task.id,
      subject: task.subject,
      detail: task.detail,
      status: task.status,
      ownerName: task.owner ? nameOf(task.owner) : null,
      blockedBy: [...task.blockedBy],
      result: task.result,
    }));
  });

  const activity = computed<CoworkActivityView[]>(() => {
    void revision.value;
    const current = engine.value;
    if (!current) return [];
    return current.run.mail
      .map((mail) => ({
        id: mail.id,
        kind: mail.kind,
        fromName: nameOf(mail.from),
        toName: nameOf(mail.to),
        body: mail.body,
        summary: mail.summary,
        createdAt: mail.createdAt,
        read: mail.read,
      }))
      .reverse();
  });

  const stats = computed(() => {
    void revision.value;
    const current = engine.value;
    return current?.stats() ?? { inflight: 0, queued: 0, unread: 0, unfinishedTasks: 0 };
  });

  const spend = computed(() => {
    void revision.value;
    const current = engine.value;
    if (!current) return null;
    return { turns: current.run.spend.turns, budget: { ...current.run.budget } };
  });

  const active = computed<boolean>(() => status.value === "running" || status.value === "paused");

  function onEngineEvent(event: CoworkEvent): void {
    touch();
    if (event.kind !== "run-status") return;
    const current = engine.value;
    if (!current) return;
    appEvents.emit("run:status", {
      runId: current.run.id,
      status: event.status,
      done: current.run.tasks.filter((task) => task.status === "done").length,
      total: current.run.tasks.length,
    });
  }

  /** 把本回合投递的信件落成一条 system 消息，让成员位的会话自身可审计。 */
  function describeInbox(input: CoworkDispatchInput): string {
    const head = input.kind === "role" ? `${t("cowork.system.roleInjected")}\n\n` : "";
    const lines = input.mail.map((mail) => {
      const body = mail.body.length > MAX_MAIL_ECHO ? `${mail.body.slice(0, MAX_MAIL_ECHO)}…` : mail.body;
      return `**${nameOf(mail.from)} → ${t(`cowork.mailKind.${mail.kind}`)}**\n${body}`;
    });
    return `${head}${lines.join("\n\n")}`;
  }

  function dispatchTurn(input: CoworkDispatchInput): Promise<void> {
    const runtime = runtimes.get(input.slot.id);
    if (!runtime) return Promise.reject(new Error(t("cowork.errors.runtimeMissing", { slot: input.slot.name })));
    sessionStore.appendMessage(runtime.threadId, {
      id: uid(),
      role: "system",
      content: describeInbox(input),
      ts: Date.now(),
    });
    const scaffold: ThreadMessage = {
      id: uid(),
      role: "assistant",
      content: "",
      ts: Date.now(),
      acp: input.slot.name,
    };
    sessionStore.appendMessage(runtime.threadId, scaffold);
    runtime.messageId = scaffold.id;
    touch();
    return acp.prompt(runtime.handle, input.prompt).then(({ turnId }) => {
      runtime.turnId = turnId;
    });
  }

  /** 回合收尾：先解析协作指令（可能唤醒别人），再结束回合（决定是否汇总给 leader）。 */
  function finishTurn(slotId: string, outcome: { ok: boolean; error?: string }): void {
    const current = engine.value;
    const runtime = runtimes.get(slotId);
    if (!current || !runtime) return;
    // 该成员位当前没有在跑的回合 → 这是噪声（重复的 prompt-done、空闲期的 stopped）。
    // 不能放过去：turnEnded 会把成员位标记失败、再给 leader 补一条通知。
    if (!runtime.messageId) return;
    chat.flushPendingContent();
    const message = runtime.messageId ? chat.threads[runtime.threadId]?.find((candidate) => candidate.id === runtime.messageId) : undefined;
    const output = message?.content ?? "";
    if (message) {
      const errorText = outcome.ok ? "" : (outcome.error ?? "").trim();
      if (errorText) {
        // 失败回合：落失败文案而非「无文本输出」；有流式内容则末尾追加，leader 通知照常由 engine 发。
        const text = t("chat.llmCallFailed", { detail: errorText });
        if (!output.trim()) chat.setMessageContent(message.id, text, runtime.threadId);
        else {
          chat.appendMessageContent(message.id, `\n\n${text}`, runtime.threadId);
          chat.flushPendingContent();
        }
      } else if (!output.trim()) {
        chat.setMessageContent(message.id, t("chat.noOutput"), runtime.threadId);
      }
    }
    runtime.messageId = null;
    runtime.turnId = null;
    if (outcome.ok) current.applyOutput(slotId, output);
    current.turnEnded(slotId, { ok: outcome.ok, error: outcome.error, summary: outcome.ok ? summarize(output) : undefined });
    touch();
  }

  function handleAcpEvent(event: { kind: string; payload: unknown }): void {
    const current = engine.value;
    if (!current) return;
    const payload = (event.payload ?? {}) as {
      sessionId?: unknown;
      handle?: unknown;
      text?: string;
      used?: number;
      cost?: { amount?: number };
      error?: unknown;
      update?: { sessionUpdate?: string; content?: { text?: string } };
    };

    if (event.kind === "session-update") {
      // 宿主发的是 camelCase sessionId（ACP schema 的 serde 约定），按它路由到成员位支架。
      const slotId = slotBySession(payload.sessionId);
      const runtime = slotId ? runtimes.get(slotId) : null;
      if (!runtime || !runtime.messageId) return;
      const activities = parseToolActivityPayload(payload);
      if (activities.length > 0) chat.appendTools(activities, runtime.messageId, runtime.threadId);
      if (payload.update?.sessionUpdate === "agent_message_chunk") {
        const text = payload.update.content?.text ?? "";
        if (text) chat.appendMessageContent(runtime.messageId, text, runtime.threadId);
      }
      return;
    }

    if (event.kind === "thought") {
      const slotId = slotBySession(payload.sessionId);
      const runtime = slotId ? runtimes.get(slotId) : null;
      if (runtime?.messageId && payload.text) {
        chat.appendMessageThinking(runtime.messageId, payload.text, runtime.threadId);
      }
      return;
    }

    if (event.kind === "usage") {
      const slotId = slotBySession(payload.sessionId);
      if (!slotId) return;
      current.recordUsage(slotId, { tokens: payload.used, cost: payload.cost?.amount });
      touch();
      return;
    }

    if (event.kind === "prompt-done") {
      const slotId = slotByHandle(payload.handle);
      if (!slotId) return;
      const failed = payload.error !== undefined && payload.error !== null;
      finishTurn(slotId, { ok: !failed, error: failed ? String(payload.error) : undefined });
      return;
    }

    if (event.kind === "turn-cancelled" || event.kind === "stopped") {
      const slotId = slotByHandle(payload.handle);
      if (!slotId) return;
      finishTurn(slotId, { ok: false, error: t("cowork.errors.turnAborted") });
    }
  }

  async function ensureListener(): Promise<void> {
    if (listening) return;
    listening = true;
    await acp.onEvent((payload) => {
      handleAcpEvent(payload);
    });
  }

  async function teardown(list: readonly SlotRuntime[]): Promise<void> {
    await Promise.allSettled(list.map((runtime) => Promise.resolve(acp.stop(runtime.handle))));
  }

  /**
   * 成员位用哪个 ACP 后端：没指定就跟全局选中的那个（旧行为）。
   * 之所以接在成员数据上而不是整个 run 上：一次协作的价值就在于不同角色由不同 agent 跑，
   * 拆活的 leader 与执行的 builder 用同一个后端只是退化情况。
   */
  function providerOf(member: CoworkMemberInit): AgentProviderConfig | undefined {
    const wanted = member.providerId ?? agentStore.selectedProviderId;
    return agentStore.agentProviders.find((item) => item.id === wanted);
  }

  /* ===== 成员级会话配置：选项探测与应用 ===== */

  /** 各后端上报的会话配置选项（configId 下拉的数据源）；空数组 = 探测失败（防抖）。 */
  const providerOptions = ref<Record<string, AcpSessionConfigOption[]>>({});
  const probingProviders = ref<Record<string, boolean>>({});

  function optionsOf(providerId: string): AcpSessionConfigOption[] {
    return providerOptions.value[providerId] ?? [];
  }

  /**
   * 探测某后端暴露的会话配置（模型 / 思考强度…）：临时起一个会话拿 configOptions 再释放。
   *
   * 协作运行中直接跳过（复用本 store 的 ACP 客户端会互踩 handle）；结果按 providerId
   * 缓存，失败也缓存空数组防抖（CLI 缺失等情况不该每次展开下拉都重连一遍）。
   */
  async function probeProviderOptions(providerId: string): Promise<void> {
    if (providerOptions.value[providerId] || probingProviders.value[providerId]) return;
    if (active.value) return;
    const provider = agentStore.agentProviders.find((item) => item.id === providerId);
    if (!provider) return;
    probingProviders.value = { ...probingProviders.value, [providerId]: true };
    let handle: number | null = null;
    try {
      const workspace = await isolateForRun(activeConversationFolder() ?? (await resolveWorkspaceDir()));
      handle = await acp.startAgent(provider.command, settings.effectivePermissionTier, settings.sandboxMode, workspace);
      const opened = await acp.openSession(handle, workspace);
      providerOptions.value = { ...providerOptions.value, [providerId]: opened.configOptions ?? [] };
    } catch {
      providerOptions.value = { ...providerOptions.value, [providerId]: [] };
    } finally {
      if (handle !== null) {
        try {
          await acp.stop(handle);
        } catch {
          // 探测用的临时进程释放失败无碍主流程
        }
      }
      probingProviders.value = { ...probingProviders.value, [providerId]: false };
    }
  }

  /**
   * 起一次协作运行：每个成员位一个独立会话 + 独立 ACP 进程/会话。
   * 返回错误文案（null = 成功），与既有 store 的错误约定一致。
   */
  async function startRun(goalText: string, members: readonly CoworkMemberInit[]): Promise<string | null> {
    if (active.value) return t("cowork.errors.alreadyRunning");
    const trimmed = goalText.trim();
    if (!trimmed) return t("cowork.errors.emptyGoal");
    if (members.length === 0) return t("cowork.errors.noMembers");
    if (members.filter((member) => member.role === "leader").length !== 1) return t("cowork.errors.needOneLeader");
    if (!acp.isAvailable()) return t("errors.acpTransportUnavailable");
    // 逐个成员先验后端：拉进程起一半才发现某位成员后端不存在，前面那几个 agent 进程就成了孤儿。
    if (members.some((member) => !providerOf(member))) return t("errors.acpNotSelected");

    starting.value = true;
    lastError.value = null;
    const previousActive = sessionStore.activeSessionId;
    const created: Array<{ init: CoworkSlotInit; runtime: SlotRuntime }> = [];
    try {
      const workspace = await isolateForRun(activeConversationFolder() ?? (await resolveWorkspaceDir()));
      await ensureListener();
      let index = 0;
      for (const member of members) {
        index += 1;
        // 进循环前已逐个校验过，此处的兜底只是为了让 TS 信任后面 provider.command。
        const provider = providerOf(member);
        if (!provider) return t("errors.acpNotSelected");
        const session = sessionStore.createSession(workspaceStore.activeWorkspaceId, `${member.name} · ${trimmed}`);
        const handle = await acp.startAgent(provider.command, settings.effectivePermissionTier, settings.sandboxMode, workspace);
        // 每个成员位都拿到同一批启用的 MCP 服务器：协作里各人的工具面应当一致。
        const opened = await acp.openSession(handle, workspace, settings.enabledMcpServers);
        // 应用成员级会话配置（模型 / 思考强度等）：只对该后端暴露的 select 型项下发。
        // 单条失败不中断起跑——该成员位仍以后端默认跑，不值得让整次协作失败。
        if (member.configValues) {
          for (const [configId, value] of Object.entries(member.configValues)) {
            const option = opened.configOptions?.find((candidate) => candidate.id === configId && candidate.type === "select");
            if (!option) continue;
            try {
              await acp.setSessionConfig(handle, configId, value);
            } catch (error) {
              notify({
                kind: "warning",
                key: `cowork-config-${member.name}-${configId}`,
                title: t("cowork.memberConfig.applyFailed", { name: member.name }),
                detail: String(error),
              });
            }
          }
        }
        created.push({
          init: {
            id: `slot-${index}`,
            name: member.name,
            role: member.role,
            threadId: session.id,
            // 职能标签仅对执行者注入；leader 由引擎忽略（engine 层已过滤）。
            specialty: member.specialty,
          },
          runtime: { handle, sessionId: opened.sessionId, threadId: session.id, messageId: null, turnId: null },
        });
      }
    } catch (error) {
      await teardown(created.map((item) => item.runtime));
      starting.value = false;
      sessionStore.setActive(previousActive);
      const detail = t("errors.startFailed", { detail: String(error) });
      lastError.value = detail;
      return detail;
    }

    runtimes.clear();
    for (const item of created) runtimes.set(item.init.id, item.runtime);
    const instance = createCoworkEngine({
      goal: trimmed,
      slots: created.map((item) => item.init),
      maxParallel: () => runsStore.maxParallel,
      ports: { dispatch: dispatchTurn, emit: onEngineEvent },
    });
    engine.value = instance;
    starting.value = false;

    // leader 的会话留在前台：用户对着它说话，它负责往下派活。
    const leaderThread = created.find((item) => item.init.role === "leader")?.init.threadId ?? previousActive;
    if (leaderThread) {
      sessionStore.setActive(leaderThread);
      chat.activeThreadId = leaderThread;
    }
    instance.start();
    touch();
    return null;
  }

  function sendUser(text: string, to?: string): void {
    engine.value?.sendUser(text, to);
    touch();
  }

  function pauseRun(): void {
    engine.value?.pause();
    touch();
  }

  /** 抬高上限后恢复；返回 false 表示预算仍然触顶。 */
  function resumeRun(extraTurns = 20): boolean {
    const current = engine.value;
    if (!current) return false;
    const ok = current.resume({
      maxTurns: current.run.budget.maxTurns + extraTurns,
      maxWallClockMs: current.run.budget.maxWallClockMs + 10 * 60 * 1000,
    });
    touch();
    return ok;
  }

  async function stopRun(): Promise<void> {
    engine.value?.cancel();
    await teardown([...runtimes.values()]);
    runtimes.clear();
    touch();
  }

  return {
    goal,
    status,
    pausedReason,
    slots,
    tasks,
    activity,
    stats,
    spend,
    active,
    starting,
    lastError,
    coworkAvailable: acp.isAvailable(),
    providerOptions,
    probingProviders,
    optionsOf,
    probeProviderOptions,
    startRun,
    sendUser,
    pauseRun,
    resumeRun,
    stopRun,
  };
});
