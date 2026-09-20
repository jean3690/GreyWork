// QQ「扫码创建机器人」面板契约：引导 → 出码等待 → 取消 / 失败重试。
//
// 宿主命令是替身：这里验证的是界面在三个阶段的行为——不点不调宿主、等待时给出二维码、
// 失败时如实说明并留重试入口。其余通道的宿主也替身化，store 才会认为「桌面端可用」。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import QqRegisterPanel from "@/features/channels/QqRegisterPanel.vue";
import { i18n } from "@/i18n";
import type { QqRegisterPoll, QqStatus } from "@/lib/qq-backend";

const mocks = vi.hoisted(() => ({
  qq: {
    supported: vi.fn(() => true),
    status: vi.fn(
      async (): Promise<QqStatus> => ({
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
      qrUrl: "https://q.qq.com/qqbot/openclaw/connect.html?task_id=TASK-1&_wv=2",
      expiresIn: 300,
      interval: 2,
    })),
    registerPoll: vi.fn(async (): Promise<QqRegisterPoll> => ({ state: "pending", detail: null, appId: null })),
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

vi.mock("@/lib/qq-backend", () => ({ qqBackend: mocks.qq }));
vi.mock("@/lib/wechat-backend", () => ({ wechatBackend: mocks.wechat }));
vi.mock("@/lib/feishu-backend", () => ({ feishuBackend: mocks.feishu }));

beforeEach(() => {
  window.localStorage.clear();
  setActivePinia(createPinia());
  vi.clearAllMocks();
  // clearAllMocks 不清返回实现：上一轮把 supported 改成 false 会漏到下一个用例
  mocks.qq.supported.mockReturnValue(true);
  mocks.wechat.supported.mockReturnValue(true);
  mocks.qq.registerPoll.mockResolvedValue({ state: "pending", detail: null, appId: null });
});

describe("QqRegisterPanel", () => {
  it("引导态不碰宿主；点「扫码创建机器人」后才出二维码", async () => {
    const wrapper = mount(QqRegisterPanel, { global: { plugins: [i18n] } });
    expect(wrapper.find('[data-testid="qq-register-start"]').exists()).toBe(true);
    expect(mocks.qq.registerBegin).not.toHaveBeenCalled();

    await wrapper.get('[data-testid="qq-register-start"]').trigger("click");
    await vi.waitFor(() => expect(wrapper.find('[data-testid="qq-register-qr"]').exists()).toBe(true));
    expect(wrapper.get('[data-testid="qq-register-qr"]').find("svg").exists()).toBe(true);
    // 出码后引导按钮让位给等待态
    expect(wrapper.find('[data-testid="qq-register-start"]').exists()).toBe(false);
  });

  it("取消：回到引导态并作废宿主那边的会话", async () => {
    const wrapper = mount(QqRegisterPanel, { global: { plugins: [i18n] } });
    await wrapper.get('[data-testid="qq-register-start"]').trigger("click");
    await vi.waitFor(() => expect(wrapper.find('[data-testid="qq-register-qr"]').exists()).toBe(true));

    await wrapper.get('[data-testid="qq-register-cancel"]').trigger("click");
    expect(wrapper.find('[data-testid="qq-register-qr"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="qq-register-start"]').exists()).toBe(true);
    expect(mocks.qq.registerCancel).toHaveBeenCalled();
  });

  it("浏览器态：如实说明不可用，而不是渲染点了没反应的按钮", () => {
    mocks.qq.supported.mockReturnValue(false);
    mocks.wechat.supported.mockReturnValue(false);
    const wrapper = mount(QqRegisterPanel, { global: { plugins: [i18n] } });
    expect(wrapper.get('[data-testid="qq-register-unsupported"]').text()).toBe("通道仅桌面端可用。");
    expect(wrapper.find('[data-testid="qq-register-start"]').exists()).toBe(false);
  });

  it("超时：给出原因与重试入口，且不再轮询", async () => {
    vi.useFakeTimers();
    try {
      mocks.qq.registerPoll.mockResolvedValue({ state: "expired", detail: null, appId: null });
      const wrapper = mount(QqRegisterPanel, { global: { plugins: [i18n] } });
      await wrapper.get('[data-testid="qq-register-start"]').trigger("click");
      // 发起是异步的：先让微任务落地，再推进一次轮询间隔
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(2000);

      const error = wrapper.get('[data-testid="qq-register-error"]');
      expect(error.text()).toContain("超时");
      expect(wrapper.find('[data-testid="qq-register-qr"]').exists()).toBe(false);
      expect(wrapper.find('[data-testid="qq-register-retry"]').exists()).toBe(true);

      const calls = mocks.qq.registerPoll.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(mocks.qq.registerPoll.mock.calls.length).toBe(calls);

      // 重试：再走一遍发起流程
      await wrapper.get('[data-testid="qq-register-retry"]').trigger("click");
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.qq.registerBegin).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("失败：优先透传服务端给的描述", async () => {
    vi.useFakeTimers();
    try {
      mocks.qq.registerPoll.mockResolvedValue({
        state: "error",
        detail: "AppSecret 解密失败",
        appId: null,
      });
      const wrapper = mount(QqRegisterPanel, { global: { plugins: [i18n] } });
      await wrapper.get('[data-testid="qq-register-start"]').trigger("click");
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(2000);

      expect(wrapper.get('[data-testid="qq-register-error"]').text()).toContain("AppSecret 解密失败");
      expect(wrapper.find('[data-testid="qq-register-retry"]').exists()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
