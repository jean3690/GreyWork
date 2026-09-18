// 钉钉「扫码创建应用」面板契约：引导 → 出码等待 → 取消 / 失败重试。
//
// 宿主命令是替身：这里验证的是界面在三个阶段的行为——不点不调宿主、等待时给出二维码、
// 失败时如实说明并留重试入口。三条通道的宿主都替身化，store 才会认为「桌面端可用」。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import DingTalkRegisterPanel from "@/features/channels/DingTalkRegisterPanel.vue";
import { i18n } from "@/i18n";
import type { DingTalkRegisterPoll, DingTalkStatus } from "@/lib/dingtalk-backend";

const mocks = vi.hoisted(() => ({
  dingtalk: {
    supported: vi.fn(() => true),
    status: vi.fn(
      async (): Promise<DingTalkStatus> => ({
        configured: false,
        clientId: null,
        state: "stopped",
        detail: null,
        lastMessageAt: null,
        peerCount: 0,
      }),
    ),
    saveCredentials: vi.fn(),
    clearCredentials: vi.fn(),
    registerBegin: vi.fn(async () => ({
      qrUrl: "https://oapi.dingtalk.com/app/registration/verify?code=AB12-CD34",
      userCode: "AB12-CD34",
      expiresIn: 7200,
      interval: 3,
    })),
    registerPoll: vi.fn(
      async (): Promise<DingTalkRegisterPoll> => ({
        state: "pending",
        detail: null,
        clientId: null,
      }),
    ),
    registerCancel: vi.fn(async () => {}),
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    onState: vi.fn(async () => () => {}),
    onInbound: vi.fn(async () => () => {}),
  },
  wechat: { supported: vi.fn(() => true) },
  feishu: { supported: vi.fn(() => true) },
}));

vi.mock("@/lib/dingtalk-backend", () => ({ dingtalkBackend: mocks.dingtalk }));
vi.mock("@/lib/wechat-backend", () => ({ wechatBackend: mocks.wechat }));
vi.mock("@/lib/feishu-backend", () => ({ feishuBackend: mocks.feishu }));

beforeEach(() => {
  window.localStorage.clear();
  setActivePinia(createPinia());
  vi.clearAllMocks();
  // clearAllMocks 不清返回实现：上一轮把 supported 改成 false 会漏到下一个用例
  mocks.dingtalk.supported.mockReturnValue(true);
  mocks.wechat.supported.mockReturnValue(true);
});

describe("DingTalkRegisterPanel", () => {
  it("引导态不碰宿主；点「扫码创建应用」后才出二维码与配对码", async () => {
    const wrapper = mount(DingTalkRegisterPanel, { global: { plugins: [i18n] } });
    expect(wrapper.find('[data-testid="dingtalk-register-start"]').exists()).toBe(true);
    expect(mocks.dingtalk.registerBegin).not.toHaveBeenCalled();

    await wrapper.get('[data-testid="dingtalk-register-start"]').trigger("click");
    await vi.waitFor(() => expect(wrapper.find('[data-testid="dingtalk-register-qr"]').exists()).toBe(true));
    expect(wrapper.get('[data-testid="dingtalk-register-qr"]').find("svg").exists()).toBe(true);
    expect(wrapper.get('[data-testid="dingtalk-register-code"]').text()).toContain("AB12-CD34");
    // 出码后引导按钮让位给等待态
    expect(wrapper.find('[data-testid="dingtalk-register-start"]').exists()).toBe(false);
  });

  it("取消：回到引导态并作废宿主那边的会话", async () => {
    const wrapper = mount(DingTalkRegisterPanel, { global: { plugins: [i18n] } });
    await wrapper.get('[data-testid="dingtalk-register-start"]').trigger("click");
    await vi.waitFor(() => expect(wrapper.find('[data-testid="dingtalk-register-qr"]').exists()).toBe(true));

    await wrapper.get('[data-testid="dingtalk-register-cancel"]').trigger("click");
    expect(wrapper.find('[data-testid="dingtalk-register-qr"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="dingtalk-register-start"]').exists()).toBe(true);
    expect(mocks.dingtalk.registerCancel).toHaveBeenCalled();
  });

  it("浏览器态：如实说明不可用，而不是渲染点了没反应的按钮", () => {
    mocks.dingtalk.supported.mockReturnValue(false);
    mocks.wechat.supported.mockReturnValue(false);
    const wrapper = mount(DingTalkRegisterPanel, { global: { plugins: [i18n] } });
    expect(wrapper.get('[data-testid="dingtalk-register-unsupported"]').text()).toBe("通道仅桌面端可用。");
    expect(wrapper.find('[data-testid="dingtalk-register-start"]').exists()).toBe(false);
  });

  it("超时：给出原因与重试入口，且不再轮询", async () => {
    vi.useFakeTimers();
    try {
      mocks.dingtalk.registerPoll.mockResolvedValue({
        state: "expired",
        detail: null,
        clientId: null,
      });
      const wrapper = mount(DingTalkRegisterPanel, { global: { plugins: [i18n] } });
      await wrapper.get('[data-testid="dingtalk-register-start"]').trigger("click");
      // 发起是异步的：先让微任务落地，再推进一次轮询间隔
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(3000);

      const error = wrapper.get('[data-testid="dingtalk-register-error"]');
      expect(error.text()).toContain("超时");
      expect(wrapper.find('[data-testid="dingtalk-register-qr"]').exists()).toBe(false);
      expect(wrapper.find('[data-testid="dingtalk-register-retry"]').exists()).toBe(true);

      const calls = mocks.dingtalk.registerPoll.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(mocks.dingtalk.registerPoll.mock.calls.length).toBe(calls);

      // 重试：再走一遍发起流程
      mocks.dingtalk.registerPoll.mockResolvedValue({
        state: "pending",
        detail: null,
        clientId: null,
      });
      await wrapper.get('[data-testid="dingtalk-register-retry"]').trigger("click");
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.dingtalk.registerBegin).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("失败：优先透传服务端给的描述", async () => {
    vi.useFakeTimers();
    try {
      mocks.dingtalk.registerPoll.mockResolvedValue({
        state: "error",
        detail: "device_code 已过期",
        clientId: null,
      });
      const wrapper = mount(DingTalkRegisterPanel, { global: { plugins: [i18n] } });
      await wrapper.get('[data-testid="dingtalk-register-start"]').trigger("click");
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(3000);

      expect(wrapper.get('[data-testid="dingtalk-register-error"]').text()).toContain("device_code 已过期");
      expect(wrapper.find('[data-testid="dingtalk-register-retry"]').exists()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
