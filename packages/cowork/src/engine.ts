import { createIdFactory } from "@greywork/core";
import { parseDirectives } from "./directives";
import { createLedger } from "./ledger";
import { createMailbox, type MailInput } from "./mailbox";
import { buildLeaderPrompt, buildTeammatePrompt, formatBoard, formatInbox } from "./prompts";
import { createTaskBoard } from "./task-board";
import { createWakeEngine } from "./wake-engine";
import {
  DEFAULT_COWORK_BUDGET,
  type BudgetBreach,
  type CoworkBudget,
  type CoworkDirective,
  type CoworkEvent,
  type CoworkMail,
  type CoworkPorts,
  type CoworkRole,
  type CoworkRun,
  type CoworkSlot,
  type WakeState,
} from "./types";

export interface CoworkSlotInit {
  id: string;
  name: string;
  role: CoworkRole;
  /** 该成员位绑定的会话 id：它的消息流全部落在这个会话里。 */
  threadId: string;
}

export interface CoworkEngineInit {
  goal: string;
  slots: readonly CoworkSlotInit[];
  ports: CoworkPorts;
  budget?: Partial<CoworkBudget>;
  /** 同时在跑的回合上限，默认 2（与既有并行编排一致）。 */
  maxParallel?: number | (() => number);
  runId?: string;
}

/** 回合结果。`summary` 会作为进度通知投给 leader，省得成员再手写一条 message。 */
export interface TurnOutcome {
  /** 省略即视为成功；只有显式 false 才算失败。 */
  ok?: boolean;
  error?: string;
  summary?: string;
}

export interface CoworkStats {
  inflight: number;
  queued: number;
  unread: number;
  unfinishedTasks: number;
}

export interface CoworkEngine {
  /** 运行快照。可整体序列化归档，也可直接交给 Vue 做响应式包装。 */
  readonly run: CoworkRun;
  /** 把目标投进 leader 收件箱并唤醒它。 */
  start(): void;
  /** 用户发言。`to` 省略时发给 leader；运行已结束时会复活该运行。 */
  sendUser(text: string, to?: string): void;
  /** 解析并执行 agent 输出里的协作指令，返回真正生效的那些。 */
  applyOutput(slotId: string, output: string): CoworkDirective[];
  /** 回合结束。必须调用，否则该成员位的唤醒锁不会释放。 */
  turnEnded(slotId: string, outcome?: TurnOutcome): void;
  recordUsage(slotId: string, usage: { tokens?: number; cost?: number }): void;
  pause(reason?: BudgetBreach): void;
  /** 恢复运行。预算仍触顶时返回 false（需要用 `extra` 抬高对应上限）。 */
  resume(extra?: Partial<CoworkBudget>): boolean;
  cancel(): void;
  slotOf(slotId: string): CoworkSlot | null;
  wakeStateOf(slotId: string): WakeState;
  /** 引用计数式静止判定：没有在跑的回合、没有排队、没有未读信。 */
  isQuiescent(): boolean;
  stats(): CoworkStats;
}

const normalize = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, "");

