// 微信会话页契约：两侧消息分列、能从桌面端手发（走 sendmessage 命令）、
// 没有对方凭据 / 通道未连接时如实禁用并说明。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import RemoteConversationView from "@/features/channels/RemoteConversationView.vue";
import { i18n } from "@/i18n";
import { createAppRouter } from "@/router";
import { useRemoteAssistantStore } from "@/stores/remote-assistant";
import { useSessionStore } from "@/stores/session";

const mocks = vi.hoisted(() => ({
  backend: {
    supported: () => true,
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
  },
}));

vi.mock("@/lib/wechat-backend", () => ({ wechatBackend: mocks.backend }));
vi.mock("@/lib/dingtalk-backend", () => ({
  dingtalkBackend: {
    supported: () => true,
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

const PEER = "peer@im.wechat";

/** 建一条联系人会话 + 档案（token 可缺省，用来演「对方还没来过消息」）。 */
function seedPeer(options: { contextToken: string | null }): string {
  const sessionStore = useSessionStore();
  const session = sessionStore.createSession(null, "微信 · peer");
  sessionStore.appendMessage(session.id, { id: "m1", role: "user", content: "帮我看看今天的安排", ts: 1 });
  sessionStore.appendMessage(session.id, { id: "m2", role: "assistant", content: "**八点** 有个会", ts: 2 });
  window.localStorage.setItem(
    "greywork.remote-assistant.peers",
    JSON.stringify({
      peers: [
        { id: PEER, sessionId: session.id, contextToken: options.contextToken, lastAt: 2, lastText: "帮我看看今天的安排", readAt: 1 },
      ],
    }),
  );
  return session.id;
}

async function mountPage(connected: boolean, peer: { contextToken: string | null }) {
  seedPeer(peer);
  mocks.backend.status.mockResolvedValue({
    loggedIn: true,
    userId: "me@im.wechat",
    botId: "bot-1",
    state: connected ? "connected" : "stopped",
    detail: null,
    lastMessageAt: null,
    pendingLogin: false,
  });
  const router = createAppRouter();
  await router.push(`/remote/${encodeURIComponent(`wechat:${PEER}`)}`);
  await router.isReady();
  const wrapper = mount(RemoteConversationView, { global: { plugins: [pinia, i18n, router] } });
  // 会话页挂载即拉一次状态（连接态用于决定能否发送）
  await useRemoteAssistantStore().refreshStatus();
  await wrapper.vm.$nextTick();
  return { wrapper, router };
}

let pinia: Pinia;

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
  mocks.backend.send.mockResolvedValue(undefined);
  mocks.backend.sendTyping.mockResolvedValue(undefined);
  // 联系人档案要能被 store 读到：pinia 先立起来，seed 才能在挂载前写档案
  pinia = createPinia();
  setActivePinia(pinia);
});

describe("RemoteConversationView", () => {
  it("两侧消息都在：对端在左、本机回复在右", async () => {
    const { wrapper } = await mountPage(true, { contextToken: "ctx-1" });
    const bubbles = wrapper.findAll("[data-role]");
    expect(bubbles.map((bubble) => bubble.attributes("data-role"))).toEqual(["user", "assistant"]);
    expect(bubbles[0].text()).toContain("帮我看看今天的安排");
    expect(bubbles[1].text()).toContain("八点");
  });

  it("有对方凭据且通道在线：能发送，消息走宿主命令并清空输入", async () => {
    const { wrapper } = await mountPage(true, { contextToken: "ctx-1" });
    const input = wrapper.get('[data-testid="remote-composer-input"]');
    await input.setValue("收到，我八点到");
    await wrapper.get('[data-testid="remote-composer-send"]').trigger("click");

    await vi.waitFor(() => expect(mocks.backend.send).toHaveBeenCalledWith(PEER, "ctx-1", "收到，我八点到"));
    await vi.waitFor(() => expect((input.element as HTMLTextAreaElement).value).toBe(""));
    // 手发的消息也进会话（对方那侧看到的就是这条）
    expect(wrapper.findAll("[data-role]").at(-1)?.text()).toContain("我八点到");
  });

  it("对方还没发过消息：禁用发送并说明原因（协议要求带上对方凭据）", async () => {
    const { wrapper } = await mountPage(true, { contextToken: null });
    expect(wrapper.get('[data-testid="remote-composer-send"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-testid="remote-composer-hint"]').text()).toContain("对方还没发过消息");
    expect(wrapper.find('[data-testid="remote-composer-error"]').exists()).toBe(false);
  });

  it("通道未连接：禁用发送并提示去设置里连接", async () => {
    const { wrapper } = await mountPage(false, { contextToken: "ctx-1" });
    expect(wrapper.get('[data-testid="remote-composer-send"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-testid="remote-composer-hint"]').text()).toContain("通道未连接");
  });
});
