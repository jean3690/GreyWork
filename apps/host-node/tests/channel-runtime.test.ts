/**
 * 通道运行时与协议归一：连接态、发送者策略、登出清理、长轮询实链。
 *
 * 网络部分全部指向本地 mock（telegram 走真实连接器 + endpointOverride，
 * 其余连接器用注入的假实现只验状态机），不触外网。
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EventBus } from "../src/events.js";
import { ChannelRuntime } from "../src/channel-runtime.js";
import { CONNECTORS } from "../src/channel-connectors.js";
import {
  decodeFeishuFrame,
  encodeFeishuFrame,
  normalizeDingtalkChatbot,
  normalizeDiscordMessage,
  normalizeFeishuEvent,
  normalizeQqDispatch,
  normalizeTelegramMessage,
  normalizeWecomCallback,
} from "../src/channel-connectors.js";
import { saveChannelCredentials, loadChannelCredentials } from "../src/channel-credentials.js";
import type { Connector, ConnectorContext } from "../src/channel-common.js";
import type { ChannelName } from "../src/channel-common.js";

/** 捕获广播帧的假 WS 客户端。 */
function captureBus(): { bus: EventBus; frames: { event: string; payload: unknown }[] } {
  const bus = new EventBus();
  const frames: { event: string; payload: unknown }[] = [];
  bus.add({
    readyState: 1,
    OPEN: 1,
    send: (frame: string) => frames.push(JSON.parse(frame) as { event: string; payload: unknown }),
  } as never);
  return { bus, frames };
}

function fakeConnectors(overrides: Partial<Record<ChannelName, Connector>> = {}): Record<ChannelName, Connector> {
  const idle: Connector = async (ctx: ConnectorContext) => {
    ctx.runtime.markConnected(ctx.channel);
    await new Promise<void>((resolve) => {
      if (ctx.signal.aborted) return resolve();
      ctx.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  };
  return { ...CONNECTORS, ...Object.fromEntries(Object.keys(CONNECTORS).map((key) => [key, idle])), ...overrides } as Record<
    ChannelName,
    Connector
  >;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("等待超时");
}

const dataDirs: string[] = [];
function freshDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "gw-channels-"));
  dataDirs.push(dir);
  return dir;
}

afterEach(() => {
  // 各用例自建 runtime，disconnect/stopAll 由用例负责；这里只兜底清目录标记。
  dataDirs.length = 0;
});

