// 自动化任务存储契约：CRUD / 持久化往返 / 启用态 / Run Now 执行路由。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useAutomationStore } from "@/stores/automation";
import { useAgentStore } from "@/stores/agent";
import { useChatStore } from "@/stores/chat";
import { useSessionStore } from "@/stores/session";
import { useWorkspaceStore } from "@/stores/workspace";

const storageHolder = globalThis as { localStorage?: Storage };

function injectStorage(): void {
  const backing: Record<string, string> = {};
  storageHolder.localStorage = {
    getItem: (key: string) => backing[key] ?? null,
    setItem: (key: string, value: string) => {
      backing[key] = value;
    },
    removeItem: (key: string) => {
      delete backing[key];
    },
    clear: () => {
      for (const key of Object.keys(backing)) delete backing[key];
    },
    key: (index: number) => Object.keys(backing)[index] ?? null,
    get length() {
      return Object.keys(backing).length;
    },
  } as Storage;
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("自动化任务 CRUD", () => {
  it("无持久化数据时按默认任务种子初始化", () => {
    const store = useAutomationStore();
    expect(store.list.length).toBeGreaterThanOrEqual(3);
    expect(store.list.every((a) => typeof a.intent === "string" && typeof a.enabled === "boolean")).toBe(true);
  });

  it("add 创建并置顶，remove 删除", () => {
    const store = useAutomationStore();
    const created = store.add({ name: "自定义任务", intent: "生成一份周报" });
    expect(store.list[0]?.id).toBe(created.id);
    expect(created.enabled).toBe(false);
    store.remove(created.id);
    expect(store.list.find((a) => a.id === created.id)).toBeUndefined();
  });

  it("setEnabled / update 修改并维护引用", () => {
    const store = useAutomationStore();
    const id = store.list[0].id;
    store.setEnabled(id, false);
    expect(store.list[0]?.enabled).toBe(false);
    store.update(id, { name: "改名" });
    expect(store.list[0]?.name).toBe("改名");
  });
});

describe("Run Now 执行路由", () => {
  /** 已启用且已选中的 ACP 后端（避免走 activate 连接路径）。 */
  function readyAgent() {
    const agent = useAgentStore();
    const provider = agent.agentProviders[0];
    provider.enabled = true;
    agent.selectedProviderId = provider.id;
    agent.routeToAcp = true;
    return { agent, provider };
  }

  it("绑定 ACP 后端：派发到该后端、按专属线程入流，成功后回写 lastRun", async () => {
    const { agent, provider } = readyAgent();
    const store = useAutomationStore();
    const task = store.add({ name: "带后端", intent: "生成日报", acpProviderId: provider.id });
    const submit = vi.spyOn(useChatStore(), "submitTextIn").mockImplementation(() => null);
    const dispatch = vi.spyOn(agent, "dispatchToAcp").mockResolvedValue(undefined);

    expect(store.runNow(task.id)).toBe("started");
    expect(task.running).toBe(true);
    await vi.waitFor(() => expect(task.lastRun).toBeGreaterThan(0));

    expect(dispatch).toHaveBeenCalledWith("生成日报", [], [], `auto-${task.id}`);
    expect(submit).not.toHaveBeenCalled();
  });

  it("绑定的后端未启用：运行态复位、lastRun 不写、绝不回落本机模型", async () => {
    const agent = useAgentStore();
    const provider = agent.agentProviders[0];
    provider.enabled = false;
    const store = useAutomationStore();
    const task = store.add({ name: "停用后端", intent: "生成日报", acpProviderId: provider.id });
    const submit = vi.spyOn(useChatStore(), "submitTextIn").mockImplementation(() => null);
    const dispatch = vi.spyOn(agent, "dispatchToAcp").mockResolvedValue(undefined);

    expect(store.runNow(task.id)).toBe("started");
    await vi.waitFor(() => expect(task.running).toBe(false));

    expect(submit).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(task.lastRun).toBe(0);
  });

  it("绑定的后端已被删除：只报错，不改用本机模型", async () => {
    const store = useAutomationStore();
    const task = store.add({ name: "后端没了", intent: "生成日报", acpProviderId: "custom-gone" });
    const submit = vi.spyOn(useChatStore(), "submitTextIn").mockImplementation(() => null);
    const dispatch = vi.spyOn(useAgentStore(), "dispatchToAcp").mockResolvedValue(undefined);

    expect(store.runNow(task.id)).toBe("started");
    await vi.waitFor(() => expect(task.running).toBe(false));

    expect(submit).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(task.lastRun).toBe(0);
  });

  it("未绑定后端：走本机模型管线，落到专属会话", async () => {
    const store = useAutomationStore();
    const task = store.add({ name: "本机", intent: "生成日报" });
    const submit = vi.spyOn(useChatStore(), "submitTextIn").mockImplementation(() => null);
    const dispatch = vi.spyOn(useAgentStore(), "dispatchToAcp").mockResolvedValue(undefined);

    expect(store.runNow(task.id)).toBe("started");
    expect(submit).toHaveBeenCalledWith(`auto-${task.id}`, "生成日报");
    expect(dispatch).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(task.lastRun).toBeGreaterThan(0));
  });

  it("Run Now 建/用专属会话，不抢当前激活会话；运行记录带会话入口", async () => {
    const store = useAutomationStore();
    const sessions = useSessionStore();
    sessions.setActive("ses-user-keep");
    const task = store.add({ name: "隔离", intent: "生成日报" });
    const submit = vi.spyOn(useChatStore(), "submitTextIn").mockImplementation(() => null);

    expect(store.runNow(task.id)).toBe("started");
    // 专属会话已就位，且用户的激活会话没被顶掉
    expect(sessions.getSession(`auto-${task.id}`)?.title).toContain(task.name);
    expect(sessions.activeSessionId).toBe("ses-user-keep");
    expect(submit).toHaveBeenCalledWith(`auto-${task.id}`, "生成日报");
    await vi.waitFor(() => expect(task.lastRun).toBeGreaterThan(0));
    expect(store.runs[0]?.sessionId).toBe(`auto-${task.id}`);
  });
});

