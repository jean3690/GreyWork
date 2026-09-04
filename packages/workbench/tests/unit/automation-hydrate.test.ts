/**
 * automation store 桌面态（SQLite 真源 + 宿主到期队列）测试。
 *
 * - 库接管/未接管/失败降级/persist 双写（与 session/settings 同语义）；
 * - consumeDue：到期队列逐条下发 chat 管线 + finish 回执；busy 留队不丢；
 *   hydrate 后自动补跑积压；missing 任务防御性收尾。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { useAutomationStore } from "../../src/stores/automation";
import { useChatStore } from "../../src/stores/chat";

const storageHolder = globalThis as { localStorage?: Storage };

function installLocalStorage(): void {
  const store = new Map<string, string>();
  storageHolder.localStorage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => void store.delete(key),
    setItem: (key, value) => void store.set(key, String(value)),
  };
}

const dbTasks = [
  {
    id: "at-db-1",
    name: "库中任务",
    schedule: "每天 09:00",
    cron: "0 9 * * *",
    target: "主仓",
    intent: "生成日报",
    enabled: true,
    lastRun: 1_700_000_000_000,
  },
  {
    id: "at-db-2",
    name: "手动任务",
    schedule: "手动触发",
    cron: null,
    target: "未绑定",
    intent: "生成周报",
    enabled: false,
    lastRun: 0,
  },
];

describe("automation store 桌面接管（SQLite 真源）", () => {
  beforeEach(() => {
    installLocalStorage();
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    invokeMock.mockReset();
    setActivePinia(createPinia());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete storageHolder.localStorage;
  });

  it("库已接管：hydrate 后库清单覆盖种子，running 统一置 false", async () => {
    invokeMock.mockResolvedValue(dbTasks);
    const automation = useAutomationStore();
    await automation.hydrated;

    expect(automation.list).toHaveLength(2);
    expect(automation.list[0]).toMatchObject({
      id: "at-db-1",
      cron: "0 9 * * *",
      lastRun: 1_700_000_000_000,
      running: false,
    });
    expect(automation.list[1].cron).toBeNull();
  });

  it("库未接管：load=null → 种子清单首落库（含 cron 字段）", async () => {
    invokeMock.mockResolvedValue(null);
    const automation = useAutomationStore();
    await automation.hydrated;

    expect(automation.list.length).toBeGreaterThanOrEqual(3);
    expect(invokeMock).toHaveBeenCalledWith(
      "db_automations_sync",
      expect.objectContaining({
        tasks: expect.arrayContaining([expect.objectContaining({ cron: "0 9 * * *" }), expect.objectContaining({ cron: "0 3 * * *" })]),
      }),
    );
  });

  it("load 失败：降级沿用本地种子，不抛错", async () => {
    invokeMock.mockRejectedValue(new Error("库损坏"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const automation = useAutomationStore();
    await automation.hydrated;

    expect(automation.list.length).toBeGreaterThanOrEqual(3);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("变更经 persist 双写回库（toRow 形状含 cron/lastRun）", async () => {
    invokeMock.mockResolvedValue(dbTasks);
    const automation = useAutomationStore();
    await automation.hydrated;

    automation.setEnabled("at-db-1", false);
    expect(invokeMock).toHaveBeenLastCalledWith(
      "db_automations_sync",
      expect.objectContaining({
        tasks: expect.arrayContaining([expect.objectContaining({ id: "at-db-1", enabled: false, cron: "0 9 * * *" })]),
      }),
    );
  });
});

describe("automation 到期队列消费（consumeDue）", () => {
  /** 模拟库侧 due 队列：finish 从队列移除（与真实 pending 语义一致）。 */
  let queue: Array<{ id: number; taskId: string; name: string; target: string; intent: string; dueAt: number }>;

  function dispatchInvoke(): void {
    invokeMock.mockImplementation((cmd: unknown, args?: unknown) => {
      switch (cmd) {
        case "db_automations_load":
          return Promise.resolve(dbTasks);
        case "db_automations_due_list":
          return Promise.resolve([...queue]);
        case "db_automations_due_finish":
          queue = queue.filter((row) => row.id !== (args as { id: number }).id);
          return Promise.resolve(true);
        default:
          return Promise.resolve(undefined);
      }
    });
  }

  beforeEach(() => {
    installLocalStorage();
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    invokeMock.mockReset();
    setActivePinia(createPinia());
    queue = [
      { id: 1, taskId: "at-db-1", name: "库中任务", target: "主仓", intent: "生成日报", dueAt: Date.now() - 1_000 },
      { id: 2, taskId: "at-db-2", name: "手动任务", target: "未绑定", intent: "生成周报", dueAt: Date.now() - 500 },
    ];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete storageHolder.localStorage;
  });

  it("hydrate 后自动补跑积压：逐条下发 chat 管线并 finish 回执", async () => {
    dispatchInvoke();
    const automation = useAutomationStore();
    const chat = useChatStore();
    const submit = vi.spyOn(chat, "submitText").mockImplementation(() => null);

    await automation.hydrated;
    await vi.waitFor(() => expect(queue).toHaveLength(0));

    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenNthCalledWith(1, "生成日报");
    expect(submit).toHaveBeenNthCalledWith(2, "生成周报");
    const finishes = invokeMock.mock.calls.filter(([cmd]) => cmd === "db_automations_due_finish");
    expect(finishes).toHaveLength(2);
    expect(finishes[0][1]).toMatchObject({ id: 1, status: "success" });
    expect(finishes[1][1]).toMatchObject({ id: 2, status: "success" });
    // 成功执行回写 lastRun + enabled
    const task = automation.list.find((a) => a.id === "at-db-1");
    expect(task?.enabled).toBe(true);
    expect(task?.lastRun).toBeGreaterThan(1_700_000_000_000);
  });

  it("chat 管线忙 → 任务留在队列（不 finish、不记 lastRun），忙完可再消费", async () => {
    dispatchInvoke();
    const automation = useAutomationStore();
    const chat = useChatStore();
    const submit = vi.spyOn(chat, "submitText").mockImplementation(() => null);
    chat.busy = true;

    await automation.hydrated;
    // 自动补跑被 busy 挡下：队列原样保留
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(submit).not.toHaveBeenCalled();
    expect(queue).toHaveLength(2);
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "db_automations_due_finish")).toHaveLength(0);
    expect(automation.list.find((a) => a.id === "at-db-1")?.lastRun).toBe(1_700_000_000_000);

    // 忙完（busy=false）→ 再消费成功
    chat.busy = false;
    await automation.consumeDue();
    await vi.waitFor(() => expect(queue).toHaveLength(0));
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("到期任务已不在清单 → 防御性 finish(failed) 不留死队列", async () => {
    queue = [{ id: 9, taskId: "at-gone", name: "已删任务", target: "主仓", intent: "残留指令", dueAt: Date.now() - 1_000 }];
    dispatchInvoke();
    const automation = useAutomationStore();
    const chat = useChatStore();
    const submit = vi.spyOn(chat, "submitText").mockImplementation(() => null);

    await automation.hydrated;
    await vi.waitFor(() => expect(queue).toHaveLength(0));
    expect(submit).not.toHaveBeenCalled();
    const finish = invokeMock.mock.calls.find(([cmd]) => cmd === "db_automations_due_finish");
    expect(finish?.[1]).toMatchObject({ id: 9, status: "failed" });
  });
});