describe("协议归一（纯函数）", () => {
  it("telegram：文本 / 图片按 getUpdates 形状归一", () => {
    const draft = normalizeTelegramMessage(
      {
        message_id: 7,
        chat: { id: 12345 },
        from: { first_name: "Ada", last_name: "Lovelace" },
        text: "hello",
        photo: [{ file_id: "small" }, { file_id: "large" }],
      },
      1000,
    );
    expect(draft?.peerId).toBe("12345");
    expect(draft?.nick).toBe("Ada Lovelace");
    expect(draft?.text).toBe("hello");
    expect(draft?.media[0]).toMatchObject({ url: "fileid:large", kind: "image" });
  });

  it("discord：只放行私聊、忽略 bot 与服务器频道", () => {
    const dm = normalizeDiscordMessage(
      { id: "m1", channel_id: "c1", content: "hi", author: { id: "u1", username: "ada", bot: false } },
      1000,
    );
    expect(dm?.peerId).toBe("dm:c1");
    expect(normalizeDiscordMessage({ id: "m2", channel_id: "c2", guild_id: "g1" }, 1000)).toBeNull();
    expect(normalizeDiscordMessage({ id: "m3", channel_id: "c3", author: { id: "u2", bot: true } }, 1000)).toBeNull();
  });

  it("qq：C2C / 群 @ 事件分别编码 peerId", () => {
    expect(normalizeQqDispatch("C2C_MESSAGE_CREATE", { id: "q1", author: { user_openid: "open1" }, content: "hi" }, 1000)).toMatchObject({
      peerId: "c2c:open1",
      senderId: "open1",
    });
    expect(
      normalizeQqDispatch("GROUP_AT_MESSAGE_CREATE", { id: "q2", group_openid: "grp", author: { member_openid: "mem" } }, 1000),
    ).toMatchObject({ peerId: "group:grp", senderId: "mem" });
    expect(normalizeQqDispatch("READY", { id: "q3" }, 1000)).toBeNull();
  });

  it("dingtalk：剥掉群聊 @ 前缀，非文本标类型", () => {
    const draft = normalizeDingtalkChatbot(
      JSON.stringify({ msgId: "d1", senderStaffId: "staff1", senderNick: "小明", msgtype: "text", text: { content: "@机器人 你好" } }),
      1000,
    );
    expect(draft?.text).toBe("你好");
    expect(draft?.peerId).toBe("staff1");
  });

  it("feishu：protobuf 帧编解码往返 + 事件归一", () => {
    const frame = {
      seqId: 3,
      logId: 4,
      service: 5,
      method: 1,
      headers: [
        ["type", "event"],
        ["message_id", "m1"],
      ] as [string, string][],
      payloadEncoding: "",
      payloadType: "",
      payload: Buffer.from("{}"),
    };
    const decoded = decodeFeishuFrame(encodeFeishuFrame(frame));
    expect(decoded.seqId).toBe(3);
    expect(decoded.method).toBe(1);
    expect(decoded.headers.find(([key]) => key === "type")?.[1]).toBe("event");
    const draft = normalizeFeishuEvent(
      {
        header: { event_type: "im.message.receive_v1" },
        event: {
          sender: { sender_id: { open_id: "ou_1" } },
          message: { message_id: "m1", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text: "你好" }) },
        },
      },
      1000,
    );
    expect(draft?.peerId).toBe("ou_1");
    expect(draft?.text).toBe("你好");
  });

  it("wecom：单聊 / 群聊与 unsupported 标注", () => {
    expect(normalizeWecomCallback({ from: { userid: "u1" }, msgtype: "text", text: { content: "hi" }, msgid: "w1" }, 1000)).toMatchObject({
      peerId: "single:u1",
      text: "hi",
      unsupported: "",
    });
    expect(normalizeWecomCallback({ from: { userid: "u1" }, chattype: "group", chatid: "g1", msgtype: "image" }, 1000)).toMatchObject({
      peerId: "group:g1",
      text: "",
      unsupported: "image",
    });
  });
});

