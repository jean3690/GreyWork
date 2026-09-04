import type { CoworkTask, CoworkTaskStatus } from "./types";

export interface TaskInput {
  subject: string;
  detail?: string;
  owner?: string;
  blockedBy?: string[];
}

export interface TaskPatch {
  status?: CoworkTaskStatus;
  owner?: string;
  detail?: string;
  result?: string;
}

/** 更新结果：`unblocked` 是「因这次更新刚变为完全无阻塞」的下游任务。 */
export interface TaskUpdateResult {
  task: CoworkTask | null;
  unblocked: CoworkTask[];
}

export interface TaskBoardDeps {
  runId: string;
  store: CoworkTask[];
  now(): number;
  id(): string;
}

export interface TaskBoard {
  create(input: TaskInput): CoworkTask;
  /**
   * 更新任务。status 变为 done 时顺手维护依赖图：把自己从下游的 blockedBy 中摘除，
   * 并把「刚变为无阻塞」的下游任务返回给调度器去唤醒负责人。
   */
  update(taskId: string, patch: TaskPatch): TaskUpdateResult;
  get(taskId: string): CoworkTask | null;
  list(): readonly CoworkTask[];
  byOwner(owner: string): CoworkTask[];
  /** 未完成（pending / in_progress）任务数，用于静止时汇报剩余工作。 */
  unfinished(): number;
}

export function createTaskBoard(deps: TaskBoardDeps): TaskBoard {
  const { runId, store, now, id } = deps;

  const find = (taskId: string): CoworkTask | undefined => store.find((task) => task.id === taskId);

  return {
    create(input) {
      const at = now();
      // 未知的前置 id 会让任务永久阻塞（没人能完成一个不存在的任务），
      // 故建任务时直接丢弃，宁可少一条依赖也不制造死任务。
      const blockedBy = (input.blockedBy ?? []).filter((upstreamId) => find(upstreamId) !== undefined);
      const task: CoworkTask = {
        id: id(),
        runId,
        subject: input.subject,
        detail: input.detail,
        owner: input.owner,
        status: "pending",
        blockedBy,
        blocks: [],
        createdAt: at,
        updatedAt: at,
      };
      store.push(task);
      for (const upstreamId of blockedBy) {
        const upstream = find(upstreamId);
        if (upstream && !upstream.blocks.includes(task.id)) upstream.blocks.push(task.id);
      }
      return task;
    },

    update(taskId, patch) {
      const task = find(taskId);
      if (!task) return { task: null, unblocked: [] };

      if (patch.status !== undefined) task.status = patch.status;
      if (patch.owner !== undefined) task.owner = patch.owner;
      if (patch.detail !== undefined) task.detail = patch.detail;
      if (patch.result !== undefined) task.result = patch.result;
      task.updatedAt = now();

      if (patch.status !== "done") return { task, unblocked: [] };

      const unblocked: CoworkTask[] = [];
      for (const downstreamId of task.blocks) {
        const downstream = find(downstreamId);
        if (!downstream) continue;
        const before = downstream.blockedBy.length;
        downstream.blockedBy = downstream.blockedBy.filter((upstreamId) => upstreamId !== task.id);
        if (before !== downstream.blockedBy.length) downstream.updatedAt = task.updatedAt;
        if (downstream.blockedBy.length === 0 && downstream.status === "pending") unblocked.push(downstream);
      }
      // 自己已完成，blocks 指针失去意义：清掉，避免重复完成时二次唤醒。
      task.blocks = [];
      return { task, unblocked };
    },

    get(taskId) {
      return find(taskId) ?? null;
    },

    list() {
      return store;
    },

    byOwner(owner) {
      return store.filter((task) => task.owner === owner);
    },

    unfinished() {
      return store.filter((task) => task.status === "pending" || task.status === "in_progress").length;
    },
  };
}
