/**
 * 登录表单契约：提交调 host-ipc login、成功后 emit authenticated 并清空密码、
 * 失败显示**服务端**文案（密码错误 / 限流都是服务端更清楚），提交期间不重复发请求。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";

const h = vi.hoisted(() => ({ login: vi.fn<(password: string) => Promise<void>>() }));

vi.mock("@greywork/host-ipc", () => ({ login: h.login }));

import { i18n } from "@/i18n";
import LoginView from "@/features/auth/LoginView.vue";

const mounted: VueWrapper[] = [];

beforeEach(() => {
  h.login.mockReset();
  i18n.global.locale.value = "zh-CN";
});

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = "";
});

function render(): VueWrapper {
  const wrapper = mount(LoginView, { global: { plugins: [i18n] } });
  mounted.push(wrapper);
  return wrapper;
}

function passwordValue(wrapper: VueWrapper): string {
  return (wrapper.get('[data-testid="login-password"]').element as HTMLInputElement).value;
}

describe("LoginView", () => {
  it("提交密码：调 login，成功后 emit authenticated 并清空输入框", async () => {
    h.login.mockResolvedValue(undefined);
    const wrapper = render();

    await wrapper.get('[data-testid="login-password"]').setValue("s3cret");
    await wrapper.get("form").trigger("submit");
    await flushPromises();

    expect(h.login).toHaveBeenCalledWith("s3cret");
    expect(wrapper.emitted("authenticated")).toHaveLength(1);
    // 密码没有理由在内存里多留一秒。
    expect(passwordValue(wrapper)).toBe("");
  });

  it("登录失败：显示服务端文案，不 emit authenticated", async () => {
    h.login.mockRejectedValue(new Error("密码错误"));
    const wrapper = render();

    await wrapper.get('[data-testid="login-password"]').setValue("wrong");
    await wrapper.get("form").trigger("submit");
    await flushPromises();

    expect(wrapper.get('[data-testid="login-error"]').text()).toBe("密码错误");
    expect(wrapper.emitted("authenticated")).toBeUndefined();
  });

  it("提交进行中：按钮禁用，重复提交不重复发请求", async () => {
    let settle!: () => void;
    h.login.mockReturnValue(
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
    );
    const wrapper = render();

    await wrapper.get('[data-testid="login-password"]').setValue("pw");
    await wrapper.get("form").trigger("submit");
    await wrapper.get("form").trigger("submit");
    await flushPromises();

    expect(h.login).toHaveBeenCalledTimes(1);
    expect(wrapper.get('[data-testid="login-submit"]').attributes("disabled")).toBeDefined();

    settle();
    await flushPromises();
  });

  it("失败后再次提交会先清掉上一次的错误提示", async () => {
    h.login.mockRejectedValueOnce(new Error("密码错误"));
    const wrapper = render();

    await wrapper.get('[data-testid="login-password"]').setValue("wrong");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(wrapper.find('[data-testid="login-error"]').exists()).toBe(true);

    h.login.mockResolvedValueOnce(undefined);
    await wrapper.get("form").trigger("submit");
    await flushPromises();

    expect(wrapper.find('[data-testid="login-error"]').exists()).toBe(false);
    expect(wrapper.emitted("authenticated")).toHaveLength(1);
  });
});
