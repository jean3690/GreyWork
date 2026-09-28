// 侧栏底部账户行：身份展示 + 服务端态登出。
//
// 登出按钮只在服务端态出现（桌面壳是本地壳、浏览器预览没有宿主，都没有会话可退）；
// 点击走二次确认，确认后调 host-ipc 的 logout() —— 后者内部会发「会话失效」信号，
// AuthGate 据此重挂登录门，所以本组件不做任何跳转。
//
// 弹层被 Portal 到 body，弹层相关断言一律查 document.body。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";

const host = vi.hoisted(() => ({
  runtimeMode: vi.fn<() => string>(() => "server"),
  logout: vi.fn(() => Promise.resolve()),
}));

vi.mock("@greywork/host-ipc", () => ({
  runtimeMode: host.runtimeMode,
  logout: host.logout,
}));

import SiderFooter from "@/features/shell/SiderFooter.vue";
import { i18n } from "@/i18n";

const mounted: VueWrapper[] = [];

async function mountFooter(): Promise<VueWrapper> {
  const wrapper = mount(SiderFooter, {
    global: { plugins: [i18n] },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  await flushPromises();
  return wrapper;
}

/** 确认弹层里的按钮，按渲染顺序：[取消, 确认]。 */
function confirmButtons(): HTMLButtonElement[] {
  const content = document.body.querySelector<HTMLElement>('[data-slot="alert-dialog-content"]');
  if (!content) throw new Error("未渲染出确认弹层");
  return [...content.querySelectorAll<HTMLButtonElement>("button")];
}

beforeEach(() => {
  host.runtimeMode.mockReturnValue("server");
  host.logout.mockClear();
});

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = "";
});

describe("SiderFooter · 账户行", () => {
  it("显示身份标签，点击上报导航意图", async () => {
    const wrapper = await mountFooter();
    const row = wrapper.get('[data-testid="sider-account"]');

    expect(row.text()).toContain("本机用户");
    await row.trigger("click");
    expect(wrapper.emitted("navigate")).toEqual([["/assistants"]]);
  });

  it("设置入口仍然只上报打开设置", async () => {
    const wrapper = await mountFooter();

    await wrapper.get('[data-testid="sider-settings"]').trigger("click");
    expect(wrapper.emitted("openSettings")).toHaveLength(1);
  });
});

describe("SiderFooter · 登出", () => {
  it("服务端态给出登出按钮", async () => {
    const wrapper = await mountFooter();
    const button = wrapper.get('[data-testid="sider-signout"]');

    expect(button.attributes("aria-label")).toBe("登出");
  });

  it("桌面端与浏览器预览态不给登出按钮", async () => {
    for (const mode of ["desktop", "browser-preview"]) {
      host.runtimeMode.mockReturnValue(mode);
      const wrapper = await mountFooter();

      expect(wrapper.find('[data-testid="sider-signout"]').exists()).toBe(false);
      // 账户行本身仍在：身份展示与「有没有会话可退」是两回事。
      expect(wrapper.find('[data-testid="sider-account"]').exists()).toBe(true);
      wrapper.unmount();
    }
  });

  it("点登出先二次确认，确认后才调 logout()", async () => {
    const wrapper = await mountFooter();

    await wrapper.get('[data-testid="sider-signout"]').trigger("click");
    await flushPromises();

    expect(host.logout).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("确认登出？");

    confirmButtons()[1].click();
    await flushPromises();

    expect(host.logout).toHaveBeenCalledTimes(1);
  });

  it("取消不发 logout()，并关掉弹层", async () => {
    const wrapper = await mountFooter();

    await wrapper.get('[data-testid="sider-signout"]').trigger("click");
    await flushPromises();
    confirmButtons()[0].click();
    await flushPromises();

    expect(host.logout).not.toHaveBeenCalled();
    expect(document.body.querySelector('[data-slot="alert-dialog-content"]')).toBeNull();
  });
});
