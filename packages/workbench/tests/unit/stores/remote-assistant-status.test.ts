// 状态切片的可观测契约：七通道状态归一 / connected 语义 / 刷新门禁（浏览器态早退、
// 空快照不覆盖）/ botLink 成败分支 / 活动流上限。切片经 createStatusSlice({ state }) 直接注入。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVITY_LIMIT, type RemoteChannel } from "@/stores/remote-assistant/shared";

const backends = vi.hoisted(() => ({
  wechatStatus: vi.fn<() => Promise<unknown>>(() => Promise.resolve({})),
  dingtalkStatus: vi.fn<() => Promise<unknown>>(() => Promise.resolve({})),
  feishuStatus: vi.fn<() => Promise<unknown>>(() => Promise.resolve({})),
  telegramStatus: vi.fn<() => Promise<unknown>>(() => Promise.resolve({})),
  qqStatus: vi.fn<() => Promise<unknown>>(() => Promise.resolve({})),
  discordStatus: vi.fn<() => Promise<unknown>>(() => Promise.resolve({})),
  wecomStatus: vi.fn<() => Promise<unknown>>(() => Promise.resolve({})),
  botLink: vi.fn<() => Promise<unknown>>(() => Promise.resolve({ username: "gw_bot" })),
}));

vi.mock("@/lib/wechat-backend", () => ({ wechatBackend: { status: () => backends.wechatStatus() } }));
vi.mock("@/lib/dingtalk-backend", () => ({ dingtalkBackend: { status: () => backends.dingtalkStatus() } }));
vi.mock("@/lib/feishu-backend", () => ({ feishuBackend: { status: () => backends.feishuStatus() } }));
vi.mock("@/lib/qq-backend", () => ({ qqBackend: { status: () => backends.qqStatus() } }));
vi.mock("@/lib/discord-backend", () => ({ discordBackend: { status: () => backends.discordStatus() } }));
vi.mock("@/lib/wecom-backend", () => ({ wecomBackend: { status: () => backends.wecomStatus() } }));
vi.mock("@/lib/telegram-backend", () => ({
  telegramBackend: { status: () => backends.telegramStatus(), botLink: () => backends.botLink() },
}));

import { createStatusSlice, type StatusApi } from "@/stores/remote-assistant/status";
import type { RemoteAssistantState } from "@/stores/remote-assistant/state";
import type { WechatStatus } from "@/lib/wechat-backend";
import type { DingTalkStatus } from "@/lib/dingtalk-backend";
import type { FeishuStatus } from "@/lib/feishu-backend";
import type { TelegramBotLink, TelegramStatus } from "@/lib/telegram-backend";
import type { QqStatus } from "@/lib/qq-backend";
import type { DiscordStatus } from "@/lib/discord-backend";
import type { WecomStatus } from "@/lib/wecom-backend";

const CHANNELS: RemoteChannel[] = ["wechat", "dingtalk", "feishu", "telegram", "qq", "discord", "wecom"];

interface StatusHarness {
  api: StatusApi;
  available: { value: boolean };
  status: { value: WechatStatus | null };
  dingtalkStatus: { value: DingTalkStatus | null };
  feishuStatus: { value: FeishuStatus | null };
  telegramStatus: { value: TelegramStatus | null };
  qqStatus: { value: QqStatus | null };
  discordStatus: { value: DiscordStatus | null };
  wecomStatus: { value: WecomStatus | null };
  telegramBotLink: { value: { link: TelegramBotLink | null; error: string | null } };
  activity: { value: unknown[] };
}

function build(): StatusHarness {
  const available = { value: true };
  const status = { value: null };
  const dingtalkStatus = { value: null };
  const feishuStatus = { value: null };
  const telegramStatus = { value: null };
  const qqStatus = { value: null };
  const discordStatus = { value: null };
  const wecomStatus = { value: null };
  const telegramBotLink = { value: { link: null, error: null } };
  const activity = { value: [] as unknown[] };
  const api = createStatusSlice({
    state: {
      available,
      status,
      dingtalkStatus,
      feishuStatus,
      telegramStatus,
      qqStatus,
      discordStatus,
      wecomStatus,
      telegramBotLink,
      activity,
    } as unknown as RemoteAssistantState,
  });
  return {
    api,
    available,
    status,
    dingtalkStatus,
    feishuStatus,
    telegramStatus,
    qqStatus,
    discordStatus,
    wecomStatus,
    telegramBotLink,
    activity,
  };
}

