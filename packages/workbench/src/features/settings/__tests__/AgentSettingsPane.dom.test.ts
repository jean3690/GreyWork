// 设置 · agent 面板的服务端只读门：db_agents_sync 被禁时新增/编辑/启停都不给点，
// 并就地说明原因（改动只落在浏览器本地、与服务端数据库悄悄分叉比不能用更糟）。
// 图标走 localStorage 覆盖层、不经这条命令，保持可改。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
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
    for (const checkbox of wrapper.findAll('input[type="checkbox"][aria-label^="启用"]')) {
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
    for (const checkbox of wrapper.findAll('input[type="checkbox"][aria-label^="启用"]')) {
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
    for (const checkbox of wrapper.findAll('input[type="checkbox"][aria-label^="启用"]')) {
      expect(checkbox.attributes("disabled")).toBeUndefined();
    }
  });
});
