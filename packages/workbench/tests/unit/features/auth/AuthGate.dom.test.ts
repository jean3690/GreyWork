/**
 * 登录门契约（features/auth/AuthGate）：
 *
 * - desktop / browser-preview 直接透传，不查会话也不订阅 401；
 * - server 态先探测 /api/session，探测期间两不渲染（不放行 Shell、也不闪登录框）；
 * - 挂载后任何命令拿到 401 都重新推上门；
 * - 登录成功（LoginView 的 authenticated）后放行。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";

const h = vi.hoisted(() => ({
  runtimeMode: vi.fn<() => "desktop" | "server" | "browser-preview">(() => "desktop"),
  hasSession: vi.fn<() => Promise<boolean>>(),
  login: vi.fn<(password: string) => Promise<void>>(),
  authRequired: null as null | (() => void),
  offAuthRequired: vi.fn(),
}));

vi.mock("@greywork/host-ipc", () => ({
  runtimeMode: h.runtimeMode,
  hasSession: h.hasSession,
  login: h.login,
  onAuthRequired: (handler: () => void) => {
    h.authRequired = handler;
    return h.offAuthRequired;
  },
}));

import { i18n } from "@/i18n";
import AuthGate from "@/features/auth/AuthGate.vue";
import LoginView from "@/features/auth/LoginView.vue";

const mounted: VueWrapper[] = [];

beforeEach(() => {
  h.runtimeMode.mockReset().mockReturnValue("desktop");
  h.hasSession.mockReset();
  h.login.mockReset();
  h.authRequired = null;
  h.offAuthRequired.mockReset();
  i18n.global.locale.value = "zh-CN";
});

afterEach(() => {
  while (mounted.length) {
    try {
      mounted.pop()?.unmount();
    } catch {
      // 用例内已显式卸载过：忽略重复卸载。
    }
  }
  document.body.innerHTML = "";
});

function render(): VueWrapper {
  const wrapper = mount(AuthGate, {
    global: { plugins: [i18n] },
    slots: { default: '<div data-testid="shell-stub" />' },
  });
  mounted.push(wrapper);
  return wrapper;
}

function shellVisible(wrapper: VueWrapper): boolean {
  return wrapper.find('[data-testid="shell-stub"]').exists();
}

function loginVisible(wrapper: VueWrapper): boolean {
  return wrapper.find('[data-testid="login-view"]').exists();
}

describe("AuthGate", () => {
  it("桌面态：直接放行，不查会话也不订阅 401", async () => {
    h.runtimeMode.mockReturnValue("desktop");
    const wrapper = render();
    await flushPromises();

    expect(shellVisible(wrapper)).toBe(true);
    expect(loginVisible(wrapper)).toBe(false);
    expect(h.hasSession).not.toHaveBeenCalled();
    expect(h.authRequired).toBeNull();
  });

  it("浏览器预览态：直接放行，不查会话", async () => {
    h.runtimeMode.mockReturnValue("browser-preview");
    const wrapper = render();
    await flushPromises();

    expect(shellVisible(wrapper)).toBe(true);
    expect(h.hasSession).not.toHaveBeenCalled();
  });

  it("服务端态探测期间两不渲染：不放行 Shell，也不闪登录框", () => {
    h.runtimeMode.mockReturnValue("server");
    h.hasSession.mockResolvedValue(true);

    const wrapper = render();

    expect(shellVisible(wrapper)).toBe(false);
    expect(loginVisible(wrapper)).toBe(false);
  });

  it("服务端态已登录：探测通过后放行 Shell", async () => {
    h.runtimeMode.mockReturnValue("server");
    h.hasSession.mockResolvedValue(true);

    const wrapper = render();
    await flushPromises();

    expect(shellVisible(wrapper)).toBe(true);
    expect(loginVisible(wrapper)).toBe(false);
  });

  it("服务端态未登录：弹登录门，不挂载 Shell", async () => {
    h.runtimeMode.mockReturnValue("server");
    h.hasSession.mockResolvedValue(false);

    const wrapper = render();
    await flushPromises();

    expect(loginVisible(wrapper)).toBe(true);
    expect(shellVisible(wrapper)).toBe(false);
  });

  it("挂载后收到 401：重新推上登录门", async () => {
    h.runtimeMode.mockReturnValue("server");
    h.hasSession.mockResolvedValue(true);

    const wrapper = render();
    await flushPromises();
    expect(shellVisible(wrapper)).toBe(true);

    h.authRequired?.();
    await flushPromises();

    expect(loginVisible(wrapper)).toBe(true);
    expect(shellVisible(wrapper)).toBe(false);
  });

  it("探测还没回来就收到 401：保持登录门，不被随后「会话有效」的结果盖回去", async () => {
    h.runtimeMode.mockReturnValue("server");
    let settleSession!: (valid: boolean) => void;
    h.hasSession.mockReturnValue(
      new Promise<boolean>((resolve) => {
        settleSession = resolve;
      }),
    );

    const wrapper = render();
    h.authRequired?.();
    await flushPromises();
    expect(loginVisible(wrapper)).toBe(true);

    // 这是更早的信号：401 比探测结果更新，不该把门打开。
    settleSession(true);
    await flushPromises();

    expect(loginVisible(wrapper)).toBe(true);
    expect(shellVisible(wrapper)).toBe(false);
  });

  it("登录成功：放行 Shell", async () => {
    h.runtimeMode.mockReturnValue("server");
    h.hasSession.mockResolvedValue(false);

    const wrapper = render();
    await flushPromises();
    expect(loginVisible(wrapper)).toBe(true);

    wrapper.findComponent(LoginView).vm.$emit("authenticated");
    await flushPromises();

    expect(shellVisible(wrapper)).toBe(true);
    expect(loginVisible(wrapper)).toBe(false);
  });

  it("卸载时退订 401", async () => {
    h.runtimeMode.mockReturnValue("server");
    h.hasSession.mockResolvedValue(true);

    const wrapper = render();
    await flushPromises();

    wrapper.unmount();
    mounted.splice(mounted.indexOf(wrapper), 1);

    expect(h.offAuthRequired).toHaveBeenCalledTimes(1);
  });
});