describe("工作区绑定（写在专属会话上）", () => {
  it("setTaskWorkspace 写专属会话的 workspaceId，并同步 target 展示名", () => {
    const store = useAutomationStore();
    const workspace = useWorkspaceStore().createWorkspace("项目A");
    const task = store.add({ name: "绑工作区", intent: "生成日报" });

    store.setTaskWorkspace(task.id, workspace.id);
    expect(useSessionStore().getSession(`auto-${task.id}`)?.workspaceId).toBe(workspace.id);
    expect(store.taskWorkspaceId(task.id)).toBe(workspace.id);
    expect(task.target).toBe("项目A");

    store.setTaskWorkspace(task.id, null);
    expect(store.taskWorkspaceId(task.id)).toBeNull();
    expect(task.target).toBe("未绑定工作区");
  });

  it("任务行不落 workspaceId 字段（绑定只落在会话上）", () => {
    const store = useAutomationStore();
    const workspace = useWorkspaceStore().createWorkspace("项目B");
    const task = store.add({ name: "不落行", intent: "生成日报" });
    store.setTaskWorkspace(task.id, workspace.id);
    expect(Object.prototype.hasOwnProperty.call(task, "workspaceId")).toBe(false);
  });

  it("先 Run Now 建了会话再绑工作区：绑定改写既有会话", () => {
    const store = useAutomationStore();
    const sessions = useSessionStore();
    const workspace = useWorkspaceStore().createWorkspace("项目C");
    const task = store.add({ name: "改绑", intent: "生成日报" });
    vi.spyOn(useChatStore(), "submitTextIn").mockImplementation(() => null);

    store.runNow(task.id);
    expect(sessions.getSession(`auto-${task.id}`)?.workspaceId).toBeNull();

    store.setTaskWorkspace(task.id, workspace.id);
    expect(sessions.getSession(`auto-${task.id}`)?.workspaceId).toBe(workspace.id);
  });
});

describe("失败重试", () => {
  it("可重试失败：退避后重试，成功补恢复通知并记 success", async () => {
    vi.useFakeTimers();
    try {
      const agent = useAgentStore();
      const provider = agent.agentProviders[0];
      provider.enabled = true;
      agent.routeToAcp = true;
      agent.selectedProviderId = "other-provider"; // 触发 activateAcpProvider 分支
      const activate = vi.spyOn(agent, "activateAcpProvider").mockResolvedValueOnce("连接失败").mockResolvedValue(null);
      const dispatch = vi.spyOn(agent, "dispatchToAcp").mockResolvedValue(undefined);
      const store = useAutomationStore();
      const task = store.add({ name: "重试", intent: "生成日报", acpProviderId: provider.id });

      expect(store.runNow(task.id)).toBe("started");
      await vi.advanceTimersByTimeAsync(0);
      // 首次失败，仍在退避窗口内：未派发
      expect(dispatch).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(3_000);
      expect(activate).toHaveBeenCalledTimes(2);
      expect(dispatch).toHaveBeenCalledWith("生成日报", [], [], `auto-${task.id}`);
      expect(task.lastRun).toBeGreaterThan(0);
      expect(store.runs[0]?.status).toBe("success");
    } finally {
      vi.useRealTimers();
    }
  });

  it("不可重试失败（后端被删）：立即失败，不触发 activate/重试", async () => {
    const agent = useAgentStore();
    const activate = vi.spyOn(agent, "activateAcpProvider");
    const store = useAutomationStore();
    const task = store.add({ name: "缺后端", intent: "生成日报", acpProviderId: "custom-gone" });
    vi.spyOn(useChatStore(), "submitTextIn").mockImplementation(() => null);

    store.runNow(task.id);
    await vi.waitFor(() => expect(task.running).toBe(false));
    expect(activate).not.toHaveBeenCalled();
    expect(task.lastRun).toBe(0);
  });
});

