// 微信通道 IPC 封装的契约：命令名与参数形状必须与 `wechat.rs` 的 `#[tauri::command]` 对齐。
// 名字或字段错一个字符，界面上就是「点了没反应」——这里把它们钉住。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as GreyworkCore from "@greywork/core";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args?: Record<string, unknown>) => ({})),
  listen: vi.fn(async (_event: string, _handler: (event: { payload: unknown }) => void) => () => {}),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@greywork/core", async (importOriginal) => ({
  ...(await importOriginal<typeof GreyworkCore>()),
  isTauriRuntime: () => true,
}));

import { WECHAT_INBOUND_EVENT, WECHAT_STATE_EVENT, wechatBackend } from "@/lib/wechat-backend";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("wechatBackend", () => {
  it("supported 跟随运行环境", () => {
    expect(wechatBackend.supported()).toBe(true);
  });

  it("状态 / 扫码三件套：命令名与宿主注册名一致", async () => {
    await wechatBackend.status();
    await wechatBackend.loginQr();
    await wechatBackend.loginPoll();
    await wechatBackend.loginCancel();
    expect(mocks.invoke.mock.calls.map((call) => call[0])).toEqual([
      "wechat_status",
      "wechat_login_qr",
      "wechat_login_poll",
      "wechat_login_cancel",
    ]);
  });

  it("连接 / 断开 / 退出：发送者策略随连接下发", async () => {
    await wechatBackend.connect(true);
    await wechatBackend.disconnect();
    await wechatBackend.logout();
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "wechat_connect", { allowOtherSenders: true });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "wechat_disconnect");
    expect(mocks.invoke).toHaveBeenNthCalledWith(3, "wechat_logout");
  });

  it("回消息必须带上 contextToken（协议里关联会话的唯一凭据）", async () => {
    await wechatBackend.send("peer@im.wechat", "ctx-1", "收到");
    expect(mocks.invoke).toHaveBeenCalledWith("wechat_send", {
      toUserId: "peer@im.wechat",
      contextToken: "ctx-1",
      text: "收到",
    });
  });

  it("输入状态：typing 开关映射为 status 字段", async () => {
    await wechatBackend.sendTyping("peer@im.wechat", "ctx-1", false);
    expect(mocks.invoke).toHaveBeenCalledWith("wechat_send_typing", {
      toUserId: "peer@im.wechat",
      contextToken: "ctx-1",
      typing: false,
    });
  });

  it("事件订阅：监听宿主那两个事件名并把载荷交给回调", async () => {
    const onState = vi.fn();
    const onInbound = vi.fn();
    const offState = await wechatBackend.onState(onState);
    const offInbound = await wechatBackend.onInbound(onInbound);
    expect(mocks.listen.mock.calls.map((call) => call[0])).toEqual([WECHAT_STATE_EVENT, WECHAT_INBOUND_EVENT]);
    expect(WECHAT_STATE_EVENT).toBe("wechat://state");
    expect(WECHAT_INBOUND_EVENT).toBe("wechat://inbound");

    // 宿主推事件 → 回调拿到 payload
    const stateHandler = mocks.listen.mock.calls[0][1];
    const inboundHandler = mocks.listen.mock.calls[1][1];
    stateHandler({ payload: { state: "connected" } });
    inboundHandler({ payload: { text: "在吗" } });
    expect(onState).toHaveBeenCalledWith({ state: "connected" });
    expect(onInbound).toHaveBeenCalledWith({ text: "在吗" });

    expect(typeof offState).toBe("function");
    offState();
    offInbound();
  });
});
