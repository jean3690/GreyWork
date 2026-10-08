// 设置 · agent 面板的服务端只读门：db_agents_sync 被禁时新增/编辑/启停都不给点，
// 并就地说明原因（改动只落在浏览器本地、与服务端数据库悄悄分叉比不能用更糟）。
// 图标走 localStorage 覆盖层、不经这条命令，保持可改。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";

const h = vi.hoisted(() => ({
  runtimeMode: vi.fn<() => string>(() => "desktop"),
  invoke: vi.fn<(cmd: string) => Promise<unknown>>(async () => null),
  loadCommandCatalog: vi.fn<() => Promise<unknown>>(async () => [
    { name: "db_agents_sync", auth: "required", desktopOnly: false, binary: false, available: false },
  ]),
}));

vi.mock("@greywork/host-ipc", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runtimeMode: h.runtimeMode,
  invoke: h.invoke,
  loadCommandCatalog: h.loadCommandCatalog,
}));

import AgentSettingsPane from "@/features/settings/AgentSettingsPane.vue";
import { i18n } from "@/i18n";
import { useSettingsStore } from "@/stores/settings";

const mounted: VueWrapper[] = [];

async function mountPane(awaitCatalog = true): Promise<VueWrapper> {
  const wrapper = mount(AgentSettingsPane, { global: { plugins: [i18n] }, attachTo: document.body });
  mounted.push(wrapper);
  if (awaitCatalog) await vi.waitFor(() => expect(h.loadCommandCatalog).toHaveBeenCalled());
  return wrapper;
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  h.runtimeMode.mockReturnValue("desktop");
  h.invoke.mockClear();
  h.loadCommandCatalog.mockClear();
});

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = "";
});

describe("AgentSettingsPane · agent 目录只读门", () => {
  it("服务端 db_agents_sync 被禁：新增/编辑入口收起，启停禁用，说明可见", async () => {
    h.runtimeMode.mockReturnValue("server");
    const wrapper = await mountPane();

    expect(wrapper.get('[data-testid="agent-catalog-readonly"]').text()).toContain("agent 目录只读");
    expect(wrapper.find('[data-testid="agent-catalog-add"]').exists()).toBe(false);
    for (const checkbox of wrapper.findAll('[data-testid^="agent-enable-"]')) {
      expect(checkbox.attributes("disabled")).toBeDefined();
    }
  });

  it("图标覆盖层不走 db_agents_sync：只读态仍可点开图标选择", async () => {
    h.runtimeMode.mockReturnValue("server");
    const wrapper = await mountPane();

    await wrapper.get('[data-testid="agent-icon-opencode"]').trigger("click");
    expect(wrapper.find('[data-testid="agent-icon-picker"]').exists()).toBe(true);
  });

  it("非服务端态：不受影响，编辑面照常可用", async () => {
    h.runtimeMode.mockReturnValue("desktop");
    const wrapper = await mountPane(false);

    expect(wrapper.find('[data-testid="agent-catalog-readonly"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="agent-catalog-add"]').exists()).toBe(true);
    for (const checkbox of wrapper.findAll('[data-testid^="agent-enable-"]')) {
      expect(checkbox.attributes("disabled")).toBeUndefined();
    }
  });

  it("启停切到服务端可用（available=true）：编辑面照常可用，未来放开零改动", async () => {
    h.runtimeMode.mockReturnValue("server");
    h.loadCommandCatalog.mockResolvedValue([
      { name: "db_agents_sync", auth: "required", desktopOnly: false, binary: false, available: true },
    ]);
    const wrapper = await mountPane();

    expect(wrapper.find('[data-testid="agent-catalog-readonly"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="agent-catalog-add"]').exists()).toBe(true);
    for (const checkbox of wrapper.findAll('[data-testid^="agent-enable-"]')) {
      expect(checkbox.attributes("disabled")).toBeUndefined();
    }
  });
});

describe("AgentSettingsPane · 模型供应商的 agent 模式开关", () => {
  it("默认关闭；勾选即时落盘并展开轮数上限，关掉后收起", async () => {
    const wrapper = await mountPane(false);
    const settings = useSettingsStore();
    const first = settings.modelProviders[0];
    settings.selectModelProvider(first.id);
    await nextTick();

    const toggle = () => wrapper.get('[data-testid="provider-agent-mode"]');
    expect((toggle().element as HTMLInputElement).checked).toBe(false);
    expect(wrapper.find('[data-testid="provider-agent-max-rounds"]').exists()).toBe(false);

    await toggle().setValue(true);
    expect(settings.modelProviders.find((p) => p.id === first.id)?.agentMode).toBe(true);
    expect(wrapper.find('[data-testid="provider-agent-max-rounds"]').exists()).toBe(true);

    await wrapper.get('[data-testid="provider-agent-max-rounds"]').setValue("6");
    expect(settings.modelProviders.find((p) => p.id === first.id)?.agentMaxRounds).toBe(6);

    await toggle().setValue(false);
    expect(settings.modelProviders.find((p) => p.id === first.id)?.agentMode).toBe(false);
    expect(wrapper.find('[data-testid="provider-agent-max-rounds"]').exists()).toBe(false);
  });

  // 越界的轮数不该静默落盘：那会让用户以为设了 999 轮，实际被宿主硬夹到 32。
  it("轮数越界 / 非整数一律忽略（宿主另有硬上限，输入层先挡一道）", async () => {
    const wrapper = await mountPane(false);
    const settings = useSettingsStore();
    const first = settings.modelProviders[0];
    settings.selectModelProvider(first.id);
    await nextTick();
    await wrapper.get('[data-testid="provider-agent-mode"]').setValue(true);

    for (const bad of ["0", "999", "3.5", "abc"]) {
      await wrapper.get('[data-testid="provider-agent-max-rounds"]').setValue(bad);
      expect(settings.modelProviders.find((p) => p.id === first.id)?.agentMaxRounds).toBeUndefined();
    }
    // 空串 = 回到「用宿主默认」
    await wrapper.get('[data-testid="provider-agent-max-rounds"]').setValue("8");
    await wrapper.get('[data-testid="provider-agent-max-rounds"]').setValue("");
    expect(settings.modelProviders.find((p) => p.id === first.id)?.agentMaxRounds).toBeUndefined();
  });
});