describe("复制 / 批量", () => {
  it("duplicate 复制为新任务：新 id、名字加副本、停用、未跑过，并沿用工作区绑定", () => {
    const store = useAutomationStore();
    const workspace = useWorkspaceStore().createWorkspace("项目D");
    const source = store.add({ name: "原始", intent: "生成日报", cron: "0 9 * * *", enabled: true });
    store.setTaskWorkspace(source.id, workspace.id);

    const copy = store.duplicate(source.id);
    expect(copy).toBeTruthy();
    expect(copy!.id).not.toBe(source.id);
    expect(copy!.name).toContain("副本");
    expect(copy!.enabled).toBe(false);
    expect(copy!.lastRun).toBe(0);
    expect(copy!.cron).toBe("0 9 * * *");
    expect(store.taskWorkspaceId(copy!.id)).toBe(workspace.id);
  });

  it("setManyEnabled 批量启停；removeMany 批量删除并清专属会话", () => {
    const store = useAutomationStore();
    const a = store.add({ name: "a", intent: "i" });
    const b = store.add({ name: "b", intent: "i" });
    store.setManyEnabled([a.id, b.id], true);
    expect(store.list.find((x) => x.id === a.id)?.enabled).toBe(true);
    expect(store.list.find((x) => x.id === b.id)?.enabled).toBe(true);

    useSessionStore().ensureUnactivated(`auto-${a.id}`, "x");
    store.removeMany([a.id, b.id]);
    expect(store.list.find((x) => x.id === a.id)).toBeUndefined();
    expect(store.list.find((x) => x.id === b.id)).toBeUndefined();
    expect(useSessionStore().getSession(`auto-${a.id}`)).toBeUndefined();
  });
});

describe("导入 / 导出", () => {
  it("exportJson → importJson 往返：导出内容原样导入为新一批任务、默认停用", () => {
    const store = useAutomationStore();
    const workspace = useWorkspaceStore().createWorkspace("项目E");
    const source = store.add({ name: "往返", intent: "生成周报", cron: "0 18 * * 5", enabled: true });
    store.setTaskWorkspace(source.id, workspace.id);
    const json = store.exportJson();
    const exportedCount = (JSON.parse(json) as { tasks: unknown[] }).tasks.length;
    const before = store.list.length;

    const result = store.importJson(json);
    expect("added" in result && result.added).toBe(exportedCount);
    expect(store.list.length).toBe(before + exportedCount);

    const imported = store.list.find((x) => x.name === "往返" && x.id !== source.id);
    expect(imported?.intent).toBe("生成周报");
    expect(imported?.enabled).toBe(false);
    expect(imported?.cron).toBe("0 18 * * 5");
    // 工作区绑定随导出 / 导入一起还原
    expect(store.taskWorkspaceId(imported!.id)).toBe(workspace.id);
  });

  it("importJson 拒绝非法 JSON / 空清单；跳过缺字段与非法 cron 的条目", () => {
    const store = useAutomationStore();
    expect(store.importJson("{ not json")).toHaveProperty("error");
    expect(store.importJson("[]")).toHaveProperty("error");

    const before = store.list.length;
    const result = store.importJson(JSON.stringify({ tasks: [{ name: "无指令" }, { name: "坏cron", intent: "i", cron: "99 99 * *" }] }));
    expect(store.list.length).toBe(before + 1); // 只导入「坏cron」那条（cron 非法 → 归一为 null）
    expect("added" in result && result.added).toBe(1);
  });
});

describe("持久化", () => {
  it("写操作落盘，重建 store 后状态还原", () => {
    injectStorage();
    try {
      const store = useAutomationStore();
      const created = store.add({ name: "持久化任务", intent: "生成周报", target: "城市洞察" });
      store.setEnabled(created.id, true);
      expect(created.lastRun).toBe(0);

      setActivePinia(createPinia());
      const reloaded = useAutomationStore();
      const restored = reloaded.list.find((a) => a.id === created.id);
      expect(restored?.name).toBe("持久化任务");
      expect(restored?.intent).toBe("生成周报");
      expect(restored?.target).toBe("城市洞察");
      expect(restored?.enabled).toBe(true);
    } finally {
      delete storageHolder.localStorage;
    }
  });
});
