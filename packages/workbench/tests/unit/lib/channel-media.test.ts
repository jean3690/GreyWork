// 远程媒体通用层的契约：一对通用命令（按 channel 分发）+ 能力矩阵兜底。
// 命令名 / 参数形状必须与宿主 `channel_media.rs` 的 `#[tauri::command]` 对齐。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as GreyworkCore from "@greywork/core";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args?: Record<string, unknown>) => ({})),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@greywork/core", async (importOriginal) => ({
  ...(await importOriginal<typeof GreyworkCore>()),
  isTauriRuntime: () => true,
}));

import { channelMediaAllows, channelMediaBackend, channelMediaHint, defaultChannelMediaCapability } from "@/lib/channel-media";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("defaultChannelMediaCapability", () => {
  it("与宿主 capability_of 同口径：入站全类别，出站按各通道原生能力", () => {
    const all = ["image", "video", "audio", "file"];
    expect(defaultChannelMediaCapability("wechat").outbound).toEqual(["image", "video", "file"]);
    expect(defaultChannelMediaCapability("telegram").outbound).toEqual(all);
    expect(defaultChannelMediaCapability("discord").outbound).toEqual(all);
    expect(defaultChannelMediaCapability("feishu").outbound).toEqual(["image", "file"]);
    expect(defaultChannelMediaCapability("qq").outbound).toEqual(["image", "video", "file"]);
    expect(defaultChannelMediaCapability("wecom").outbound).toEqual(["image"]);
    expect(defaultChannelMediaCapability("dingtalk").outbound).toEqual([]);
    expect(defaultChannelMediaCapability("nope")).toEqual({ inbound: [], outbound: [] });
    // 入站：企业微信暂缓语音，其余全类别。
    expect(defaultChannelMediaCapability("wecom").inbound).toEqual(["image", "video", "file"]);
    expect(defaultChannelMediaCapability("telegram").inbound).toEqual(all);
  });
});

describe("channelMediaAllows", () => {
  it("原生支持即放行；否则能发文件就降级放行；不能发文件则挡下", () => {
    const caps = defaultChannelMediaCapability;
    expect(channelMediaAllows(caps("telegram"), "video")).toBe(true);
    expect(channelMediaAllows(caps("telegram"), "audio")).toBe(true);
    // 微信无原生语音 → 降级为文件放行。
    expect(channelMediaAllows(caps("wechat"), "audio")).toBe(true);
    // 飞书无原生视频 → 降级为文件放行。
    expect(channelMediaAllows(caps("feishu"), "video")).toBe(true);
    // 企业微信只能发图片：文件 / 视频 / 语音全挡。
    expect(channelMediaAllows(caps("wecom"), "image")).toBe(true);
    expect(channelMediaAllows(caps("wecom"), "file")).toBe(false);
    expect(channelMediaAllows(caps("wecom"), "video")).toBe(false);
    expect(channelMediaAllows(caps("wecom"), "audio")).toBe(false);
    // 钉钉出站全无。
    for (const kind of ["image", "video", "audio", "file"] as const) {
      expect(channelMediaAllows(caps("dingtalk"), kind)).toBe(false);
    }
  });
});

describe("channelMediaHint", () => {
  it("能发文件的通道不给提示（不占位）", () => {
    for (const channel of ["telegram", "discord", "wechat", "qq", "feishu"]) {
      expect(channelMediaHint(defaultChannelMediaCapability(channel))).toBe("");
    }
  });

  it("只能发原生类别时按类别列举（企业微信只有图片）", () => {
    expect(channelMediaHint(defaultChannelMediaCapability("wecom"))).toBe("这条通道只能发送图片。");
  });

  it("多个原生类别用分隔符连接", () => {
    expect(channelMediaHint({ inbound: ["image"], outbound: ["image", "video"] })).toBe("这条通道只能发送图片、视频。");
  });

  it("完全发不了媒体：能收则提示只能接收，否则提示不支持", () => {
    expect(channelMediaHint(defaultChannelMediaCapability("dingtalk"))).toBe("这条通道只能接收文件，不能发送。");
    expect(channelMediaHint({ inbound: [], outbound: [] })).toBe("这条通道不支持发送图片或文件。");
  });
});

describe("channelMediaBackend", () => {
  it("能力矩阵：一条无参命令直取宿主", async () => {
    mocks.invoke.mockResolvedValueOnce({ wechat: { inbound: ["image"], outbound: ["image"] } });
    const caps = await channelMediaBackend.capabilities();
    expect(caps).toEqual({ wechat: { inbound: ["image"], outbound: ["image"] } });
    expect(mocks.invoke).toHaveBeenCalledWith("channel_media_capabilities");
  });

  it("取入站媒体：原始字节回传（走 ipc::Response，不是 base64 字符串）", async () => {
    mocks.invoke.mockResolvedValueOnce(new Uint8Array([1, 2, 3]).buffer as never);

    const bytes = await channelMediaBackend.takeMedia("wechat", "/app/wechat/inbox/1-0.png");

    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(mocks.invoke).toHaveBeenCalledWith("channel_take_media", { channel: "wechat", path: "/app/wechat/inbox/1-0.png" });
  });

  it("取入站媒体：载荷形状不对时报错而不是强转", async () => {
    mocks.invoke.mockResolvedValueOnce({ oops: true } as never);
    await expect(channelMediaBackend.takeMedia("wechat", "/app/wechat/inbox/1-0.png")).rejects.toThrow(/非二进制载荷/);
  });

  it("发媒体：命令名与参数形状；kind / contextToken 省略时下发 null", async () => {
    await channelMediaBackend.sendMedia("telegram", "tg-1", "/tmp/a.pdf", "file");
    expect(mocks.invoke).toHaveBeenCalledWith("channel_send_media", {
      channel: "telegram",
      peerId: "tg-1",
      path: "/tmp/a.pdf",
      kind: "file",
      contextToken: null,
    });

    await channelMediaBackend.sendMedia("wechat", "wx-1", "/tmp/a.png", undefined, "ctx-1");
    expect(mocks.invoke).toHaveBeenLastCalledWith("channel_send_media", {
      channel: "wechat",
      peerId: "wx-1",
      path: "/tmp/a.png",
      kind: null,
      contextToken: "ctx-1",
    });
  });
});
