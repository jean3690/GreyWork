// 设置 · 系统面板的托盘区块契约：托盘可用性决定给不给「关闭到托盘 / 关闭即退出」这两个档位。
//
// 这条 UI 收敛不是纯装饰 —— 宿主在没有托盘时会把关闭行为钳回「关闭即退出」（否则窗口
// 藏起来后没有任何入口能恢复，见 src-tauri/src/tray.rs 的 should_hide_on_close）。
// 若这里还渲染出可选档位，就是一个点了没有任何效果的开关。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked((await import("@tauri-apps/api/core")).invoke);

import { i18n } from "@/i18n";
import SystemSettingsPane from "@/features/settings/SystemSettingsPane.vue";
import { useSettingsStore } from "@/stores/settings";

const mounted: VueWrapper[] = [];

/** 宿主 sys_info 快照；trayAvailable 由各用例覆盖。 */
function sysInfo(trayAvailable: boolean) {
  return {
    version: "0.2.0",
    schemaVersion: 7,
    logDir: "/home/test/.local/share/greywork/logs",
    activeAgents: 0,
    os: "linux",
    trayAvailable,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  setActivePinia(createPinia());
  invokeMock.mockReset();
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  i18n.global.locale.value = "zh-CN";
});

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = "";
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

async function render(trayAvailable: boolean | "browser"): Promise<VueWrapper> {
  if (trayAvailable === "browser") delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  invokeMock.mockImplementation(async (command: string) => (command === "sys_info" ? sysInfo(trayAvailable === true) : null));
  const wrapper = mount(SystemSettingsPane, { global: { plugins: [i18n] }, attachTo: document.body });
  mounted.push(wrapper);
  await flushPromises();
  return wrapper;
}

describe("SystemSettingsPane · 托盘区块", () => {
  it("托盘可用：两个档位都在，文案走 i18n 而不是裸 key", async () => {
    const wrapper = await render(true);
    expect(wrapper.find('[data-testid="tray-close-to-tray"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="tray-quit-on-close"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="tray-unavailable"]').exists()).toBe(false);
    expect(wrapper.text()).toContain("关闭到托盘");
    expect(wrapper.text()).not.toContain("settings.tray.");
  });

  it("点「关闭即退出」落到设置（宿主据此不再拦 CloseRequested）", async () => {
    const wrapper = await render(true);
    const settings = useSettingsStore();
    expect(settings.closeToTray).toBe(true);

    await wrapper.get('[data-testid="tray-quit-on-close"]').trigger("click");
    expect(settings.closeToTray).toBe(false);
  });

  it("宿主回报没有托盘：不给档位，只给说明", async () => {
    const wrapper = await render(false);
    expect(wrapper.find('[data-testid="tray-close-to-tray"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="tray-quit-on-close"]').exists()).toBe(false);
    const notice = wrapper.get('[data-testid="tray-unavailable"]');
    expect(notice.text()).toContain("没有可用的托盘");
  });

  it("浏览器预览态（没有宿主）：同样不给档位", async () => {
    const wrapper = await render("browser");
    expect(wrapper.find('[data-testid="tray-close-to-tray"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="tray-unavailable"]').exists()).toBe(true);
  });
});