beforeEach(() => {
  for (const fn of [
    backends.wechatStatus,
    backends.dingtalkStatus,
    backends.feishuStatus,
    backends.telegramStatus,
    backends.qqStatus,
    backends.discordStatus,
    backends.wecomStatus,
    backends.botLink,
  ]) {
    fn.mockClear();
  }
  for (const fn of [
    backends.wechatStatus,
    backends.dingtalkStatus,
    backends.feishuStatus,
    backends.telegramStatus,
    backends.qqStatus,
    backends.discordStatus,
    backends.wecomStatus,
  ]) {
    fn.mockImplementation(() => Promise.resolve({ state: "connected" }));
  }
});

describe("通道状态归一", () => {
  it("未接入的通道（无快照）：回落 idleChannelStatus", () => {
    const h = build();
    for (const channel of CHANNELS) {
      expect(h.api.statusOf(channel)).toEqual({ ready: false, state: "stopped", detail: null, lastMessageAt: null, account: null });
    }
  });

  it("微信：ready=loggedIn，account=userId", () => {
    const h = build();
    h.status.value = {
      loggedIn: true,
      userId: "me@im.wechat",
      botId: null,
      state: "connected",
      detail: null,
      lastMessageAt: 7,
      pendingLogin: false,
    };
    expect(h.api.statusOf("wechat")).toEqual({ ready: true, state: "connected", detail: null, lastMessageAt: 7, account: "me@im.wechat" });
  });

  it("钉钉：ready=configured，account=clientId", () => {
    const h = build();
    h.dingtalkStatus.value = { configured: true, clientId: "cli-9", state: "error", detail: "限流", lastMessageAt: 3, peerCount: 2 };
    expect(h.api.statusOf("dingtalk")).toEqual({ ready: true, state: "error", detail: "限流", lastMessageAt: 3, account: "cli-9" });
  });

  it("飞书 / QQ：ready=configured，account=appId", () => {
    const h = build();
    h.feishuStatus.value = { configured: true, appId: "app-f", state: "connected", detail: null, lastMessageAt: 1, peerCount: 0 };
    h.qqStatus.value = { configured: true, appId: "app-q", state: "connected", detail: null, lastMessageAt: 1, peerCount: 0 };
    expect(h.api.statusOf("feishu").account).toBe("app-f");
    expect(h.api.statusOf("qq").account).toBe("app-q");
    expect(h.api.statusOf("feishu").ready).toBe(true);
  });

  it("Discord：account=botUsername；企业微信：account=botId", () => {
    const h = build();
    h.discordStatus.value = { configured: true, botUsername: "@bot", state: "connected", detail: null, lastMessageAt: 1, peerCount: 0 };
    h.wecomStatus.value = { configured: true, botId: "bot-w", state: "connected", detail: null, lastMessageAt: 1, peerCount: 0 };
    expect(h.api.statusOf("discord").account).toBe("@bot");
    expect(h.api.statusOf("wecom").account).toBe("bot-w");
  });

  it("Telegram：ready=configured，但没有可展示的 account（token 不进状态）", () => {
    const h = build();
    h.telegramStatus.value = { configured: true, state: "connected", detail: null, lastMessageAt: 4, peerCount: 1 };
    expect(h.api.statusOf("telegram")).toEqual({ ready: true, state: "connected", detail: null, lastMessageAt: 4, account: null });
  });
});

describe("connected 语义", () => {
  it("connectedOf：只有 state === connected 才算收消息中", () => {
    const h = build();
    h.status.value = {
      loggedIn: true,
      userId: "u",
      botId: null,
      state: "connecting",
      detail: null,
      lastMessageAt: null,
      pendingLogin: false,
    };
    expect(h.api.connectedOf("wechat")).toBe(false);
    h.status.value = {
      loggedIn: true,
      userId: "u",
      botId: null,
      state: "connected",
      detail: null,
      lastMessageAt: null,
      pendingLogin: false,
    };
    expect(h.api.connectedOf("wechat")).toBe(true);
    expect(h.api.connected.value).toBe(true);
  });

  it("connected 是微信通道的当前连接态（沿用既有调用点语义）", () => {
    const h = build();
    h.status.value = { loggedIn: true, userId: "u", botId: null, state: "stopped", detail: null, lastMessageAt: null, pendingLogin: false };
    expect(h.api.connected.value).toBe(false);
  });
});

