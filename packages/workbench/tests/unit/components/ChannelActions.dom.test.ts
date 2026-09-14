// 通道交互件：状态徽章 + 动作按钮（微信 / 钉钉同一套），以及二维码面板的取消 / 重试。
// 浏览器态（无宿主）必须禁用并说明，而不是渲染出点了没反应的按钮。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ChannelActions from "@/components/channels/ChannelActions.vue";
import WechatQrPanel from "@/components/channels/WechatQrPanel.vue";
import { i18n } from "@/i18n";
import type { DingTalkStatus } from "@/lib/dingtalk-backend";
import type { FeishuStatus } from "@/lib/feishu-backend";
import { useRemoteAssistantStore } from "@/stores/remote-assistant";

const mocks = vi.hoisted(() => {
  const feishu = {
    supported: () => true,
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
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    onState: vi.fn(async () => () => {}),
    onInbound: vi.fn(async () => () => {}),
  };
  const dingtalk = {
    supported: () => true,
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
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    onState: vi.fn(async () => () => {}),
    onInbound: vi.fn(async () => () => {}),
  };
  const backend = {
    supported: vi.fn(() => true),
    status: vi.fn(),
    loginQr: vi.fn(),
    loginPoll: vi.fn(),
    loginCancel: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    logout: vi.fn(),
    send: vi.fn(),
    sendTyping: vi.fn(),
    onState: vi.fn(async () => () => {}),
    onInbound: vi.fn(async () => () => {}),
  };
  return { backend, dingtalk, feishu };
});

vi.mock("@/lib/wechat-backend", () => ({ wechatBackend: mocks.backend }));
vi.mock("@/lib/dingtalk-backend", () => ({ dingtalkBackend: mocks.dingtalk }));
vi.mock("@/lib/feishu-backend", () => ({ feishuBackend: mocks.feishu }));

function status(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    loggedIn: false,
    userId: null,
    botId: null,
    state: "stopped",
    detail: null,
    lastMessageAt: null,
    pendingLogin: false,
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  setActivePinia(createPinia());
  vi.clearAllMocks();
  mocks.backend.supported.mockReturnValue(true);
  mocks.backend.status.mockImplementation(async () => status());
  mocks.backend.loginQr.mockResolvedValue({ content: "https://liteapp.weixin.qq.com/q/demo" });
  // 真实宿主的扫码轮询是长轮询：用不兑现的 promise 表示「等待扫码」。
  mocks.backend.loginPoll.mockImplementation(() => new Promise<never>(() => {}));
  mocks.backend.loginCancel.mockResolvedValue(undefined);
  mocks.backend.connect.mockResolvedValue(undefined);
  mocks.backend.disconnect.mockResolvedValue(undefined);
  mocks.backend.logout.mockResolvedValue(undefined);
  mocks.dingtalk.status.mockResolvedValue({
    configured: false,
    clientId: null,
    state: "stopped",
    detail: null,
    lastMessageAt: null,
    peerCount: 0,
  });
  mocks.dingtalk.connect.mockResolvedValue(undefined);
  mocks.dingtalk.disconnect.mockResolvedValue(undefined);
  mocks.dingtalk.clearCredentials.mockResolvedValue(undefined);
  mocks.feishu.status.mockResolvedValue({
    configured: false,
    appId: null,
    state: "stopped",
    detail: null,
    lastMessageAt: null,
    peerCount: 0,
  });
  mocks.feishu.connect.mockResolvedValue(undefined);
  mocks.feishu.disconnect.mockResolvedValue(undefined);
  mocks.feishu.clearCredentials.mockResolvedValue(undefined);
});

describe("ChannelActions", () => {
  it("未登录：提示先扫码，扫码连接拉起二维码流程", async () => {
    const wrapperWechat = mount(ChannelActions, { props: { channel: "wechat" as const }, global: { plugins: [i18n] } });
    expect(wrapperWechat.get('[data-testid="wechat-blocked-hint"]').text()).toContain("先在下面扫码登录");

    const wrapper = mount(ChannelActions, { props: { channel: "wechat" as const }, global: { plugins: [i18n] } });
    expect(wrapper.get('[data-testid="wechat-status-badge"]').text()).toContain("未连接");
    await wrapper.get('[data-testid="wechat-connect"]').trigger("click");
    await vi.waitFor(() => expect(mocks.backend.loginQr).toHaveBeenCalled());
  });

  it("已登录未连接：显示连接；已连接：显示断开与退出", async () => {
    mocks.backend.status.mockResolvedValue(status({ loggedIn: true, userId: "me@im.wechat", state: "stopped" }));
    const store = useRemoteAssistantStore();
    await store.refreshStatus();
    const wrapper = mount(ChannelActions, { props: { channel: "wechat" as const }, global: { plugins: [i18n] } });
    expect(wrapper.get('[data-testid="wechat-status-badge"]').text()).toContain("未连接");
    await wrapper.get('[data-testid="wechat-connect"]').trigger("click");
    await vi.waitFor(() => expect(mocks.backend.connect).toHaveBeenCalledWith(false));

    // 连上之后同一组件换成「断开连接 + 退出登录」
    mocks.backend.status.mockResolvedValue(status({ loggedIn: true, userId: "me@im.wechat", state: "connected" }));
    await store.refreshStatus();
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="wechat-disconnect"]').exists()).toBe(true);
    await wrapper.get('[data-testid="wechat-forget"]').trigger("click");
    await vi.waitFor(() => expect(mocks.backend.logout).toHaveBeenCalled());
  });

  it("浏览器态（无宿主）：不渲染动作按钮，直接说明原因", () => {
    mocks.backend.supported.mockReturnValue(false);
    const wrapper = mount(ChannelActions, { props: { channel: "wechat" as const }, global: { plugins: [i18n] } });
    expect(wrapper.find('[data-testid="wechat-connect"]').exists()).toBe(false);
    expect(wrapper.text()).toContain("通道仅桌面端可用。");
  });
});

