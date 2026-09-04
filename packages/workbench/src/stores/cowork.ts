import { createAcpClient } from "@greywork/acp";
import {
  createCoworkEngine,
  type CoworkDispatchInput,
  type CoworkEngine,
  type CoworkEvent,
  type CoworkMail,
  type CoworkRole,
  type CoworkSlotInit,
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
import { resolveWorkspaceDir } from "../lib/workspace-dir";
import type { ThreadMessage } from "../types";
import { useAgentStore } from "./agent";
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
}

export interface CoworkSlotView {
  id: string;
  name: string;
  role: CoworkRole;
  status: string;
  turns: number;
  threadId: string;
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
    if (message && !output.trim()) chat.setMessageContent(message.id, t("chat.noOutput"), runtime.threadId);
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
    const provider = agentStore.agentProviders.find((item) => item.id === agentStore.selectedProviderId);
    if (!provider) return t("errors.acpNotSelected");

    starting.value = true;
    lastError.value = null;
    const previousActive = sessionStore.activeSessionId;
    const created: Array<{ init: CoworkSlotInit; runtime: SlotRuntime }> = [];
    try {
      const workspace = activeConversationFolder() ?? (await resolveWorkspaceDir());
      await ensureListener();
      let index = 0;
      for (const member of members) {
        index += 1;
        const session = sessionStore.createSession(workspaceStore.activeWorkspaceId, `${member.name} · ${trimmed}`);
        const handle = await acp.startAgent(provider.command, settings.effectivePermissionTier, settings.sandboxMode, workspace);
        // 每个成员位都拿到同一批启用的 MCP 服务器：协作里各人的工具面应当一致。
        const opened = await acp.openSession(handle, workspace, settings.enabledMcpServers);
        created.push({
          init: { id: `slot-${index}`, name: member.name, role: member.role, threadId: session.id },
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
      maxParallel: () => agentStore.maxParallel,
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
    startRun,
    sendUser,
    pauseRun,
    resumeRun,
    stopRun,
  };
});