describe("刷新门禁", () => {
  it("浏览器态（available=false）：各刷新入口不碰宿主、原样返回", async () => {
    const h = build();
    h.available.value = false;
    await h.api.refreshStatus();
    await h.api.refreshDingTalkStatus();
    await h.api.refreshTelegramBotLink();
    for (const fn of [backends.wechatStatus, backends.dingtalkStatus, backends.telegramStatus, backends.botLink]) {
      expect(fn).not.toHaveBeenCalled();
    }
    await expect(h.api.refreshTelegramBotLink()).resolves.toBeNull();
  });

  it("微信：宿主快照写回 state", async () => {
    const h = build();
    backends.wechatStatus.mockResolvedValue({
      loggedIn: true,
      userId: "u",
      botId: "b",
      state: "connected",
      detail: null,
      lastMessageAt: 9,
      pendingLogin: false,
    });
    const next = await h.api.refreshStatus();
    expect(h.status.value!.state).toBe("connected");
    expect(next.userId).toBe("u");
  });

  it("钉钉：宿主没给快照时不覆盖现有状态（展示面不被打崩）", async () => {
    const h = build();
    h.dingtalkStatus.value = { configured: true, clientId: "cli", state: "connected", detail: null, lastMessageAt: 1, peerCount: 0 };
    backends.dingtalkStatus.mockResolvedValue(null);
    const next = await h.api.refreshDingTalkStatus();
    expect(h.dingtalkStatus.value!.state).toBe("connected");
    expect(next.state).toBe("connected");
  });

  it("钉钉：宿主给了快照时更新", async () => {
    const h = build();
    backends.dingtalkStatus.mockResolvedValue({
      configured: false,
      clientId: null,
      state: "stopped",
      detail: null,
      lastMessageAt: null,
      peerCount: 0,
    });
    await h.api.refreshDingTalkStatus();
    expect(h.dingtalkStatus.value).toMatchObject({ configured: false, state: "stopped" });
  });

  it("Telegram botLink 成功：记录链接，返回 it", async () => {
    const h = build();
    backends.botLink.mockResolvedValue({ username: "gw_bot", link: "https://t.me/gw_bot" });
    expect(await h.api.refreshTelegramBotLink()).toEqual({ username: "gw_bot", link: "https://t.me/gw_bot" });
    expect(h.telegramBotLink.value.error).toBeNull();
  });

  it("Telegram botLink 失败：error 落进状态，返回 null（码摆不出来要说清为什么）", async () => {
    const h = build();
    backends.botLink.mockRejectedValue(new Error("token 无效"));
    expect(await h.api.refreshTelegramBotLink()).toBeNull();
    expect(h.telegramBotLink.value.link).toBeNull();
    expect(h.telegramBotLink.value.error).toBe("token 无效");
  });
});

describe("活动流", () => {
  it("recordActivity：新记录排最前，带 id 与时间戳", () => {
    const h = build();
    h.api.recordActivity({ direction: "in", channel: "wechat", peer: "甲", text: "第一条", kind: "text" });
    h.api.recordActivity({ direction: "in", channel: "wechat", peer: "乙", text: "第二条", kind: "text" });
    expect(h.activity.value).toHaveLength(2);
    const [first, second] = h.activity.value as [{ text: string }, { text: string }];
    expect(first.text).toBe("第二条");
    expect(second.text).toBe("第一条");
    expect((first as unknown as { id: string }).id.startsWith("wa")).toBe(true);
    expect(typeof (first as unknown as { at: number }).at).toBe("number");
  });

  it("recordActivity：只保留最近一屏（ACTIVITY_LIMIT）", () => {
    const h = build();
    for (let i = 0; i < ACTIVITY_LIMIT + 7; i += 1) {
      h.api.recordActivity({ direction: "in", channel: "qq", peer: "p", text: `m${i}`, kind: "text" });
    }
    expect(h.activity.value).toHaveLength(ACTIVITY_LIMIT);
    const head = h.activity.value[0];
    const tail = h.activity.value[ACTIVITY_LIMIT - 1];
    expect((head as { text: string }).text).toBe(`m${ACTIVITY_LIMIT + 6}`);
    expect((tail as { text: string }).text).toBe(`m${7}`);
  });
});
