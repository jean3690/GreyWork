// 微信会话页契约：两侧消息分列、能从桌面端手发（走 sendmessage 命令）、
// 没有对方凭据 / 通道未连接时如实禁用并说明；附件走 send media 命令。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import RemoteConversationView from "@/features/channels/RemoteConversationView.vue";
import { i18n } from "@/i18n";
import { createAppRouter } from "@/router";
import { useRemoteAssistantStore } from "@/stores/remote-assistant";
import { useSessionStore } from "@/stores/session";
import type * as AttachmentLibrary from "@/state/attachment-library";
import type * as ChannelMedia from "@/lib/channel-media";
import type { Attachment } from "@/types";

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

// 出站媒体已收进通用层（按 channel 分发），断言打在这里。
const mediaMocks = vi.hoisted(() => ({
  capabilities: vi.fn<() => Promise<Record<string, { inbound: string[]; outbound: string[] }>>>(async () => ({})),
  sendMedia: vi.fn<(channel: string, peerId: string, path: string, kind?: string, token?: string) => Promise<void>>(),
  takeMedia: vi.fn<(channel: string, path: string) => Promise<Uint8Array>>(),
}));

// 附件采集要弹系统选择器（DOM 环境里点不出来），只把这两处替换掉，
// 其余（缩略图 / 字节读取）仍走真实实现。
const attachmentMocks = vi.hoisted(() => ({
  pick: vi.fn<() => Promise<Attachment[]>>(),
  materialize: vi.fn<(sessionId: string, items: readonly Attachment[]) => Promise<Attachment[]>>(),
  objectUrl: vi.fn<(item: Attachment) => Promise<string | null>>(),
}));

vi.mock("@/state/attachment-library", async (importOriginal) => ({
  ...(await importOriginal<typeof AttachmentLibrary>()),
  pickAttachments: () => attachmentMocks.pick(),
  materializeAttachments: (sessionId: string, items: readonly Attachment[]) => attachmentMocks.materialize(sessionId, items),
  attachmentObjectUrl: (item: Attachment) => attachmentMocks.objectUrl(item),
}));

