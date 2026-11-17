import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia } from "pinia";
import type { ControlPlaneAccount, ControlPlaneStatus } from "@/lib/control-plane";

const host = vi.hoisted(() => ({ available: true, invoke: vi.fn(), logout: vi.fn() }));
vi.mock("@greywork/host-ipc", async (importOriginal) => ({
  ...(await importOriginal()),
  hasHostCommands: () => host.available,
  invoke: host.invoke,
  logout: host.logout,
}));
import UserAccountPane from "../UserAccountPane.vue";
import SiderFooter from "@/features/shell/SiderFooter.vue";
import { i18n, setLocale } from "@/i18n";

const idle: ControlPlaneStatus = {
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
const linked: ControlPlaneAccount = {
  status: { ...idle, configured: true, source: "file", baseUrl: "http://localhost:8080", email: "u@grey.local", registered: true },
  session: {
    user: { id: "9223372036854775806", email: "u@grey.local", displayName: "Jean", role: "admin" },
    device: { id: 7, name: "工作电脑", platform: "desktop" },
  },
  error: null,
};
const mounted: VueWrapper[] = [];

async function mountPane(withFooter = false): Promise<{ pane: VueWrapper; footer?: VueWrapper }> {
  const plugins = [createPinia(), i18n];
  const pane = mount(UserAccountPane, { global: { plugins }, attachTo: document.body });
  mounted.push(pane);
  const footer = withFooter ? mount(SiderFooter, { global: { plugins } }) : undefined;
  if (footer) mounted.push(footer);
  await flushPromises();
  return { pane, footer };
}

beforeEach(() => {
  setLocale("zh-CN");
  host.available = true;
  host.invoke.mockReset();
  host.logout.mockReset();
  host.invoke.mockResolvedValue({ status: idle, session: null, error: null });
  window.localStorage.clear();
});
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = "";
});

describe("用户账号", () => {
  it("入场码登录与 Java 参数一致，登录后侧栏同步显示身份", async () => {
    host.invoke.mockImplementation(async (command: string) => {
      if (command === "control_plane_connect") return linked.status;
      return host.invoke.mock.calls.some(([name]) => name === "control_plane_connect")
        ? linked
        : { status: idle, session: null, error: null };
    });
    const { pane, footer } = await mountPane(true);
    expect(pane.get('[data-testid="account-login"]').attributes("disabled")).toBeDefined();
    await pane.get("#account-email").setValue(" u@grey.local ");
    await pane.get("#account-code").setValue("ABC123");
    await pane.get("#account-name").setValue("Jean");
    await pane.get("#account-device").setValue("工作电脑");
    await pane.get('[data-testid="account-login-form"]').trigger("submit");
    await flushPromises();
    expect(host.invoke).toHaveBeenCalledWith("control_plane_connect", {
      baseUrl: "http://localhost:8080",
      email: "u@grey.local",
      code: "ABC123",
      displayName: "Jean",
      deviceName: "工作电脑",
    });
    expect(pane.text()).toContain("9223372036854775806");
    expect(pane.text()).toContain("工作电脑");
    expect(pane.text()).toContain("管理员");
    expect(footer?.get('[data-testid="sider-account"]').text()).toContain("Jean");
    expect(window.localStorage.length).toBe(0);
  });

  it("登录失败展示错误，入场码不继续留在输入框", async () => {
    host.invoke.mockImplementation(async (command: string) => {
      if (command === "control_plane_connect") throw new Error("入场码无效或已过期");
      return { status: idle, session: null, error: null };
    });
    const { pane } = await mountPane();
    await pane.get("#account-email").setValue("u@grey.local");
    await pane.get("#account-code").setValue("bad");
    await pane.get('[data-testid="account-login-form"]').trigger("submit");
    await flushPromises();
    expect(pane.get('[data-testid="account-error"]').text()).toContain("入场码无效");
    expect((pane.get("#account-code").element as HTMLInputElement).value).toBe("");
  });

  it("刷新发现登录态失效后回到登录表单，不继续展示旧身份", async () => {
    host.invoke.mockResolvedValue(linked);
    const { pane } = await mountPane();
    host.invoke.mockResolvedValue({ ...linked, session: null, error: "登录态已失效，请重新登录" });
    await pane.get('[data-testid="account-refresh"]').trigger("click");
    await flushPromises();
    expect(pane.find('[data-testid="account-profile"]').exists()).toBe(false);
    expect(pane.text()).toContain("登录态已失效");
    expect(pane.find("#account-code").exists()).toBe(true);
  });

  it("退出二次确认后撤销服务器账号，不调用工作台访问密码登出", async () => {
    host.invoke.mockImplementation(async (command: string) => (command === "control_plane_logout" ? idle : linked));
    const { pane } = await mountPane();
    await pane.get('[data-testid="account-logout"]').trigger("click");
    await flushPromises();
    expect(host.invoke).not.toHaveBeenCalledWith("control_plane_logout");
    const buttons = document.body.querySelectorAll<HTMLButtonElement>('[data-slot="alert-dialog-content"] button');
    expect(buttons).toHaveLength(2);
    buttons[1]!.click();
    await flushPromises();
    expect(host.invoke).toHaveBeenCalledWith("control_plane_logout");
    expect(host.logout).not.toHaveBeenCalled();
    expect(pane.find('[data-testid="account-profile"]').exists()).toBe(false);
  });

  it("环境变量管理的身份可以查看，但不能退出", async () => {
    host.invoke.mockResolvedValue({ ...linked, status: { ...linked.status, source: "env" } });
    const { pane } = await mountPane();
    expect(pane.text()).toContain("账号由环境变量管理");
    expect(pane.get('[data-testid="account-logout"]').attributes("disabled")).toBeDefined();
  });

  it("浏览器预览禁用登录，不请求宿主", async () => {
    host.available = false;
    const { pane } = await mountPane();
    expect(pane.text()).toContain("浏览器预览中无法登录");
    expect(pane.get("#account-email").attributes("disabled")).toBeDefined();
    expect(host.invoke).not.toHaveBeenCalled();
  });
});