describe("WechatQrPanel", () => {
  it("等待扫码时渲染二维码，取消即作废本次扫码", async () => {
    const store = useRemoteAssistantStore();
    await store.startLogin();
    const wrapper = mount(WechatQrPanel, { global: { plugins: [i18n] } });
    expect(wrapper.find('[data-testid="wechat-qr-svg"]').find("svg").exists()).toBe(true);
    expect(wrapper.text()).toContain("用手机微信扫码");

    await wrapper.get('[data-testid="wechat-qr-cancel"]').trigger("click");
    await vi.waitFor(() => expect(mocks.backend.loginCancel).toHaveBeenCalled());
    expect(store.qr).toBeNull();
  });

  it("取码失败：给出原因与重试入口", async () => {
    mocks.backend.loginQr.mockRejectedValueOnce(new Error("网络不可达"));
    const store = useRemoteAssistantStore();
    await store.startLogin();
    const wrapper = mount(WechatQrPanel, { global: { plugins: [i18n] } });
    expect(wrapper.get('[data-testid="wechat-qr-error"]').text()).toContain("网络不可达");

    await wrapper.get('[data-testid="wechat-qr-retry"]').trigger("click");
    await vi.waitFor(() => expect(mocks.backend.loginQr).toHaveBeenCalledTimes(2));
  });
});

describe("ChannelActions · 钉钉", () => {
  it("未配置凭证：只提示去填，不给连接按钮", () => {
    const wrapper = mount(ChannelActions, { props: { channel: "dingtalk" as const }, global: { plugins: [i18n] } });
    expect(wrapper.get('[data-testid="dingtalk-status-badge"]').text()).toContain("未连接");
    expect(wrapper.get('[data-testid="dingtalk-blocked-hint"]').text()).toContain("先填应用凭证");
    expect(wrapper.find('[data-testid="dingtalk-connect"]').exists()).toBe(false);
  });

  it("已配置未连接：连接按钮拉起长连接", async () => {
    mocks.dingtalk.status.mockResolvedValue({
      configured: true,
      clientId: "ding-1",
      state: "stopped",
      detail: null,
      lastMessageAt: null,
      peerCount: 0,
    });
    const store = useRemoteAssistantStore();
    await store.refreshDingTalkStatus();
    const wrapper = mount(ChannelActions, { props: { channel: "dingtalk" as const }, global: { plugins: [i18n] } });
    expect(wrapper.get('[data-testid="dingtalk-status-badge"]').text()).toContain("未连接");
    await wrapper.get('[data-testid="dingtalk-connect"]').trigger("click");
    await vi.waitFor(() => expect(mocks.dingtalk.connect).toHaveBeenCalledWith(false));
  });

  it("已连接：显示断开与清除凭证", async () => {
    mocks.dingtalk.status.mockResolvedValue({
      configured: true,
      clientId: "ding-1",
      state: "connected",
      detail: null,
      lastMessageAt: null,
      peerCount: 0,
    });
    const store = useRemoteAssistantStore();
    await store.refreshDingTalkStatus();
    const wrapper = mount(ChannelActions, { props: { channel: "dingtalk" as const }, global: { plugins: [i18n] } });
    expect(wrapper.get('[data-testid="dingtalk-status-badge"]').text()).toContain("已连接");
    await wrapper.get('[data-testid="dingtalk-disconnect"]').trigger("click");
    await vi.waitFor(() => expect(mocks.dingtalk.disconnect).toHaveBeenCalled());
    await wrapper.get('[data-testid="dingtalk-forget"]').trigger("click");
    await vi.waitFor(() => expect(mocks.dingtalk.clearCredentials).toHaveBeenCalled());
  });
});

describe("ChannelActions · 飞书", () => {
  it("未配置凭证：只提示去填；填好后连接拉起长连接", async () => {
    const wrapper = mount(ChannelActions, { props: { channel: "feishu" as const }, global: { plugins: [i18n] } });
    expect(wrapper.get('[data-testid="feishu-blocked-hint"]').text()).toContain("先填应用凭证");
    expect(wrapper.find('[data-testid="feishu-connect"]').exists()).toBe(false);

    mocks.feishu.status.mockResolvedValue({
      configured: true,
      appId: "cli-1",
      state: "stopped",
      detail: null,
      lastMessageAt: null,
      peerCount: 0,
    });
    const store = useRemoteAssistantStore();
    await store.refreshFeishuStatus();
    await wrapper.vm.$nextTick();

    expect(wrapper.get('[data-testid="feishu-status-badge"]').text()).toContain("未连接");
    await wrapper.get('[data-testid="feishu-connect"]').trigger("click");
    await vi.waitFor(() => expect(mocks.feishu.connect).toHaveBeenCalledWith(false));
  });
});
