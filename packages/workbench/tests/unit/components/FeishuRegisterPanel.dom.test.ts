// 飞书「扫码创建应用」面板契约：引导 → 出码等待 → 取消 / 失败重试。
//
// 宿主命令是替身：这里验证的是界面在三个阶段的行为——不点不调宿主、等待时给出二维码与配对码、
// 失败时如实说明并留重试入口。三条通道的宿主都替身化，store 才会认为「桌面端可用」。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import FeishuRegisterPanel from "@/components/channels/FeishuRegisterPanel.vue";
import { i18n } from "@/i18n";
import type { FeishuRegisterPoll, FeishuStatus } from "@/lib/feishu-backend";

const mocks = vi.hoisted(() => ({
  feishu: {
    supported: vi.fn(() => true),
    status: vi.fn(
      async (): Promise<FeishuStatus> => ({
        configured: false,
        appId: null,
        state: "stopped",
        detail: null,
        lastMessageAt: null,
        peerCount: 0,
      }),
    ),
    saveCredentials: vi.fn(),
    clearCredentials: vi.fn(),
    registerBegin: vi.fn(async () => ({
      qrUrl: "https://open.feishu.cn/page/launcher?user_code=LF7S-N6L6",
      userCode: "LF7S-N6L6",
      expiresIn: 3600,
      interval: 1,
    })),
    registerPoll: vi.fn(
      async (): Promise<FeishuRegisterPoll> => ({
        state: "pending",
        detail: null,
        appId: null,
        intervalMs: 1000,
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
  dingtalk: { supported: vi.fn(() => true) },
}));

vi.mock("@/lib/feishu-backend", () => ({ feishuBackend: mocks.feishu }));
vi.mock("@/lib/wechat-backend", () => ({ wechatBackend: mocks.wechat }));
vi.mock("@/lib/dingtalk-backend", () => ({ dingtalkBackend: mocks.dingtalk }));

beforeEach(() => {
  window.localStorage.clear();
  setActivePinia(createPinia());
  vi.clearAllMocks();
  // clearAllMocks 不清返回实现：上一轮把 supported 改成 false 会漏到下一个用例
  mocks.feishu.supported.mockReturnValue(true);
  mocks.wechat.supported.mockReturnValue(true);
});

describe("FeishuRegisterPanel", () => {
  it("引导态不碰宿主；点「扫码创建应用」后才出二维码与配对码", async () => {
    const wrapper = mount(FeishuRegisterPanel, { global: { plugins: [i18n] } });
    expect(wrapper.find('[data-testid="feishu-register-start"]').exists()).toBe(true);
    expect(mocks.feishu.registerBegin).not.toHaveBeenCalled();

    await wrapper.get('[data-testid="feishu-register-start"]').trigger("click");
    await vi.waitFor(() => expect(wrapper.find('[data-testid="feishu-register-qr"]').exists()).toBe(true));
    expect(wrapper.get('[data-testid="feishu-register-qr"]').find("svg").exists()).toBe(true);
    expect(wrapper.get('[data-testid="feishu-register-code"]').text()).toContain("LF7S-N6L6");
    // 出码后引导按钮让位给等待态
    expect(wrapper.find('[data-testid="feishu-register-start"]').exists()).toBe(false);
  });

  it("取消：回到引导态并作废宿主那边的会话", async () => {
    const wrapper = mount(FeishuRegisterPanel, { global: { plugins: [i18n] } });
    await wrapper.get('[data-testid="feishu-register-start"]').trigger("click");
    await vi.waitFor(() => expect(wrapper.find('[data-testid="feishu-register-qr"]').exists()).toBe(true));

    await wrapper.get('[data-testid="feishu-register-cancel"]').trigger("click");
    expect(wrapper.find('[data-testid="feishu-register-qr"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="feishu-register-start"]').exists()).toBe(true);
    expect(mocks.feishu.registerCancel).toHaveBeenCalled();
  });

  it("浏览器态：如实说明不可用，而不是渲染点了没反应的按钮", () => {
    mocks.feishu.supported.mockReturnValue(false);
    mocks.wechat.supported.mockReturnValue(false);
    const wrapper = mount(FeishuRegisterPanel, { global: { plugins: [i18n] } });
    expect(wrapper.get('[data-testid="feishu-register-unsupported"]').text()).toBe("通道仅桌面端可用。");
    expect(wrapper.find('[data-testid="feishu-register-start"]').exists()).toBe(false);
  });

  it("被拒 / 超时：给出原因与重试入口，且不再轮询", async () => {
    vi.useFakeTimers();
    try {
      mocks.feishu.registerPoll.mockResolvedValue({
        state: "denied",
        detail: null,
        appId: null,
        intervalMs: null,
      });
      const wrapper = mount(FeishuRegisterPanel, { global: { plugins: [i18n] } });
      await wrapper.get('[data-testid="feishu-register-start"]').trigger("click");
      // 发起是异步的：先让微任务落地，再推进一次轮询间隔
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(1000);

      const error = wrapper.get('[data-testid="feishu-register-error"]');
      expect(error.text()).toContain("取消");
      expect(wrapper.find('[data-testid="feishu-register-qr"]').exists()).toBe(false);
      expect(wrapper.find('[data-testid="feishu-register-retry"]').exists()).toBe(true);

      const calls = mocks.feishu.registerPoll.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(mocks.feishu.registerPoll.mock.calls.length).toBe(calls);

      // 重试：再走一遍发起流程
      mocks.feishu.registerPoll.mockResolvedValue({
        state: "pending",
        detail: null,
        appId: null,
        intervalMs: 1000,
      });
      await wrapper.get('[data-testid="feishu-register-retry"]').trigger("click");
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.feishu.registerBegin).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
