import { describe, expect, it } from "vitest";
import { createCoworkEngine, type CoworkSlotInit } from "../../src/engine";
import type { CoworkBudget, CoworkDispatchInput, CoworkEvent } from "../../src/types";

/** 把指令包成 agent 输出里的 ```cowork 围栏。 */
const fence = (ops: unknown): string => `\`\`\`cowork\n${JSON.stringify(ops)}\n\`\`\``;

interface HarnessOptions {
  budget?: Partial<CoworkBudget>;
  maxParallel?: number;
  slots?: readonly CoworkSlotInit[];
}

/**
 * 三人小队：Alpha（leader）、Builder、Reviewer。
 * dispatch 端口只记录不执行，回合何时结束由测试显式控制——这正是真实上层
 * （ACP prompt-done 事件）的行为。
 */
function harness(options: HarnessOptions = {}) {
  let clock = 0;
  const seqs: Record<string, number> = {};
  const dispatches: CoworkDispatchInput[] = [];
  const events: CoworkEvent[] = [];

  const engine = createCoworkEngine({
    goal: "上线登录功能",
    slots: options.slots ?? [
      { id: "slot-lead", name: "Alpha", role: "leader", threadId: "ses-1" },
      { id: "slot-a", name: "Builder", role: "teammate", threadId: "ses-2" },
      { id: "slot-b", name: "Reviewer", role: "teammate", threadId: "ses-3" },
    ],
    budget: options.budget,
    maxParallel: options.maxParallel ?? 2,
    ports: {
      now: () => clock,
      id: (prefix) => {
        seqs[prefix] = (seqs[prefix] ?? 0) + 1;
        return `${prefix}-${seqs[prefix]}`;
      },
      dispatch: (input) => {
        dispatches.push(input);
      },
      emit: (event) => {
        events.push(event);
      },
    },
  });

  return {
    engine,
    dispatches,
    events,
    slotsOf: () => dispatches.map((item) => item.slot.id),
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

describe("cowork 引擎：派发与角色 prompt", () => {
  it("start 把目标投进 leader 收件箱并注入角色 prompt", () => {
    const { engine, dispatches } = harness();
    engine.start();

    expect(dispatches).toHaveLength(1);
    const first = dispatches[0]!;
    expect(first.slot.id).toBe("slot-lead");
    expect(first.kind).toBe("role");
    expect(first.prompt).toContain("你是团队 leader");
    expect(first.prompt).toContain("上线登录功能");
    expect(first.prompt).toContain("待命规则");
    expect(first.mail.map((mail) => mail.body)).toEqual(["目标：上线登录功能"]);
    expect(engine.run.spend.turns).toBe(1);
    expect(engine.wakeStateOf("slot-lead")).toBe("running");
  });

  it("非首轮只投收件箱，不再重放角色 prompt", () => {
    const { engine, dispatches } = harness();
    engine.start();
    engine.turnEnded("slot-lead");
    engine.sendUser("补充一条需求");

    expect(dispatches).toHaveLength(2);
    expect(dispatches[1]!.kind).toBe("inbox");
    expect(dispatches[1]!.prompt).not.toContain("你是团队 leader");
    expect(dispatches[1]!.prompt).toContain("补充一条需求");
  });
});

describe("cowork 引擎：任务派发与依赖驱动唤醒", () => {
  it("建带负责人的任务即刻派发，不需要额外补一条通知", () => {
    const { engine, dispatches } = harness();
    engine.start();
    engine.applyOutput("slot-lead", fence([{ op: "task", subject: "实现登录", owner: "Builder", detail: "含表单校验" }]));

    expect(dispatches).toHaveLength(2);
    const assigned = dispatches[1]!;
    expect(assigned.slot.id).toBe("slot-a");
    expect(assigned.kind).toBe("role");
    expect(assigned.prompt).toContain("你是团队成员 Builder");
    expect(assigned.mail[0]!.kind).toBe("assignment");
    expect(assigned.prompt).toContain("实现登录");
    expect(engine.run.tasks[0]).toMatchObject({ owner: "slot-a", status: "pending" });
  });

  it("有前置的任务先不唤醒，前置完成后机制自动唤醒下游负责人", () => {
    const { engine, dispatches, slotsOf } = harness({ maxParallel: 3 });
    engine.start();
    engine.applyOutput(
      "slot-lead",
      fence([
        { op: "task", subject: "实现登录", owner: "Builder" },
        { op: "task", subject: "评审实现", owner: "Reviewer", blockedBy: ["ct-1"] },
      ]),
    );

    // Reviewer 被阻塞，不该被叫起来干等——这正是 prompt 里不必写「排好顺序」的原因
    expect(slotsOf()).toEqual(["slot-lead", "slot-a"]);
    expect(engine.run.tasks[1]!.blockedBy).toEqual(["ct-1"]);

    engine.applyOutput("slot-a", fence([{ op: "task_update", taskId: "ct-1", status: "done", result: "已实现" }]));

    expect(slotsOf()).toEqual(["slot-lead", "slot-a", "slot-b"]);
    const unblocked = dispatches[2]!;
    expect(unblocked.mail[0]!.kind).toBe("unblocked");
    expect(unblocked.prompt).toContain("评审实现");
    expect(unblocked.prompt).toContain("已实现");
  });

  it("无人负责的下游任务解除阻塞后不唤醒任何人", () => {
    const { engine, slotsOf } = harness({ maxParallel: 3 });
    engine.start();
    engine.applyOutput(
      "slot-lead",
      fence([
        { op: "task", subject: "实现登录", owner: "Builder" },
        { op: "task", subject: "待定后续", blockedBy: ["ct-1"] },
      ]),
    );
    engine.applyOutput("slot-a", fence([{ op: "task_update", taskId: "ct-1", status: "done" }]));

    expect(slotsOf()).toEqual(["slot-lead", "slot-a"]);
    expect(engine.run.tasks[1]!.blockedBy).toEqual([]);
  });
});

describe("cowork 引擎：唤醒合并", () => {
  it("回合中到达的多封信合并成收尾后的一次补派", () => {
    const { engine, dispatches } = harness();
    engine.start();
    engine.sendUser("再补一条需求");
    engine.sendUser("还有一条");

    expect(engine.wakeStateOf("slot-lead")).toBe("dirty");
    expect(dispatches).toHaveLength(1);

    engine.turnEnded("slot-lead");
    expect(dispatches).toHaveLength(2);
    expect(dispatches[1]!.mail).toHaveLength(2);
  });

  it("成员位还在跑时不叫醒 leader，全部收尾后一次性汇总", () => {
    const { engine, dispatches } = harness({ maxParallel: 3 });
    engine.start();
    engine.applyOutput(
      "slot-lead",
      fence([
        { op: "task", subject: "实现", owner: "Builder" },
        { op: "task", subject: "写测试", owner: "Reviewer" },
      ]),
    );
    engine.turnEnded("slot-lead");
    const before = dispatches.length;

    engine.turnEnded("slot-a", { summary: "登录实现完成" });
    expect(dispatches).toHaveLength(before);

    engine.turnEnded("slot-b", { summary: "测试写完" });
    expect(dispatches).toHaveLength(before + 1);
    const leaderTurn = dispatches[before]!;
    expect(leaderTurn.slot.id).toBe("slot-lead");
    expect(leaderTurn.mail).toHaveLength(2);
    expect(leaderTurn.mail.every((mail) => mail.kind === "idle_notice")).toBe(true);
    expect(leaderTurn.prompt).toContain("登录实现完成");
  });

  it("成员位主动发消息给 leader 时立刻唤醒，不受合并限制", () => {
    const { engine, dispatches } = harness({ maxParallel: 3 });
    engine.start();
    engine.applyOutput(
      "slot-lead",
      fence([
        { op: "task", subject: "实现", owner: "Builder" },
        { op: "task", subject: "写测试", owner: "Reviewer" },
      ]),
    );
    engine.turnEnded("slot-lead");
    const before = dispatches.length;

    engine.applyOutput("slot-a", fence([{ op: "message", to: "leader", body: "需求有歧义，按 A 还是 B？" }]));

    expect(dispatches).toHaveLength(before + 1);
    expect(dispatches[before]!.slot.id).toBe("slot-lead");
    expect(dispatches[before]!.prompt).toContain("需求有歧义");
  });

  it("广播发给除自己以外的全部成员位", () => {
    const { engine, dispatches } = harness({ maxParallel: 3 });
    engine.start();
    // 不先结束 leader 回合：它一收尾就没有未读、没有在跑回合，运行会立刻判定静止完成。
    engine.applyOutput("slot-lead", fence([{ op: "message", to: "*", body: "同步一下进度" }]));

    expect(
      dispatches
        .slice(1)
        .map((item) => item.slot.id)
        .sort(),
    ).toEqual(["slot-a", "slot-b"]);
  });

  it("自己发给自己与发给不存在的人都被丢弃", () => {
    const { engine, dispatches } = harness();
    engine.start();
    const applied = engine.applyOutput(
      "slot-a",
      fence([
        { op: "message", to: "Builder", body: "自言自语" },
        { op: "message", to: "不存在的人", body: "在吗" },
      ]),
    );

    expect(applied).toEqual([]);
    expect(dispatches).toHaveLength(1);
  });
});

describe("cowork 引擎：预算与暂停", () => {
  it("回合触顶时暂停而不是杀掉，信件保留，抬高上限后继续", () => {
    const { engine, dispatches, events } = harness({ budget: { maxTurns: 1 } });
    engine.start();
    engine.applyOutput("slot-lead", fence([{ op: "task", subject: "实现", owner: "Builder" }]));

    expect(dispatches).toHaveLength(1);
    expect(engine.run.status).toBe("paused");
    expect(engine.run.pausedReason).toBe("run_turns");
    expect(engine.stats().unread).toBe(1);
    expect(events.some((event) => event.kind === "run-status" && event.breach === "run_turns")).toBe(true);

    expect(engine.resume()).toBe(false);
    expect(engine.resume({ maxTurns: 5 })).toBe(true);
    expect(dispatches).toHaveLength(2);
    expect(dispatches[1]!.slot.id).toBe("slot-a");
    expect(dispatches[1]!.mail[0]!.kind).toBe("assignment");
  });

  it("墙钟触顶同样只暂停", () => {
    const { engine, tick } = harness({ budget: { maxWallClockMs: 1000 } });
    engine.start();
    tick(2000);
    engine.applyOutput("slot-lead", fence([{ op: "task", subject: "实现", owner: "Builder" }]));

    expect(engine.run.status).toBe("paused");
    expect(engine.run.pausedReason).toBe("wall_clock");
  });

  it("usage 上报触顶时立即暂停", () => {
    const { engine } = harness({ budget: { maxTokens: 100 } });
    engine.start();
    engine.recordUsage("slot-lead", { tokens: 150 });

    expect(engine.run.status).toBe("paused");
    expect(engine.run.pausedReason).toBe("tokens");
  });
});

describe("cowork 引擎：静止判定与失败恢复", () => {
  it("没有在跑回合、没有排队、没有未读即判完成，并报告未完成任务数", () => {
    const { engine, events } = harness();
    engine.start();
    engine.applyOutput("slot-lead", fence([{ op: "task", subject: "实现", owner: "Builder" }]));
    engine.turnEnded("slot-lead");
    engine.turnEnded("slot-a", { summary: "干完了" });
    engine.turnEnded("slot-lead");

    expect(engine.isQuiescent()).toBe(true);
    expect(engine.run.status).toBe("done");
    expect(engine.run.finishedAt).toBeDefined();
    expect(events).toContainEqual({ kind: "quiesced", unfinishedTasks: 1 });
  });

  it("静止后用户再发言会复活同一次运行", () => {
    const { engine, dispatches } = harness();
    engine.start();
    engine.turnEnded("slot-lead");
    expect(engine.run.status).toBe("done");

    engine.sendUser("再改一版");
    expect(engine.run.status).toBe("running");
    expect(engine.run.finishedAt).toBeUndefined();
    expect(dispatches).toHaveLength(2);
  });

  it("成员位失败会通知 leader，重派时重放角色 prompt", () => {
    const { engine, dispatches } = harness();
    engine.start();
    engine.applyOutput("slot-lead", fence([{ op: "task", subject: "实现", owner: "Builder" }]));
    engine.turnEnded("slot-lead");
    engine.turnEnded("slot-a", { ok: false, error: "agent 进程退出" });

    expect(engine.slotOf("slot-a")).toMatchObject({ status: "failed", error: "agent 进程退出" });
    const leaderTurn = dispatches[dispatches.length - 1]!;
    expect(leaderTurn.slot.id).toBe("slot-lead");
    expect(leaderTurn.prompt).toContain("回合失败");

    engine.sendUser("重试一次", "Builder");
    const retry = dispatches[dispatches.length - 1]!;
    expect(retry.slot.id).toBe("slot-a");
    expect(retry.kind).toBe("role");
    expect(engine.slotOf("slot-a")?.status).toBe("ready");
  });

  it("取消是终态：之后的用户发言不会复活运行", () => {
    const { engine, dispatches } = harness();
    engine.start();
    engine.cancel();
    const before = dispatches.length;

    engine.sendUser("还在吗");
    expect(dispatches).toHaveLength(before);
    expect(engine.run.status).toBe("cancelled");
  });
});

describe("cowork 引擎：teammate 职能标签", () => {
  it("带 specialty 的成员位：role prompt 注入职能定位，slot 视图透传标签", () => {
    const { engine, dispatches } = harness({
      slots: [
        { id: "slot-lead", name: "Alpha", role: "leader", threadId: "ses-1" },
        { id: "slot-a", name: "Builder", role: "teammate", threadId: "ses-2", specialty: "builder" },
        { id: "slot-b", name: "Searcher", role: "teammate", threadId: "ses-3", specialty: "researcher" },
      ],
    });
    engine.start();
    engine.applyOutput("slot-lead", fence([{ op: "task", subject: "调研竞品", owner: "Searcher" }]));

    expect(engine.slotOf("slot-a")?.specialty).toBe("builder");
    expect(engine.slotOf("slot-b")?.specialty).toBe("researcher");

    // leader 的花名册用 slotLine 展示每位成员：职能标签可见。
    expect(dispatches[0]!.prompt).toContain("职能: researcher");

    const searcherTurn = dispatches.find((item) => item.slot.id === "slot-b")!;
    expect(searcherTurn.kind).toBe("role");
    expect(searcherTurn.prompt).toContain("你是团队成员 Searcher");
    expect(searcherTurn.prompt).toContain("你侧重搜集信息与调研");
  });

  it("无 specialty 的成员不注入职能段；leader 传了 specialty 也被忽略", () => {
    const { engine, dispatches } = harness({
      slots: [
        { id: "slot-lead", name: "Alpha", role: "leader", threadId: "ses-1", specialty: "reviewer" },
        { id: "slot-a", name: "Plain", role: "teammate", threadId: "ses-2" },
      ],
    });
    engine.start();

    expect(engine.slotOf("slot-lead")?.specialty).toBeUndefined();
    expect(dispatches[0]!.prompt).toContain("你是团队 leader");
    expect(dispatches[0]!.prompt).not.toContain("你的职能");

    engine.applyOutput("slot-lead", fence([{ op: "task", subject: "通用活", owner: "Plain" }]));
    const plainTurn = dispatches.find((item) => item.slot.id === "slot-a")!;
    expect(plainTurn.prompt).toContain("你是团队成员 Plain");
    expect(plainTurn.prompt).not.toContain("你的职能");
    expect(plainTurn.prompt).not.toContain("职能:");
  });
});
