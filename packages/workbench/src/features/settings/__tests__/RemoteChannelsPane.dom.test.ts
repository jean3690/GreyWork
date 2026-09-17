// 设置 · 远程助手面板契约：三条通道各自的配置入口 + 共用回复后端。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import RemoteChannelsPane from "@/features/settings/RemoteChannelsPane.vue";
import { appEvents } from "@/events";
import { i18n } from "@/i18n";
import type { FeishuStatus } from "@/lib/feishu-backend";
import { useAgentStore } from "@/stores/agent";
import { useRemoteAssistantStore } from "@/stores/remote-assistant";
import { useSettingsStore } from "@/stores/settings";

const mocks = vi.hoisted(() => ({
  wechat: {
    supported: vi.fn(() => true),
    status: vi.fn(async () => ({
      loggedIn: false,
      userId: null,
      botId: null,
      state: "stopped" as const,
      detail: null,
      lastMessageAt: null,
      pendingLogin: false,
    })),
    loginQr: vi.fn(async () => ({ content: "https://liteapp.weixin.qq.com/q/demo" })),
    loginPoll: vi.fn(() => new Promise<never>(() => {})),
    loginCancel: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    logout: vi.fn(),
    send: vi.fn(),
    sendTyping: vi.fn(),
    onState: vi.fn(async () => () => {}),
    onInbound: vi.fn(async () => () => {}),
  },
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
    registerPoll: vi.fn(async () => ({ state: "pending" as const, detail: null, appId: null, intervalMs: 1000 })),
    registerCancel: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    onState: vi.fn(async () => () => {}),
    onInbound: vi.fn(async () => () => {}),
  },
  dingtalk: {
    supported: vi.fn(() => true),
    status: vi.fn(async () => ({
      configured: false,
      clientId: null,
      state: "stopped" as const,
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

vi.mock("@/lib/wechat-backend", () => ({ wechatBackend: mocks.wechat }));
vi.mock("@/lib/dingtalk-backend", () => ({ dingtalkBackend: mocks.dingtalk }));
vi.mock("@/lib/feishu-backend", () => ({ feishuBackend: mocks.feishu }));

beforeEach(() => {
  window.localStorage.clear();
  setActivePinia(createPinia());
  vi.clearAllMocks();
  mocks.dingtalk.saveCredentials.mockImplementation(async (clientId: string) => ({
    configured: true,
    clientId,
    state: "stopped",
    detail: null,
    lastMessageAt: null,
    peerCount: 0,
  }));
  mocks.dingtalk.connect.mockResolvedValue(undefined);
  mocks.feishu.saveCredentials.mockImplementation(async (appId: string) => ({
    configured: true,
    appId,
    state: "stopped",
    detail: null,
    lastMessageAt: null,
    peerCount: 0,
  }));
  mocks.feishu.connect.mockResolvedValue(undefined);
});

describe("RemoteChannelsPane", () => {
  it("三条通道各有一块配置：微信扫码，钉钉 / 飞书填应用凭证", () => {
    const wrapper = mount(RemoteChannelsPane, { global: { plugins: [i18n] } });
    expect(wrapper.find('[data-testid="wechat-channel-actions"]').exists()).toBe(true);
    for (const channel of ["dingtalk", "feishu"] as const) {
      expect(wrapper.find(`[data-testid="${channel}-channel-actions"]`).exists()).toBe(true);
      expect(wrapper.find(`[data-testid="${channel}-client-id"]`).exists()).toBe(true);
      expect(wrapper.find(`[data-testid="${channel}-client-secret"]`).exists()).toBe(true);
      expect(wrapper.find(`[data-testid="${channel}-auto-reply"]`).exists()).toBe(true);
    }
    // 飞书有「扫码创建」，钉钉没有（开放平台不提供程序化建应用）
    expect(wrapper.find('[data-testid="feishu-register-panel"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="dingtalk-register-panel"]').exists()).toBe(false);
  });

  it("飞书：扫码创建应用出码，凭证入口仍留着手填", async () => {
    const wrapper = mount(RemoteChannelsPane, { global: { plugins: [i18n] } });
    await wrapper.get('[data-testid="feishu-register-start"]').trigger("click");
    await vi.waitFor(() => expect(wrapper.find('[data-testid="feishu-register-qr"]').exists()).toBe(true));
    expect(mocks.feishu.registerBegin).toHaveBeenCalled();
    // 两条路径并存：已有应用的人照样能填
    expect(wrapper.find('[data-testid="feishu-client-id"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="feishu-credentials-label"]').text()).toContain("手动");
  });

  it("飞书凭证：填 App ID 保存后立即尝试连接", async () => {
    const wrapper = mount(RemoteChannelsPane, { global: { plugins: [i18n] } });
    await wrapper.get('[data-testid="feishu-client-id"]').setValue("cli_abc");
    await wrapper.get('[data-testid="feishu-client-secret"]').setValue("secret-xyz");
    await wrapper.get('[data-testid="feishu-save"]').trigger("click");
    await vi.waitFor(() => expect(mocks.feishu.saveCredentials).toHaveBeenCalledWith("cli_abc", "secret-xyz"));
    await vi.waitFor(() => expect(mocks.feishu.connect).toHaveBeenCalled());
    expect((wrapper.get('[data-testid="feishu-client-id"]').element as HTMLInputElement).value).toBe("");
  });

  it("微信开关写入设置并持久化", async () => {
    const wrapper = mount(RemoteChannelsPane, { global: { plugins: [i18n] } });
    const settings = useSettingsStore();
    expect(settings.remoteAssist.channels.wechat.autoReply).toBe(true);

    await wrapper.get('[data-testid="wechat-auto-reply"]').setValue(false);
    expect(settings.remoteAssist.channels.wechat.autoReply).toBe(false);
    expect(settings.remoteAssist.channels.wechat.autoConnect).toBe(true);

    const raw = window.localStorage.getItem("greywork.settings");
    expect(JSON.parse(raw ?? "{}").remoteAssist.channels.wechat).toEqual({
      autoConnect: true,
      autoReply: false,
      allowOtherSenders: false,
    });
  });

  it("钉钉凭证：填 clientId 保存后立即尝试连接（密钥不留在界面）", async () => {
    const wrapper = mount(RemoteChannelsPane, { global: { plugins: [i18n] } });
    expect(wrapper.get('[data-testid="dingtalk-save"]').attributes("disabled")).toBeDefined();

    await wrapper.get('[data-testid="dingtalk-client-id"]').setValue("ding-abc");
    await wrapper.get('[data-testid="dingtalk-client-secret"]').setValue("secret-xyz");
    await wrapper.get('[data-testid="dingtalk-save"]').trigger("click");

    await vi.waitFor(() => expect(mocks.dingtalk.saveCredentials).toHaveBeenCalledWith("ding-abc", "secret-xyz"));
    await vi.waitFor(() => expect(mocks.dingtalk.connect).toHaveBeenCalled());
    // 保存后输入框清空，界面不再留明文
    expect((wrapper.get('[data-testid="dingtalk-client-id"]').element as HTMLInputElement).value).toBe("");
    expect(wrapper.find('[data-testid="dingtalk-saved"]').exists()).toBe(true);
  });

  it("回复后端可切到 ACP 并选定后端（写回设置）", async () => {
    const wrapper = mount(RemoteChannelsPane, { global: { plugins: [i18n] } });
    const settings = useSettingsStore();
    const agent = useAgentStore();
    expect(settings.remoteAssist.replyMode).toBe("llm");
    expect(wrapper.find('[data-testid="wechat-reply-provider"]').exists()).toBe(false);

    await wrapper.get('[data-testid="wechat-reply-mode-acp"]').trigger("click");
    expect(settings.remoteAssist.replyMode).toBe("acp");
    const select = wrapper.get('[data-testid="wechat-reply-provider"]');
    expect(select.findAll("option").length).toBe(agent.agentProviders.filter((provider) => provider.enabled).length + 1);

    const first = agent.agentProviders.find((provider) => provider.enabled);
    await select.setValue(first?.id ?? "");
    expect(settings.remoteAssist.replyProviderId).toBe(first?.id);
  });

  it("ACP 档位给出去 Agent 设置管理后端的入口", async () => {
    const seen: { section?: string }[] = [];
    const off = appEvents.on("settings:open", (payload) => seen.push(payload));
    try {
      const wrapper = mount(RemoteChannelsPane, { global: { plugins: [i18n] } });
      await wrapper.get('[data-testid="wechat-reply-mode-acp"]').trigger("click");
      await wrapper.get('[data-testid="wechat-open-agent-settings"]').trigger("click");
      expect(seen).toEqual([{ section: "agent" }]);
    } finally {
      off();
    }
  });

  it("点微信「扫码连接」后面板内出现二维码", async () => {
    const wrapper = mount(RemoteChannelsPane, { global: { plugins: [i18n] } });
    await wrapper.get('[data-testid="wechat-connect"]').trigger("click");
    await vi.waitFor(() => expect(wrapper.find('[data-testid="wechat-qr-svg"]').exists()).toBe(true));
    expect(wrapper.find('[data-testid="wechat-qr-svg"]').find("svg").exists()).toBe(true);
    expect(mocks.wechat.loginQr).toHaveBeenCalled();
  });

  it("浏览器态如实说明不可用，而不是渲染死按钮", () => {
    mocks.wechat.supported.mockReturnValue(false);
    const wrapper = mount(RemoteChannelsPane, { global: { plugins: [i18n] } });
    expect(useRemoteAssistantStore().available).toBe(false);
    expect(wrapper.text()).toContain("通道仅桌面端可用。");
    // 扫码入口同样不给死按钮
    expect(wrapper.find('[data-testid="feishu-register-unsupported"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="feishu-register-start"]').exists()).toBe(false);
  });
});
