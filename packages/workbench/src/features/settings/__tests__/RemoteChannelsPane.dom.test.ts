// 设置 · 远程助手面板契约：集成清单（通道 + 本机集成）+ 点开的配置弹窗。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import RemoteChannelsPane from "@/features/settings/RemoteChannelsPane.vue";
import { appEvents } from "@/events";
import { i18n } from "@/i18n";
import type { FeishuStatus } from "@/lib/feishu-backend";
import { useAgentStore } from "@/stores/agent";
import { useSettingsStore } from "@/stores/settings";

// 弹窗内容 Portal 到 body：断言一律查 document.body，挂载要 attachTo 且显式 unmount。
const mounted: VueWrapper[] = [];

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
  telegram: {
    supported: vi.fn(() => true),
    status: vi.fn(async () => ({
      configured: false,
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
    botLink: vi.fn(async () => ({ username: "greywork_bot", name: "GreyWork", url: "https://t.me/greywork_bot" })),
    onState: vi.fn(async () => () => {}),
    onInbound: vi.fn(async () => () => {}),
  },
  qq: {
    supported: vi.fn(() => true),
    status: vi.fn(async () => ({
      configured: false,
      appId: null,
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
  wecom: {
    supported: vi.fn(() => true),
    status: vi.fn(async () => ({
      configured: false,
      botId: null,
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
  discord: {
    supported: vi.fn(() => true),
    status: vi.fn(async () => ({
      configured: false,
      botUsername: null,
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
vi.mock("@/lib/discord-backend", () => ({ discordBackend: mocks.discord }));
vi.mock("@/lib/qq-backend", () => ({ qqBackend: mocks.qq }));
vi.mock("@/lib/wecom-backend", () => ({ wecomBackend: mocks.wecom }));
vi.mock("@/lib/dingtalk-backend", () => ({ dingtalkBackend: mocks.dingtalk }));
vi.mock("@/lib/feishu-backend", () => ({ feishuBackend: mocks.feishu }));
vi.mock("@/lib/telegram-backend", () => ({ telegramBackend: mocks.telegram }));

beforeEach(() => {
  window.localStorage.clear();
  setActivePinia(createPinia());
  vi.clearAllMocks();
  mocks.wechat.supported.mockReturnValue(true);
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
  mocks.telegram.saveCredentials.mockImplementation(async () => ({
    configured: true,
    state: "stopped",
    detail: null,
    lastMessageAt: null,
    peerCount: 0,
  }));
  mocks.telegram.connect.mockResolvedValue(undefined);
  mocks.qq.saveCredentials.mockImplementation(async (appId: string) => ({
    configured: true,
    appId,
    state: "stopped",
    detail: null,
    lastMessageAt: null,
    peerCount: 0,
  }));
  mocks.qq.connect.mockResolvedValue(undefined);
  mocks.wecom.saveCredentials.mockImplementation(async (botId: string) => ({
    configured: true,
    botId,
    state: "stopped",
    detail: null,
    lastMessageAt: null,
    peerCount: 0,
  }));
  mocks.wecom.connect.mockResolvedValue(undefined);
  mocks.discord.saveCredentials.mockImplementation(async () => ({
    configured: true,
    botUsername: "GreyWork",
    state: "stopped",
    detail: null,
    lastMessageAt: null,
    peerCount: 0,
  }));
  mocks.discord.connect.mockResolvedValue(undefined);
});

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = "";
});

async function render(): Promise<VueWrapper> {
  const wrapper = mount(RemoteChannelsPane, { global: { plugins: [i18n] }, attachTo: document.body });
  mounted.push(wrapper);
  await flushPromises();
  return wrapper;
}

/** 点清单里的一行，等弹窗挂上。 */
async function openRow(wrapper: VueWrapper, testId: string): Promise<void> {
  await wrapper.get(`[data-testid="${testId}"]`).trigger("click");
  await flushPromises();
}

/** 弹窗内容在 body 上：wrapper.find 够不到。 */
function dialog(testId: string): DOMWrapper<Element> {
  const element = document.body.querySelector(`[data-testid="${testId}"]`);
  if (!element) throw new Error(`未渲染出 ${testId}`);
  return new DOMWrapper(element);
}

describe("RemoteChannelsPane 集成清单", () => {
  it("七条通道 + 三条本机集成各占一行，通道行带状态胶囊", async () => {
    const wrapper = await render();
    for (const channel of ["wechat", "dingtalk", "feishu", "telegram", "qq", "discord", "wecom"]) {
      expect(wrapper.find(`[data-testid="row-${channel}"]`).exists()).toBe(true);
    }
    for (const integration of ["reply", "mcp", "skills"]) {
      expect(wrapper.find(`[data-testid="row-integration-${integration}"]`).exists()).toBe(true);
    }
    // 未配置凭证的通道如实标「未配置」，而不是假装能用
    expect(wrapper.get('[data-testid="row-dingtalk"]').text()).toContain("未配置");
    expect(wrapper.get('[data-testid="row-telegram"]').text()).toContain("未配置");
    expect(wrapper.get('[data-testid="row-qq"]').text()).toContain("未配置");
    expect(wrapper.get('[data-testid="row-wecom"]').text()).toContain("未配置");
    expect(wrapper.get('[data-testid="row-discord"]').text()).toContain("未配置");
  });

  it("微信行：弹窗里扫码连接后出二维码", async () => {
    const wrapper = await render();
    await openRow(wrapper, "row-wechat");
    const panel = dialog("channel-dialog-wechat");

    await panel.get('[data-testid="wechat-connect"]').trigger("click");
    await flushPromises();
    await vi.waitFor(() => expect(document.body.querySelector('[data-testid="wechat-qr-svg"]')).not.toBeNull());
    expect(mocks.wechat.loginQr).toHaveBeenCalled();
  });

  it("钉钉行：填 clientId 保存后立即连接，密钥不留在界面", async () => {
    const wrapper = await render();
    await openRow(wrapper, "row-dingtalk");
    const panel = dialog("channel-dialog-dingtalk");
    expect(panel.get('[data-testid="dingtalk-save"]').attributes("disabled")).toBeDefined();

    await panel.get('[data-testid="dingtalk-client-id"]').setValue("ding-abc");
    await panel.get('[data-testid="dingtalk-client-secret"]').setValue("secret-xyz");
    await panel.get('[data-testid="dingtalk-save"]').trigger("click");

    await vi.waitFor(() => expect(mocks.dingtalk.saveCredentials).toHaveBeenCalledWith("ding-abc", "secret-xyz"));
    await vi.waitFor(() => expect(mocks.dingtalk.connect).toHaveBeenCalled());
    expect((panel.get('[data-testid="dingtalk-client-id"]').element as HTMLInputElement).value).toBe("");
    expect(panel.find('[data-testid="dingtalk-saved"]').exists()).toBe(true);
  });

  it("飞书行：扫码创建应用出码，手填凭证入口仍在", async () => {
    const wrapper = await render();
    await openRow(wrapper, "row-feishu");
    const panel = dialog("channel-dialog-feishu");

    await panel.get('[data-testid="feishu-register-start"]').trigger("click");
    await vi.waitFor(() => expect(document.body.querySelector('[data-testid="feishu-register-qr"]')).not.toBeNull());
    expect(mocks.feishu.registerBegin).toHaveBeenCalled();
    expect(panel.get('[data-testid="feishu-credentials-label"]').text()).toContain("手动");
  });

  it("Telegram 行：填 bot token 保存后立即连接，并就地换成扫码绑定码", async () => {
    const wrapper = await render();
    await openRow(wrapper, "row-telegram");
    const panel = dialog("channel-dialog-telegram");
    // 未配置：先给 BotFather 的建机器人引导码
    expect(document.body.querySelector('[data-testid="telegram-botfather-qr"]')).not.toBeNull();

    await panel.get('[data-testid="telegram-token"]').setValue("123456789:AAF-abcdefghijkl");
    await panel.get('[data-testid="telegram-save"]').trigger("click");

    await vi.waitFor(() => expect(mocks.telegram.saveCredentials).toHaveBeenCalledWith("123456789:AAF-abcdefghijkl"));
    await vi.waitFor(() => expect(mocks.telegram.connect).toHaveBeenCalled());
    // 保存后 configured 变真：面板就地切成绑定码（宿主 getMe 拿 t.me/<bot>）
    await vi.waitFor(() => expect(document.body.querySelector('[data-testid="telegram-bind-qr"]')).not.toBeNull());
    expect(mocks.telegram.botLink).toHaveBeenCalled();
  });

  it("QQ 行：填 AppID / AppSecret 保存后立即连接", async () => {
    const wrapper = await render();
    await openRow(wrapper, "row-qq");
    const panel = dialog("channel-dialog-qq");
    expect(panel.get('[data-testid="qq-save"]').attributes("disabled")).toBeDefined();

    await panel.get('[data-testid="qq-client-id"]').setValue("102xxxxxx");
    await panel.get('[data-testid="qq-client-secret"]').setValue("secret-xyz");
    await panel.get('[data-testid="qq-save"]').trigger("click");

    await vi.waitFor(() => expect(mocks.qq.saveCredentials).toHaveBeenCalledWith("102xxxxxx", "secret-xyz"));
    await vi.waitFor(() => expect(mocks.qq.connect).toHaveBeenCalled());
    expect((panel.get('[data-testid="qq-client-id"]').element as HTMLInputElement).value).toBe("");
    expect(panel.find('[data-testid="qq-saved"]').exists()).toBe(true);
  });

  it("企业微信行：填 BotID / Secret 保存后立即连接", async () => {
    const wrapper = await render();
    await openRow(wrapper, "row-wecom");
    const panel = dialog("channel-dialog-wecom");

    await panel.get('[data-testid="wecom-client-id"]').setValue("bot_abc123");
    await panel.get('[data-testid="wecom-client-secret"]').setValue("secret-xyz");
    await panel.get('[data-testid="wecom-save"]').trigger("click");

    await vi.waitFor(() => expect(mocks.wecom.saveCredentials).toHaveBeenCalledWith("bot_abc123", "secret-xyz"));
    await vi.waitFor(() => expect(mocks.wecom.connect).toHaveBeenCalled());
    expect(panel.find('[data-testid="wecom-saved"]').exists()).toBe(true);
  });

  it("Discord 行：填 bot token 保存后立即连接，只收私聊的边界写在面板里", async () => {
    const wrapper = await render();
    await openRow(wrapper, "row-discord");
    const panel = dialog("channel-dialog-discord");
    // 未配置时保存按钮不可点，且必须先说明「只收私聊」
    expect(panel.get('[data-testid="discord-save"]').attributes("disabled")).toBeDefined();
    expect(panel.get('[data-testid="discord-dm-hint"]').text()).toContain("只收私聊");

    await panel.get('[data-testid="discord-token"]').setValue("MTA1NDU2Nzg5.GxYzAb.abcdefghijklmnopqrstuvwxyz0");
    await panel.get('[data-testid="discord-save"]').trigger("click");

    await vi.waitFor(() => expect(mocks.discord.saveCredentials).toHaveBeenCalledWith("MTA1NDU2Nzg5.GxYzAb.abcdefghijklmnopqrstuvwxyz0"));
    await vi.waitFor(() => expect(mocks.discord.connect).toHaveBeenCalled());
    expect((panel.get('[data-testid="discord-token"]').element as HTMLInputElement).value).toBe("");
    expect(panel.find('[data-testid="discord-saved"]').exists()).toBe(true);
  });

  it("通道弹窗里的开关写入设置并持久化", async () => {
    const wrapper = await render();
    const settings = useSettingsStore();
    await openRow(wrapper, "row-wechat");
    const panel = dialog("channel-dialog-wechat");
    expect(settings.remoteAssist.channels.wechat.autoReply).toBe(true);

    await panel.get('[data-testid="wechat-auto-reply"]').setValue(false);
    expect(settings.remoteAssist.channels.wechat.autoReply).toBe(false);
    expect(settings.remoteAssist.channels.wechat.autoConnect).toBe(true);

    const raw = window.localStorage.getItem("greywork.settings");
    expect(JSON.parse(raw ?? "{}").remoteAssist.channels.wechat).toEqual({
      autoConnect: true,
      autoReply: false,
      allowOtherSenders: false,
    });
  });
});

describe("RemoteChannelsPane 本机集成", () => {
  it("回复管线：切到 ACP、选定后端，并给出细粒度配置项", async () => {
    const wrapper = await render();
    const settings = useSettingsStore();
    const agent = useAgentStore();
    agent.acpConfigOptions = [
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "gpt-5",
        options: [
          { value: "gpt-5", name: "GPT-5" },
          { value: "gpt-5-mini", name: "GPT-5 mini" },
        ],
      },
    ];

    await openRow(wrapper, "row-integration-reply");
    const panel = dialog("remote-reply-dialog");
    expect(settings.remoteAssist.replyMode).toBe("llm");

    await panel.get('[data-testid="reply-mode-acp"]').trigger("click");
    expect(settings.remoteAssist.replyMode).toBe("acp");

    const providerSelect = panel.get('[data-testid="reply-provider"]');
    expect(providerSelect.findAll("option").length).toBe(agent.agentProviders.filter((provider) => provider.enabled).length + 1);
    const first = agent.agentProviders.find((provider) => provider.enabled);
    await providerSelect.setValue(first?.id ?? "");
    expect(settings.remoteAssist.replyProviderId).toBe(first?.id);

    // 细粒度覆盖：留空 = 跟随当前会话，选定后写进设置
    const modelSelect = panel.get('[data-testid="reply-config-model"]');
    expect(modelSelect.findAll("option")[0].text()).toContain("跟随当前会话");
    await modelSelect.setValue("gpt-5-mini");
    expect(settings.remoteAssist.acpConfigValues).toEqual({ model: "gpt-5-mini" });
    // 清空即删除覆盖（回到跟随）
    await modelSelect.setValue("");
    expect(settings.remoteAssist.acpConfigValues).toEqual({});
  });

  it("回复管线：给出去 Agent 设置管理后端的入口", async () => {
    const seen: { section?: string }[] = [];
    const off = appEvents.on("settings:open", (payload) => seen.push(payload));
    try {
      const wrapper = await render();
      await openRow(wrapper, "row-integration-reply");
      await dialog("remote-reply-dialog").get('[data-testid="reply-open-agent-settings"]').trigger("click");
      expect(seen).toEqual([{ section: "agent" }]);
    } finally {
      off();
    }
  });

  it("MCP：勾选启用写回设置，跳转设置入口可用", async () => {
    const seen: { section?: string }[] = [];
    const off = appEvents.on("settings:open", (payload) => seen.push(payload));
    try {
      const wrapper = await render();
      const settings = useSettingsStore();
      await openRow(wrapper, "row-integration-mcp");
      const panel = dialog("remote-mcp-dialog");

      const server = settings.mcpServers[0];
      expect(server.enabled).toBe(false);
      await panel.get(`[data-testid="mcp-toggle-${server.id}"]`).setValue(true);
      expect(settings.mcpServers[0].enabled).toBe(true);

      await panel.get('[data-testid="mcp-open-settings"]').trigger("click");
      expect(seen).toEqual([{ section: "mcp" }]);
    } finally {
      off();
    }
  });

  it("技能：弹窗列出磁盘扫描结果（无宿主时如实说明）", async () => {
    const wrapper = await render();
    await openRow(wrapper, "row-integration-skills");
    const panel = dialog("remote-skills-dialog");
    expect(panel.text()).toContain("浏览器预览态只读");
  });
});
