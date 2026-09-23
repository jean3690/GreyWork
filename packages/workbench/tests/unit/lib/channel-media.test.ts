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

import { channelMediaBackend, defaultMediaCapability, mediaCapabilityAllows } from "@/lib/channel-media";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("defaultMediaCapability", () => {
  it("与宿主 capability_of 同口径：微信/Telegram/Discord/飞书/QQ 双向，企微仅图片，钉钉仅接收", () => {
    expect(defaultMediaCapability("wechat")).toBe("both");
    expect(defaultMediaCapability("telegram")).toBe("both");
    expect(defaultMediaCapability("discord")).toBe("both");
    expect(defaultMediaCapability("feishu")).toBe("both");
    expect(defaultMediaCapability("qq")).toBe("both");
    expect(defaultMediaCapability("wecom")).toBe("imageOnly");
    expect(defaultMediaCapability("dingtalk")).toBe("inboundOnly");
    expect(defaultMediaCapability("nope")).toBe("none");
  });
});

describe("mediaCapabilityAllows", () => {
  it("both 全放行；imageOnly 只放图片；inboundOnly / none 一律挡下", () => {
    expect(mediaCapabilityAllows("both", "image")).toBe(true);
    expect(mediaCapabilityAllows("both", "file")).toBe(true);
    expect(mediaCapabilityAllows("imageOnly", "image")).toBe(true);
    expect(mediaCapabilityAllows("imageOnly", "file")).toBe(false);
    expect(mediaCapabilityAllows("inboundOnly", "image")).toBe(false);
    expect(mediaCapabilityAllows("inboundOnly", "file")).toBe(false);
    expect(mediaCapabilityAllows("none", "image")).toBe(false);
    expect(mediaCapabilityAllows("none", "file")).toBe(false);
  });
});

describe("channelMediaBackend", () => {
  it("能力矩阵：一条无参命令直取宿主", async () => {
    mocks.invoke.mockResolvedValueOnce({ wechat: "both", wecom: "imageOnly" });
    const caps = await channelMediaBackend.capabilities();
    expect(caps).toEqual({ wechat: "both", wecom: "imageOnly" });
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
