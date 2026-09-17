// 远程助手页契约：只做「现状 + 入口」——通不通、跟谁在聊、以及去设置的跳转。
// 配置本身在设置里（本页不再承载扫码 / 开关）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import AssistantsView from "@/features/assistants/AssistantsView.vue";
import { appEvents } from "@/events";
import { i18n } from "@/i18n";
import { createAppRouter } from "@/router";

const mocks = vi.hoisted(() => ({
  backend: {
    supported: () => true,
    status: vi.fn(async () => ({
      loggedIn: true,
      userId: "me@im.wechat",
      botId: "bot-1",
      state: "connected" as const,
      detail: null,
      lastMessageAt: null,
      pendingLogin: false,
    })),
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
  },
}));

vi.mock("@/lib/wechat-backend", () => ({ wechatBackend: mocks.backend }));
vi.mock("@/lib/feishu-backend", () => ({
  feishuBackend: {
    supported: () => true,
    status: vi.fn(async () => ({
      configured: true,
      appId: "cli-xyz",
      state: "connected" as const,
      detail: null,
      lastMessageAt: null,
      peerCount: 0,
    })),
    saveCredentials: vi.fn(),
    clearCredentials: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    onState: vi.fn(async () => () => {}),
    onInbound: vi.fn(async () => () => {}),
  },
}));
vi.mock("@/lib/dingtalk-backend", () => ({
  dingtalkBackend: {
    supported: () => true,
    status: vi.fn(async () => ({
      configured: true,
      clientId: "ding-abc",
      state: "connected" as const,
      detail: null,
      lastMessageAt: null,
      peerCount: 0,
    })),
    saveCredentials: vi.fn(),
    clearCredentials: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    onState: vi.fn(async () => () => {}),
    onInbound: vi.fn(async () => () => {}),
  },
}));

/** 预置一个联系人档案（页面要列出来并作为会话入口）。 */
function seedPeer(): void {
  window.localStorage.setItem(
    "greywork.remote-assistant.peers",
    JSON.stringify({
      peers: [
        {
          channel: "wechat",
          id: "peer@im.wechat",
          nick: "peer",
          sessionId: "s-1",
          contextToken: "ctx-1",
          lastAt: 1_730_000_000_000,
          lastText: "在吗",
          readAt: 0,
        },
      ],
    }),
  );
}

async function mountPage() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createAppRouter();
  await router.push("/assistants");
  await router.isReady();
  const wrapper = mount(AssistantsView, { global: { plugins: [pinia, i18n, router] } });
  return { wrapper, router, pinia };
}

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe("AssistantsView（远程助手）", () => {
  it("七条通道各一张卡：状态徽章、账号、设置入口；配置控件不在本页", async () => {
    const { wrapper } = await mountPage();
    await vi.waitFor(() => expect(wrapper.get('[data-testid="wechat-status-badge"]').text()).toContain("在线"));
    expect(wrapper.text()).toContain("远程助手");
    expect(wrapper.text()).toContain("回复后端");
    expect(wrapper.text()).toContain("本机模型供应商");

    const dingtalkCard = wrapper.get('[data-testid="channel-dingtalk"]');
    await vi.waitFor(() => expect(dingtalkCard.get('[data-testid="dingtalk-status-badge"]').text()).toContain("在线"));
    expect(dingtalkCard.text()).toContain("ding-abc");
    expect(wrapper.get('[data-testid="dingtalk-open-settings"]').text()).toContain("去设置配置");

    const feishuCard = wrapper.get('[data-testid="channel-feishu"]');
    await vi.waitFor(() => expect(feishuCard.get('[data-testid="feishu-status-badge"]').text()).toContain("在线"));
    expect(feishuCard.text()).toContain("cli-xyz");
    expect(wrapper.get('[data-testid="feishu-open-settings"]').text()).toContain("去设置配置");

    // 通道清单由 CHANNELS 驱动：漏加一条通道会在这里露出来（本页是「现状 + 入口」的唯一入口）
    for (const channel of ["wechat", "dingtalk", "feishu", "telegram", "qq", "discord", "wecom"]) {
      expect(wrapper.find(`[data-testid="channel-${channel}"]`).exists()).toBe(true);
      expect(wrapper.find(`[data-testid="${channel}-open-settings"]`).exists()).toBe(true);
    }

    // 配置类控件一律不在本页（在设置里）
    expect(wrapper.find('[data-testid="wechat-qr-panel"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="wechat-auto-reply"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="dingtalk-client-id"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="feishu-client-id"]').exists()).toBe(false);
  });

  it("「去设置配置」经事件总线请求打开设置分区", async () => {
    const seen: { section?: string }[] = [];
    const off = appEvents.on("settings:open", (payload) => seen.push(payload));
    try {
      const { wrapper } = await mountPage();
      await wrapper.get('[data-testid="wechat-open-settings"]').trigger("click");
      expect(seen).toEqual([{ section: "assistant" }]);
    } finally {
      off();
    }
  });

  it("没有联系人时给出空态说明", async () => {
    const { wrapper } = await mountPage();
    expect(wrapper.get('[data-testid="remote-peers-empty"]').text()).toContain("等对方发一条消息");
  });

  it("联系人列表带通道标签，可点进会话页，未读带小圆点", async () => {
    seedPeer();
    const { wrapper, router } = await mountPage();
    const row = wrapper.get('[data-testid="remote-peer-wechat:peer@im.wechat"]');
    expect(row.text()).toContain("在吗");
    expect(row.text()).toContain("微信");
    await row.trigger("click");
    // 目标页是懒加载路由：冷启动下首跳要等模块加载完
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe("/remote/wechat%3Apeer%40im.wechat"), { timeout: 5000 });
  });
});