describe("ChannelRuntime 生命周期", () => {
  it("未配置凭据的 connect 直接报错（不再静默 no-op）", () => {
    const { bus } = captureBus();
    const runtime = new ChannelRuntime(bus, freshDataDir(), fakeConnectors());
    expect(() => runtime.connect("dingtalk", false)).toThrow("通道凭据未配置");
    expect(runtime.status("dingtalk")).toMatchObject({ configured: false, state: "stopped" });
  });

  it("connect → connected 事件 → disconnect → stopped；logout 清凭证", async () => {
    const { bus, frames } = captureBus();
    const dataDir = freshDataDir();
    const runtime = new ChannelRuntime(bus, dataDir, fakeConnectors());
    saveChannelCredentials(dataDir, "telegram", { token: "t" });

    runtime.connect("telegram", false);
    // 假连接器会同步置 connected，但 connecting 这一帧必须已经广播过。
    expect(frames.some((frame) => frame.event === "telegram://state" && (frame.payload as { state: string }).state === "connecting")).toBe(
      true,
    );
    await waitFor(() => runtime.status("telegram").state === "connected");
    expect(frames.some((frame) => frame.event === "telegram://state" && (frame.payload as { state: string }).state === "connected")).toBe(
      true,
    );

    runtime.disconnect("telegram");
    expect(runtime.status("telegram")).toMatchObject({ configured: true, state: "stopped" });

    runtime.logout("telegram");
    expect(loadChannelCredentials(dataDir, "telegram")).toBeNull();
    expect(runtime.status("telegram")).toMatchObject({ configured: false, state: "stopped" });
    expect(existsSync(path.join(dataDir, "telegram", "credentials.json"))).toBe(false);
  });

  it("发送者策略：默认只放行第一个发消息的人", async () => {
    const { bus, frames } = captureBus();
    const runtime = new ChannelRuntime(bus, freshDataDir(), fakeConnectors());
    runtime.emitInbound("wecom", "single:owner", "owner", 1, { text: "hi" }, false);
    runtime.emitInbound("wecom", "single:other", "other", 2, { text: "ignored" }, false);
    const inbound = frames.filter((frame) => frame.event === "wecom://inbound");
    expect(inbound).toHaveLength(1);
    expect((inbound[0]!.payload as { text: string }).text).toBe("hi");

    frames.length = 0;
    runtime.emitInbound("wecom", "single:other", "other", 3, { text: "allowed" }, true);
    expect(frames.filter((frame) => frame.event === "wecom://inbound")).toHaveLength(1);
    expect(runtime.status("wecom")).toMatchObject({ state: "connected", peerCount: 2, lastMessageAt: 3 });
  });

  it("主动断开时连接异常不会把状态覆写成 error", async () => {
    const { bus } = captureBus();
    const dataDir = freshDataDir();
    const connector: Connector = async (ctx: ConnectorContext) => {
      await new Promise<void>((_resolve, reject) => {
        ctx.signal.addEventListener("abort", () => reject(new Error("WebSocket 建连失败: aborted")), { once: true });
      });
    };
    const runtime = new ChannelRuntime(bus, dataDir, fakeConnectors({ discord: connector }));
    saveChannelCredentials(dataDir, "discord", { token: "t" });
    runtime.connect("discord", false);
    runtime.disconnect("discord");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runtime.status("discord").state).toBe("stopped");
  });

  it("策略变更重连：同一策略不重启，不同策略重启", async () => {
    const { bus } = captureBus();
    const dataDir = freshDataDir();
    let starts = 0;
    const connector: Connector = async (ctx: ConnectorContext) => {
      starts += 1;
      ctx.runtime.markConnected(ctx.channel);
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) return resolve();
        ctx.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    };
    const runtime = new ChannelRuntime(bus, dataDir, fakeConnectors({ qq: connector }));
    saveChannelCredentials(dataDir, "qq", { appId: "id", appSecret: "secret" });

    runtime.connect("qq", false);
    await waitFor(() => starts === 1);
    runtime.connect("qq", false);
    expect(starts).toBe(1);
    runtime.connect("qq", true);
    await waitFor(() => starts === 2);
    runtime.disconnect("qq");
  });
});

describe("Telegram 长轮询（本地 mock Bot API）", () => {
  let server: Server | null = null;
  afterEach(() => {
    server?.close();
    server = null;
  });

  it("getUpdates 收到文本 → 广播 telegram://inbound，状态转 connected", async () => {
    let polls = 0;
    server = createServer((request, response) => {
      const url = request.url ?? "";
      if (url.includes("/getUpdates")) {
        polls += 1;
        const updates =
          polls === 1 ? [{ update_id: 1, message: { message_id: 10, chat: { id: 999 }, from: { first_name: "Ada" }, text: "ping" } }] : [];
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, result: updates }));
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    const { bus, frames } = captureBus();
    const dataDir = freshDataDir();
    const runtime = new ChannelRuntime(bus, dataDir);
    saveChannelCredentials(dataDir, "telegram", { token: "test-token" });
    runtime.connect("telegram", false, base);
    try {
      await waitFor(() => frames.some((frame) => frame.event === "telegram://inbound"));
      const inbound = frames.find((frame) => frame.event === "telegram://inbound")!.payload as Record<string, unknown>;
      expect(inbound).toMatchObject({ peerId: "999", nick: "Ada", text: "ping", messageId: "10" });
      expect(runtime.status("telegram").state).toBe("connected");
    } finally {
      runtime.disconnect("telegram");
      runtime.logout("telegram");
    }
  });
});
