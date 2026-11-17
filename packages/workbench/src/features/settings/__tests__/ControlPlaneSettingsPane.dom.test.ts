// 控制面设置面板：宿主可用时的真实链路（命令参数与状态渲染）。
// 浏览器态的分支在 SettingsView.dom.test.ts 里用真实 hasHostCommands() 覆盖。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@greywork/host-ipc", async (importOriginal) => ({
  ...(await importOriginal()),
  hasHostCommands: () => true,
  invoke,
}));

import ControlPlaneSettingsPane from "@/features/settings/ControlPlaneSettingsPane.vue";

const idle = {
  configured: false,
  source: null,
  baseUrl: null,
  email: null,
  registered: false,
  tickSecs: 30,
  lastHeartbeatAt: null,
  lastClaimAt: null,
  lastError: null,
  lastOutcome: null,
};

const linked = {
  ...idle,
  configured: true,
  source: "file",
  baseUrl: "http://127.0.0.1:8080",
  email: "u@grey.local",
  registered: true,
  lastHeartbeatAt: Date.UTC(2026, 10, 16, 2, 0, 0),
};

function mountPane() {
  const pinia = createPinia();
  setActivePinia(pinia);
  return mount(ControlPlaneSettingsPane, { global: { plugins: [pinia] } });
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(idle);
});

describe("ControlPlaneSettingsPane", () => {
  it("入场码接入：命令参数与注册结果如实回显", async () => {
    invoke.mockImplementation(async (command: string) => (command === "control_plane_connect" ? linked : idle));
    const wrapper = mountPane();
    await flushPromises();
    expect(wrapper.text()).toContain("未接入控制面");

    await wrapper.get('[data-testid="controlplane-base-url"]').setValue("http://127.0.0.1:8080");
    await wrapper.get('[data-testid="controlplane-email"]').setValue("u@grey.local");
    await wrapper.get('[data-testid="controlplane-code"]').setValue("ABC123");
    await wrapper.get('[data-testid="controlplane-connect"]').trigger("click");
    await flushPromises();

    expect(invoke).toHaveBeenCalledWith("control_plane_connect", {
      baseUrl: "http://127.0.0.1:8080",
      email: "u@grey.local",
      code: "ABC123",
    });
    expect(wrapper.text()).toContain("已接入控制面");
    expect(wrapper.text()).toContain("u@grey.local");
  });

  it("token 方式接入：请求体只带 token，不带空邮箱/入场码", async () => {
    invoke.mockImplementation(async (command: string) => (command === "control_plane_connect" ? linked : idle));
    const wrapper = mountPane();
    await flushPromises();
    await wrapper.get('[data-testid="controlplane-mode"]').setValue("token");
    await wrapper.get('[data-testid="controlplane-token"]').setValue("tok-9");
    await wrapper.get('[data-testid="controlplane-connect"]').trigger("click");
    await flushPromises();

    expect(invoke).toHaveBeenCalledWith("control_plane_connect", {
      baseUrl: "http://localhost:8080",
      token: "tok-9",
    });
  });

  it("宿主报错就地展示，不留「以为已接入」", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "control_plane_status") return idle;
      throw new Error("入场码无效或已过期（可能已被使用，或未在运维台签发）");
    });
    const wrapper = mountPane();
    await flushPromises();
    await wrapper.get('[data-testid="controlplane-email"]').setValue("u@grey.local");
    await wrapper.get('[data-testid="controlplane-code"]').setValue("bad");
    await wrapper.get('[data-testid="controlplane-connect"]').trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("入场码无效或已过期");
    expect(wrapper.text()).toContain("未接入控制面");
  });

  it("立即同步把每条任务结果推成通知", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "control_plane_status") return linked;
      if (command === "control_plane_run_once") {
        return { status: linked, outcomes: [{ name: "每日简报", ok: true, detail: "已生成" }] };
      }
      return linked;
    });
    const wrapper = mountPane();
    await flushPromises();
    await wrapper.get('[data-testid="controlplane-run-once"]').trigger("click");
    await flushPromises();
    expect(invoke).toHaveBeenCalledWith("control_plane_run_once", { limit: 5 });
  });
});