vi.mock("@/lib/wechat-backend", () => ({ wechatBackend: mocks.backend }));
vi.mock("@/lib/channel-media", async (importOriginal) => {
  const actual = await importOriginal<typeof ChannelMedia>();
  return {
    ...actual,
    channelMediaBackend: {
      capabilities: () => mediaMocks.capabilities(),
      takeMedia: (channel: string, path: string) => mediaMocks.takeMedia(channel, path),
      sendMedia: (channel: string, peerId: string, path: string, kind?: string, token?: string) =>
        mediaMocks.sendMedia(channel, peerId, path, kind, token),
    },
  };
});
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
  mediaMocks.sendMedia.mockResolvedValue(undefined);
  attachmentMocks.pick.mockResolvedValue([]);
  attachmentMocks.objectUrl.mockResolvedValue(null);
  attachmentMocks.materialize.mockImplementation((_sessionId, items) =>
    Promise.resolve(
      items.map((item) => ({ id: item.id, kind: item.kind, name: item.name, mime: item.mime, size: item.size, path: `/tmp/${item.id}` })),
    ),
  );
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

  it("消息里的附件也渲染：文件出文件名 chip", async () => {
    const { wrapper } = await mountPage(true, { contextToken: "ctx-1" });
    const sessionId = useRemoteAssistantStore().peerById(`wechat:${PEER}`)!.sessionId;
    useSessionStore().appendMessage(sessionId, {
      id: "m3",
      role: "user",
      content: "",
      ts: 3,
      attachments: [{ id: "att-1", kind: "file", name: "报表.xlsx", mime: "application/vnd.ms-excel", size: 9, path: "/tmp/报表.xlsx" }],
    });

    await vi.waitFor(() => expect(wrapper.find('[data-testid="remote-attachment-file"]').exists()).toBe(true));
    expect(wrapper.get('[data-testid="remote-attachment-file"]').text()).toContain("报表.xlsx");
  });

  it("消息里的视频 / 语音出内联播放器", async () => {
    attachmentMocks.objectUrl.mockResolvedValue("blob:remote");
    const { wrapper } = await mountPage(true, { contextToken: "ctx-1" });
    const sessionId = useRemoteAssistantStore().peerById(`wechat:${PEER}`)!.sessionId;
    useSessionStore().appendMessage(sessionId, {
      id: "m4",
      role: "user",
      content: "",
      ts: 4,
      attachments: [
        { id: "att-v", kind: "video", name: "clip.mp4", mime: "video/mp4", size: 9, path: "/tmp/clip.mp4" },
        { id: "att-a", kind: "audio", name: "voice.ogg", mime: "audio/ogg", size: 9, path: "/tmp/voice.ogg" },
      ],
    });

    await vi.waitFor(() => expect(wrapper.find('[data-testid="remote-attachment-video"]').exists()).toBe(true));
    expect(wrapper.get('[data-testid="remote-attachment-video"]').attributes("src")).toBe("blob:remote");
    expect(wrapper.get('[data-testid="remote-attachment-audio"]').attributes("src")).toBe("blob:remote");
    expect(wrapper.find('[data-testid="remote-attachment-file"]').exists()).toBe(false);
  });

  it("只有附件没有文字也能发：走 sendMedia，不发文本", async () => {
    const { wrapper } = await mountPage(true, { contextToken: "ctx-1" });
    attachmentMocks.pick.mockResolvedValue([
      { id: "att-1", kind: "file", name: "report.pdf", mime: "application/pdf", size: 9, bytes: new Uint8Array([1, 2]) },
    ]);

    await wrapper.get('[data-testid="remote-composer-attach"]').trigger("click");
    await vi.waitFor(() => expect(wrapper.find('[data-testid="composer-attachments"]').exists()).toBe(true));

    const send = wrapper.get('[data-testid="remote-composer-send"]');
    expect(send.attributes("disabled")).toBeUndefined();
    await send.trigger("click");

    await vi.waitFor(() => expect(mediaMocks.sendMedia).toHaveBeenCalledWith("wechat", PEER, "/tmp/att-1", "file", "ctx-1"));
    expect(mocks.backend.send).not.toHaveBeenCalled();
  });

  it("附件未落盘（草稿没有 path）时发送不发 sendMedia", async () => {
    const { wrapper } = await mountPage(true, { contextToken: "ctx-1" });
    attachmentMocks.pick.mockResolvedValue([{ id: "att-2", kind: "file", name: "ghost.pdf", mime: "application/pdf", size: 1 }]);
    attachmentMocks.materialize.mockResolvedValue([{ id: "att-2", kind: "file", name: "ghost.pdf", mime: "application/pdf", size: 1 }]);

    await wrapper.get('[data-testid="remote-composer-attach"]').trigger("click");
    await vi.waitFor(() => expect(wrapper.find('[data-testid="composer-attachments"]').exists()).toBe(true));

    await wrapper.get('[data-testid="remote-composer-send"]').trigger("click");

    await vi.waitFor(() => expect(useRemoteAssistantStore().activity.some((entry) => entry.kind === "error")).toBe(true));
    expect(mediaMocks.sendMedia).not.toHaveBeenCalled();
  });

  it("通道只能接收媒体（inboundOnly）：禁用附件入口并说明原因", async () => {
    const { wrapper } = await mountPage(true, { contextToken: "ctx-1" });
    mediaMocks.capabilities.mockResolvedValueOnce({ wechat: { inbound: ["image", "video", "audio", "file"], outbound: [] } });
    await useRemoteAssistantStore().refreshMediaCapabilities();
    await wrapper.vm.$nextTick();

    expect(wrapper.get('[data-testid="remote-composer-attach"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-testid="remote-composer-hint"]').text()).toContain("只能接收文件");
  });

  it("通道只能发图片（企业微信）：附件入口可用，提示按原生类别列举", async () => {
    const { wrapper } = await mountPage(true, { contextToken: "ctx-1" });
    mediaMocks.capabilities.mockResolvedValueOnce({ wechat: { inbound: ["image", "video", "file"], outbound: ["image"] } });
    await useRemoteAssistantStore().refreshMediaCapabilities();
    await wrapper.vm.$nextTick();

    expect(wrapper.get('[data-testid="remote-composer-attach"]').attributes("disabled")).toBeUndefined();
    expect(wrapper.get('[data-testid="remote-composer-hint"]').text()).toContain("只能发送图片");
  });
});
