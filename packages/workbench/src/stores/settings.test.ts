// 设置持久化验收：persist/loadPersisted 往返一致、推理等级非法值回退、损坏数据回退默认。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const storage = new Map<string, string>();
const localStorageStub = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => storage.clear(),
};
vi.stubGlobal("localStorage", localStorageStub);
vi.stubGlobal("window", { localStorage: localStorageStub });

import { useSettingsStore } from "./settings";

beforeEach(() => {
  storage.clear();
  setActivePinia(createPinia());
});

describe("settings 持久化", () => {
  it("persist 后 loadPersisted 往返一致（含 reasoningEffort 与 cliIntegrations）", () => {
    const settings = useSettingsStore();
    const provider = settings.modelProviders[0];
    provider.reasoningEffort = "high";
    settings.cliIntegrations[0].reasoningEffort = "max";
    settings.locale = "en-US";
    settings.persist();

    setActivePinia(createPinia());
    const reloaded = useSettingsStore();
    expect(reloaded.modelProviders[0].reasoningEffort).toBe("high");
    expect(reloaded.cliIntegrations[0].reasoningEffort).toBe("max");
    expect(reloaded.locale).toBe("en-US");
  });

  it("loadPersisted 对非法 reasoningEffort 回退 auto", () => {
    storage.set(
      "greywork.settings",
      JSON.stringify({
        modelProviders: [{ id: "x", name: "X", model: "m", enabled: true, reasoningEffort: "ultra" }],
        cliIntegrations: [{ id: "cli", name: "CLI", reasoningEffort: "xhigh" }],
      }),
    );
    setActivePinia(createPinia());
    const settings = useSettingsStore();
    expect(settings.modelProviders[0].reasoningEffort).toBe("auto");
    expect(settings.cliIntegrations[0].reasoningEffort).toBe("auto");
  });

  it("损坏的本地设置回退默认", () => {
    storage.set("greywork.settings", "{broken");
    setActivePinia(createPinia());
    const settings = useSettingsStore();
    expect(settings.modelProviders.length).toBeGreaterThan(0);
  });
});
