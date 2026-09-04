// 自动化任务存储契约：CRUD / 持久化往返 / 启用态。
import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useAutomationStore } from "@/stores/automation";

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
