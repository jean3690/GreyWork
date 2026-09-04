/**
 * Cowork 协作机制的数据契约。
 *
 * 机制取向：没有中央调度器，只有「持久化收件箱 + 边触发唤醒」。每个动作
 * （用户发言、agent 指令、任务解除阻塞）都先写一封信，再唤醒收信的成员位；
 * 唤醒本身不携带内容，内容一律从收件箱取。
 */

/** 成员位角色：leader 只做拆解/派活/汇总，teammate 执行具体任务。 */
export type CoworkRole = "leader" | "teammate";

/** 成员位生命周期：pending 运行时未起 / ready 可派活 / failed 起不来或回合出错（可重试）。 */
export type SlotStatus = "pending" | "ready" | "failed";

/**
 * 唤醒锁三态。
 *
 * running 期间到达的唤醒置为 dirty，回合收尾后立刻自唤醒——绝不丢弃唤醒。
 * 「忙就 return」的写法会让链尾那封信永久滞留在收件箱里（lost wakeup），
 * 因为不再有下一次唤醒来把它带出来。
 */
export type WakeState = "idle" | "running" | "dirty";

/**
 * 信件类型。
 * - `message`：用户或成员位之间的自由消息。
 * - `assignment`：任务派发（建任务即投递，不需要 agent 再补一封通知）。
 * - `unblocked`：前置任务完成，机制自动通知下游负责人开工。
 * - `idle_notice`：teammate 回合结束的进度通知，汇总给 leader。
 */
export type MailKind = "message" | "assignment" | "unblocked" | "idle_notice";

/** 一封信。`read` 由收件箱的同步临界区翻转，外部不应直接改。 */
export interface CoworkMail {
  id: string;
  runId: string;
  /** 发信方：成员位 id 或 `"user"`。 */
  from: string;
  /** 收信方：成员位 id。 */
  to: string;
  kind: MailKind;
  body: string;
  /** 一句话摘要，用于 UI 与 leader 汇总视图。 */
  summary?: string;
  /** 关联任务 id（assignment / unblocked 必带）。 */
  taskId?: string;
  createdAt: number;
  read: boolean;
}

export type CoworkTaskStatus = "pending" | "in_progress" | "done" | "failed";

/**
 * 任务板上的一项工作。`blockedBy` / `blocks` 是双向图：调度器读它来做
 * 依赖驱动唤醒，所以依赖关系必须落在数据里，而不是写在 prompt 里让模型自己排序。
 */
export interface CoworkTask {
  id: string;
  runId: string;
  subject: string;
  detail?: string;
  /** 负责人成员位 id。 */
  owner?: string;
  status: CoworkTaskStatus;
  /** 本任务依赖的上游任务 id。 */
  blockedBy: string[];
  /** 依赖本任务的下游任务 id。 */
  blocks: string[];
  /** 完成结论。长产出写在这里而不是塞进信里，避免 leader 上下文被全文淹没。 */
  result?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * 成员位。
 *
 * `threadId` 是它自己的会话（thread）id：成员位的全部消息落在自己的会话里，
 * 于是流式渲染、权限确认、模型切换整套单聊能力可以直接复用。
 * ACP 侧的 handle / sessionId 不在这里——引擎不认识 ACP，绑定关系由上层维护。
 */
export interface CoworkSlot {
  id: string;
  name: string;
  role: CoworkRole;
  status: SlotStatus;
  threadId: string;
  /** 已消耗回合数，预算账本的计费单位。 */
  turns: number;
  /** 最近一次失败原因（status 为 failed 时有值）。 */
  error?: string;
}

export type CoworkRunStatus = "running" | "paused" | "done" | "failed" | "cancelled";

/** 预算触顶原因。触顶只暂停不杀进程，决定权交回用户。 */
export type BudgetBreach = "run_turns" | "slot_turns" | "wall_clock" | "tokens" | "cost";

/** 一次协作运行的资源上限。多 agent 互相唤醒时这是唯一能兜住成本的东西。 */
export interface CoworkBudget {
  /** 整个 run 的回合上限。 */
  maxTurns: number;
  /** 单个成员位的回合上限。 */
  maxTurnsPerSlot: number;
  /** 墙钟上限（毫秒）。 */
  maxWallClockMs: number;
  /** 上下文 token 上限（各成员位快照求和）。 */
  maxTokens?: number;
  /** 费用上限（各成员位快照求和，货币单位由 provider 决定）。 */
  maxCost?: number;
}

/** ACP 的 usage 事件是「本会话累计」快照而非增量，故按成员位存最新值再求和。 */
export interface CoworkUsage {
  tokens: number;
  cost: number;
}

export interface CoworkSpend {
  turns: number;
  turnsBySlot: Record<string, number>;
  usageBySlot: Record<string, CoworkUsage>;
  startedAt: number;
}

/** 一次协作运行的完整快照：可整体序列化进归档（与既有 team_runs 同款不透明载荷）。 */
export interface CoworkRun {
  id: string;
  goal: string;
  status: CoworkRunStatus;
  slots: CoworkSlot[];
  tasks: CoworkTask[];
  mail: CoworkMail[];
  budget: CoworkBudget;
  spend: CoworkSpend;
  /** status 为 paused 时的触顶原因。 */
  pausedReason?: BudgetBreach;
  createdAt: number;
  finishedAt?: number;
}

/** 默认预算：够跑完一次多人协作，又不至于在跑飞时无声烧钱。 */
export const DEFAULT_COWORK_BUDGET: CoworkBudget = {
  maxTurns: 40,
  maxTurnsPerSlot: 15,
  maxWallClockMs: 20 * 60 * 1000,
};

/** agent 通过输出里的 ```cowork 代码块调用的协作指令。 */
export type CoworkDirective =
  | { op: "message"; to: string; body: string; summary?: string }
  | { op: "task"; subject: string; detail?: string; owner?: string; blockedBy?: string[] }
  | { op: "task_update"; taskId: string; status?: CoworkTaskStatus; result?: string };

/** 引擎对外广播的事件；上层（store）转成 UI 状态或应用事件总线消息。 */
export type CoworkEvent =
  | { kind: "slot-state"; slotId: string; state: WakeState }
  | { kind: "mail"; mail: CoworkMail }
  | { kind: "task"; task: CoworkTask; change: "created" | "updated" }
  | { kind: "run-status"; status: CoworkRunStatus; breach?: BudgetBreach }
  | { kind: "quiesced"; unfinishedTasks: number };

/** 一次回合派发请求。`kind` 区分首轮角色 prompt 与后续只投收件箱。 */
export interface CoworkDispatchInput {
  slot: CoworkSlot;
  prompt: string;
  kind: "role" | "inbox";
  /** 本回合投递的信件（上层可据此在会话里落一条可审计的系统消息）。 */
  mail: CoworkMail[];
}

/**
 * 引擎的副作用端口。引擎自身是纯的：不认识 ACP、不认识 Pinia、不起定时器。
 * `dispatch` 返回即代表「回合已发起」，回合结束必须由上层调用 `turnEnded`。
 */
export interface CoworkPorts {
  dispatch(input: CoworkDispatchInput): void | Promise<void>;
  now?(): number;
  id?(prefix: string): string;
  emit?(event: CoworkEvent): void;
}
