import { describe, expect, it } from "vitest";
import { createTaskBoard } from "../../src/task-board";
import type { CoworkTask } from "../../src/types";

function harness() {
  const store: CoworkTask[] = [];
  let seq = 0;
  const board = createTaskBoard({
    runId: "cr-test",
    store,
    now: () => 1000 + seq,
    id: () => {
      seq += 1;
      return `ct-${seq}`;
    },
  });
  return { store, board };
}

describe("createTaskBoard", () => {
  it("建任务维护双向依赖链接", () => {
    const { board } = harness();
    const upstream = board.create({ subject: "实现" });
    const downstream = board.create({ subject: "评审", owner: "slot-b", blockedBy: [upstream.id] });

    expect(downstream.blockedBy).toEqual([upstream.id]);
    expect(board.get(upstream.id)?.blocks).toEqual([downstream.id]);
    expect(downstream.status).toBe("pending");
  });

  it("丢弃不存在的前置 id，避免造出永久阻塞的死任务", () => {
    const { board } = harness();
    const task = board.create({ subject: "评审", blockedBy: ["ct-999", ""] });
    expect(task.blockedBy).toEqual([]);
  });

  it("完成任务时返回刚变为无阻塞的下游任务", () => {
    const { board } = harness();
    const upstream = board.create({ subject: "实现" });
    const downstream = board.create({ subject: "评审", owner: "slot-b", blockedBy: [upstream.id] });

    const result = board.update(upstream.id, { status: "done", result: "已提交" });
    expect(result.task?.status).toBe("done");
    expect(result.task?.result).toBe("已提交");
    expect(result.unblocked.map((task) => task.id)).toEqual([downstream.id]);
    expect(board.get(downstream.id)?.blockedBy).toEqual([]);
  });

  it("多前置时只有最后一个完成才解除阻塞", () => {
    const { board } = harness();
    const first = board.create({ subject: "抓数据" });
    const second = board.create({ subject: "清洗" });
    const downstream = board.create({ subject: "建模", owner: "slot-c", blockedBy: [first.id, second.id] });

    expect(board.update(first.id, { status: "done" }).unblocked).toEqual([]);
    expect(board.get(downstream.id)?.blockedBy).toEqual([second.id]);

    const result = board.update(second.id, { status: "done" });
    expect(result.unblocked.map((task) => task.id)).toEqual([downstream.id]);
  });

  it("重复完成不会二次解除阻塞", () => {
    const { board } = harness();
    const upstream = board.create({ subject: "实现" });
    board.create({ subject: "评审", owner: "slot-b", blockedBy: [upstream.id] });

    expect(board.update(upstream.id, { status: "done" }).unblocked).toHaveLength(1);
    expect(board.update(upstream.id, { status: "done" }).unblocked).toEqual([]);
    expect(board.get(upstream.id)?.blocks).toEqual([]);
  });

  it("非 done 的更新只改字段，不动依赖图", () => {
    const { board } = harness();
    const upstream = board.create({ subject: "实现" });
    const downstream = board.create({ subject: "评审", blockedBy: [upstream.id] });

    board.update(upstream.id, { status: "in_progress", owner: "slot-a" });
    expect(board.get(upstream.id)?.owner).toBe("slot-a");
    expect(board.get(downstream.id)?.blockedBy).toEqual([upstream.id]);
  });

  it("更新不存在的任务返回 null，不抛错", () => {
    const { board } = harness();
    expect(board.update("ct-404", { status: "done" })).toEqual({ task: null, unblocked: [] });
  });

  it("byOwner 与 unfinished 反映当前任务板", () => {
    const { board } = harness();
    const a = board.create({ subject: "实现", owner: "slot-a" });
    board.create({ subject: "评审", owner: "slot-b" });
    expect(board.byOwner("slot-a").map((task) => task.subject)).toEqual(["实现"]);
    expect(board.unfinished()).toBe(2);

    board.update(a.id, { status: "done" });
    expect(board.unfinished()).toBe(1);
  });
});
