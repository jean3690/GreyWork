import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useActivityStore } from "@/stores/activity";

/**
 * 活动面板宿主状态：默认收起、动作即落盘（greywork.activity.band）、
 * 存档还原 / 坏数据回退、setAvailable 不动 open 偏好。
 */
const storageHolder = globalThis as { localStorage?: Storage };
const PREF_KEY = "greywork.activity.band";

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

function readPrefs(): { open: boolean; active: string | null } {
  const raw = storageHolder.localStorage?.getItem(PREF_KEY);
  return raw ? JSON.parse(raw) : { open: false, active: null };
}

beforeEach(() => {
  injectStorage();
  setActivePinia(createPinia());
});

afterEach(() => {
  delete storageHolder.localStorage;
});

describe("useActivityStore", () => {
  it("默认值：收起、未选页签、可用", () => {
    const store = useActivityStore();
    expect(store.open).toBe(false);
    expect(store.activeTabId).toBeNull();
    expect(store.available).toBe(true);
  });

  it("setOpen / toggle / activate 写入存档", () => {
    const store = useActivityStore();
    store.setOpen(true);
    expect(readPrefs()).toEqual({ open: true, active: null });
    store.activate("activity.artifacts");
    expect(readPrefs()).toEqual({ open: true, active: "activity.artifacts" });
    store.toggle();
    expect(store.open).toBe(false);
    expect(readPrefs()).toEqual({ open: false, active: "activity.artifacts" });
  });

  it("新 pinia 从存档还原 open 与 active", () => {
    const first = useActivityStore();
    first.setOpen(true);
    first.activate("activity.artifacts");

    setActivePinia(createPinia());
    const restored = useActivityStore();
    expect(restored.open).toBe(true);
    expect(restored.activeTabId).toBe("activity.artifacts");
  });

  it("坏存档回退默认值", () => {
    storageHolder.localStorage?.setItem(PREF_KEY, "{not-json");
    expect(useActivityStore().open).toBe(false);

    storageHolder.localStorage?.setItem(PREF_KEY, JSON.stringify({ open: "yes", active: 3 }));
    expect(useActivityStore().activeTabId).toBeNull();
  });

  it("setAvailable 只改可用性，不动 open 偏好", () => {
    const store = useActivityStore();
    store.setOpen(true);
    store.setAvailable(false);
    expect(store.available).toBe(false);
    expect(store.open).toBe(true);
  });
});