export function createCoworkEngine(init: CoworkEngineInit): CoworkEngine {
  const ports = init.ports;
  const now = ports.now ?? ((): number => Date.now());
  const customId = ports.id;
  const startedAt = now();

  const run: CoworkRun = {
    id: init.runId ?? `cr-${startedAt.toString(36)}`,
    goal: init.goal,
    status: "running",
    slots: init.slots.map((slot) => ({
      id: slot.id,
      name: slot.name,
      role: slot.role,
      status: "pending",
      threadId: slot.threadId,
      turns: 0,
    })),
    tasks: [],
    mail: [],
    budget: { ...DEFAULT_COWORK_BUDGET, ...init.budget },
    spend: { turns: 0, turnsBySlot: {}, usageBySlot: {}, startedAt },
    createdAt: startedAt,
  };

  const mailbox = createMailbox({
    runId: run.id,
    store: run.mail,
    now,
    id: customId ? (): string => customId("cm") : createIdFactory("cm"),
  });
  const taskBoard = createTaskBoard({
    runId: run.id,
    store: run.tasks,
    now,
    id: customId ? (): string => customId("ct") : createIdFactory("ct"),
  });
  const ledger = createLedger({ budget: run.budget, spend: run.spend, now });

  const emit = (event: CoworkEvent): void => {
    ports.emit?.(event);
  };

  /** 写信并广播事件。所有投递都走这里，避免漏掉 UI 通知。 */
  const post = (input: MailInput): CoworkMail => {
    const mail = mailbox.write(input);
    emit({ kind: "mail", mail });
    return mail;
  };

  const leaderSlot = (): CoworkSlot | undefined => run.slots.find((slot) => slot.role === "leader");
  const slotById = (slotId: string): CoworkSlot | undefined => run.slots.find((slot) => slot.id === slotId);

  /** 成员位引用解析：id → 全名 → leader 别名 → 名字前缀（模型爱用缩写）。 */
  const resolveSlot = (ref: string): CoworkSlot | null => {
    const key = normalize(ref);
    if (!key) return null;
    const exact = run.slots.find((slot) => normalize(slot.id) === key || normalize(slot.name) === key);
    if (exact) return exact;
    if (key === "leader" || key === "lead") return leaderSlot() ?? null;
    return run.slots.find((slot) => normalize(slot.name).startsWith(key)) ?? null;
  };

  const wake = createWakeEngine({
    maxParallel: init.maxParallel ?? 2,
    hasWork: (slotId) => mailbox.unread(slotId) > 0,
    dispatch: (slotId) => dispatchSlot(slotId),
    onState: (slotId, state) => emit({ kind: "slot-state", slotId, state }),
  });

  /** 除 leader 外是否还有成员位在跑或在排队。 */
  const teammatesBusy = (): boolean => {
    const queued = wake.queued();
    return run.slots.some((slot) => slot.role !== "leader" && (wake.stateOf(slot.id) !== "idle" || queued.includes(slot.id)));
  };

  function pause(reason?: BudgetBreach): void {
    if (run.status !== "running") return;
    run.status = "paused";
    run.pausedReason = reason;
    wake.block();
    emit({ kind: "run-status", status: "paused", breach: reason });
  }

  /** 静止即完成：唤醒图上没有出边了，运行到达定点。 */
  function settle(): void {
    if (run.status !== "running") return;
    if (wake.inflight() > 0 || wake.queued().length > 0 || mailbox.unread() > 0) return;
    run.status = "done";
    run.finishedAt = now();
    emit({ kind: "run-status", status: "done" });
    emit({ kind: "quiesced", unfinishedTasks: taskBoard.unfinished() });
  }

  function dispatchSlot(slotId: string): void {
    const slot = slotById(slotId);
    if (!slot) return;
    if (run.status !== "running") {
      wake.turnEnded(slotId);
      return;
    }
    const breach = ledger.breach();
    if (breach) {
      // 触顶不杀进程、不丢信：信件留在收件箱，抬高上限 resume 后继续。
      pause(breach);
      wake.turnEnded(slotId);
      return;
    }

    const mail = mailbox.drain(slotId);
    if (mail.length === 0) {
      // hasWork 与 drain 之间理论上不会有人插队清空收件箱，但真发生时也不能
      // 把运行卡在「还有活」的错觉里：释放锁并重新判定静止。
      wake.turnEnded(slotId);
      settle();
      return;
    }

    const firstActivation = slot.turns === 0 || slot.status === "failed";
    slot.status = "ready";
    slot.error = undefined;
    slot.turns += 1;
    ledger.chargeTurn(slotId);

    const sections = [formatBoard(run.tasks, run.slots), formatInbox(mail, run.slots)];
    const rolePrompt = !firstActivation
      ? null
      : slot.role === "leader"
        ? buildLeaderPrompt({ goal: run.goal, slots: run.slots, budget: run.budget })
        : buildTeammatePrompt({ slot, slots: run.slots });

    const prompt = (rolePrompt ? [rolePrompt, ...sections] : sections).join("\n\n");
    void Promise.resolve(ports.dispatch({ slot, prompt, kind: rolePrompt ? "role" : "inbox", mail })).catch((error: unknown) => {
      turnEnded(slotId, { ok: false, error: String(error) });
    });
  }

  function turnEnded(slotId: string, outcome?: TurnOutcome): void {
    const slot = slotById(slotId);
    if (!slot) return;
    if (outcome?.ok === false) {
      slot.status = "failed";
      slot.error = outcome.error;
    }

    const leader = leaderSlot();
    const notifyLeader = leader !== undefined && leader.id !== slot.id;
    if (leader && notifyLeader) {
      post({
        from: slot.id,
        to: leader.id,
        kind: "idle_notice",
        body:
          outcome?.ok === false
            ? `${slot.name} 回合失败：${outcome.error ?? "未知错误"}。可以重派任务、换人或调整计划。`
            : (outcome?.summary?.trim() ?? "") || `${slot.name} 本回合结束。`,
        summary: outcome?.ok === false ? "回合失败" : "回合结束",
      });
    }

    wake.turnEnded(slotId);

    // 进度通知合并唤醒 leader：只在没有成员位还在跑/排队时叫醒它，N 条通知折叠成
    // leader 的一个回合。成员位主动发给 leader 的 message 在 applyOutput 里立刻
    // 唤醒，不受这里的合并影响——于是既不抖动，也不会被慢成员堵住。
    if (leader && notifyLeader && !teammatesBusy()) wake.wake(leader.id);
    settle();
  }

  function applyDirective(sender: CoworkSlot, directive: CoworkDirective): boolean {
    if (directive.op === "message") {
      const targets =
        directive.to.trim() === "*"
          ? run.slots.filter((slot) => slot.id !== sender.id)
          : [resolveSlot(directive.to)].filter((slot): slot is CoworkSlot => slot !== null && slot.id !== sender.id);
      if (targets.length === 0) return false;
      for (const target of targets) {
        post({ from: sender.id, to: target.id, body: directive.body, summary: directive.summary });
        wake.wake(target.id);
      }
      return true;
    }

    if (directive.op === "task") {
      const owner = directive.owner ? resolveSlot(directive.owner) : null;
      const task = taskBoard.create({
        subject: directive.subject,
        detail: directive.detail,
        owner: owner?.id,
        blockedBy: directive.blockedBy,
      });
      emit({ kind: "task", task, change: "created" });
      // 建任务即投递：省掉「建完还要再发一条通知」这一步，也就省掉了漏通知这一类 bug。
      // 有前置的任务此刻不唤醒——前置完成时机制会自动唤醒负责人。
      if (owner && task.blockedBy.length === 0) {
        post({
          from: sender.id,
          to: owner.id,
          kind: "assignment",
          body: `任务「${task.subject}」已派给你。${directive.detail ?? ""}`.trim(),
          summary: task.subject,
          taskId: task.id,
        });
        wake.wake(owner.id);
      }
      return true;
    }

    const { task, unblocked } = taskBoard.update(directive.taskId, {
      status: directive.status,
      result: directive.result,
    });
    if (!task) return false;
    emit({ kind: "task", task, change: "updated" });
    for (const next of unblocked) {
      if (!next.owner) continue;
      post({
        from: sender.id,
        to: next.owner,
        kind: "unblocked",
        body: `前置任务「${task.subject}」已完成，可以开始「${next.subject}」。`,
        summary: next.subject,
        taskId: next.id,
      });
      wake.wake(next.owner);
    }
    return true;
  }

  function sendUser(text: string, to?: string): void {
    const body = text.trim();
    if (!body) return;
    const target = to ? resolveSlot(to) : (leaderSlot() ?? null);
    if (!target) return;
    // cancelled / failed 是终态：用户要继续就新建一次运行，不要让旧运行悄悄复活。
    if (run.status === "cancelled" || run.status === "failed") return;
    // 自然静止后又来消息 = 继续这次协作，复活即可。
    if (run.status === "done") {
      run.status = "running";
      run.finishedAt = undefined;
      emit({ kind: "run-status", status: "running" });
    }
    post({ from: "user", to: target.id, body });
    wake.wake(target.id);
  }

  return {
    run,

    start() {
      const leader = leaderSlot();
      if (!leader) return;
      post({ from: "user", to: leader.id, body: `目标：${run.goal}` });
      wake.wake(leader.id);
    },

    sendUser,

    applyOutput(slotId, output) {
      const sender = slotById(slotId);
      if (!sender) return [];
      const applied: CoworkDirective[] = [];
      for (const directive of parseDirectives(output)) {
        if (applyDirective(sender, directive)) applied.push(directive);
      }
      return applied;
    },

    turnEnded,

    recordUsage(slotId, usage) {
      ledger.recordUsage(slotId, usage);
      const breach = ledger.breach();
      if (breach) pause(breach);
    },

    pause,

    resume(extra) {
      if (run.status !== "paused") return false;
      // 必须原地改：账本闭包持有的是这个 budget 对象引用，整体替换会让新上限失效。
      if (extra) Object.assign(run.budget, extra);
      if (ledger.breach()) return false;
      run.status = "running";
      run.pausedReason = undefined;
      wake.unblock();
      emit({ kind: "run-status", status: "running" });
      for (const slot of run.slots) {
        if (mailbox.unread(slot.id) > 0) wake.wake(slot.id);
      }
      settle();
      return true;
    },

    cancel() {
      if (run.status === "done" || run.status === "cancelled") return;
      run.status = "cancelled";
      run.finishedAt = now();
      wake.clear();
      emit({ kind: "run-status", status: "cancelled" });
    },

    slotOf(slotId) {
      return slotById(slotId) ?? null;
    },

    wakeStateOf(slotId) {
      return wake.stateOf(slotId);
    },

    isQuiescent() {
      return wake.inflight() === 0 && wake.queued().length === 0 && mailbox.unread() === 0;
    },

    stats() {
      return {
        inflight: wake.inflight(),
        queued: wake.queued().length,
        unread: mailbox.unread(),
        unfinishedTasks: taskBoard.unfinished(),
      };
    },
  };
}
