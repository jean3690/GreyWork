// 自动化任务存储契约：CRUD / 持久化往返 / 启用态 / Run Now 执行路由。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useAutomationStore } from "@/stores/automation";
import { useAgentStore } from "@/stores/agent";
import { useChatStore } from "@/stores/chat";

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

  it("绑定 ACP 后端：派发到该后端、不落本机模型管线，成功后回写 lastRun", async () => {
    const { agent, provider } = readyAgent();
    const store = useAutomationStore();
    const task = store.add({ name: "带后端", intent: "生成日报", acpProviderId: provider.id });
    const submit = vi.spyOn(useChatStore(), "submitText").mockImplementation(() => null);
    const dispatch = vi.spyOn(agent, "dispatchToAcp").mockResolvedValue(undefined);

    expect(store.runNow(task.id)).toBe("started");
    expect(task.running).toBe(true);
    await vi.waitFor(() => expect(task.lastRun).toBeGreaterThan(0));

    expect(dispatch).toHaveBeenCalledWith("生成日报");
    expect(submit).not.toHaveBeenCalled();
  });

  it("绑定的后端未启用：运行态复位、lastRun 不写、绝不回落本机模型", async () => {
    const agent = useAgentStore();
    const provider = agent.agentProviders[0];
    provider.enabled = false;
    const store = useAutomationStore();
    const task = store.add({ name: "停用后端", intent: "生成日报", acpProviderId: provider.id });
    const submit = vi.spyOn(useChatStore(), "submitText").mockImplementation(() => null);
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
    const submit = vi.spyOn(useChatStore(), "submitText").mockImplementation(() => null);
    const dispatch = vi.spyOn(useAgentStore(), "dispatchToAcp").mockResolvedValue(undefined);

    expect(store.runNow(task.id)).toBe("started");
    await vi.waitFor(() => expect(task.running).toBe(false));

    expect(submit).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(task.lastRun).toBe(0);
  });

  it("未绑定后端：走本机模型管线", async () => {
    const store = useAutomationStore();
    const task = store.add({ name: "本机", intent: "生成日报" });
    const submit = vi.spyOn(useChatStore(), "submitText").mockImplementation(() => null);
    const dispatch = vi.spyOn(useAgentStore(), "dispatchToAcp").mockResolvedValue(undefined);

    expect(store.runNow(task.id)).toBe("started");
    expect(submit).toHaveBeenCalledWith("生成日报");
    expect(dispatch).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(task.lastRun).toBeGreaterThan(0));
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
