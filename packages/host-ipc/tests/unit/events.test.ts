import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GreyworkCore from "@greywork/core";

const mocks = vi.hoisted(() => ({
  isTauriRuntime: vi.fn<() => boolean>(() => false),
  tauriListen: vi.fn(),
}));

vi.mock("@greywork/core", async (importOriginal) => ({
  ...(await importOriginal<typeof GreyworkCore>()),
  isTauriRuntime: mocks.isTauriRuntime,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.tauriListen }));

const OVERRIDE_KEY = "__GREYWORK_RUNTIME__";

/** 最小 WebSocket 替身：只实现门面用到的 addEventListener / close。 */
class FakeSocket {
  static instances: FakeSocket[] = [];
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set<(event: unknown) => void>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  /** 触发一次事件（close 会通知监听者，与浏览器语义一致）。 */
  emit(type: string, event: unknown = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  close(): void {
    this.closed = true;
    this.emit("close");
  }

  /** 投递一帧服务端消息。 */
  frame(event: string, payload: unknown): void {
    this.emit("message", { data: JSON.stringify({ event, payload }) });
  }
}

async function freshBarrel() {
  vi.resetModules();
  return import("../../src/index");
}

function stubWindow(override?: string): void {
  vi.stubGlobal("window", override === undefined ? {} : { [OVERRIDE_KEY]: override });
}

function stubLocation(): void {
  vi.stubGlobal("location", { protocol: "http:", host: "localhost:3000" });
}

/** 建好「服务端模式 + 可观测 WebSocket」的前置，返回门面。 */
async function serverBarrel() {
  stubWindow("server");
  stubLocation();
  vi.stubGlobal("WebSocket", FakeSocket);
  return freshBarrel();
}

beforeEach(() => {
  FakeSocket.instances = [];
  mocks.isTauriRuntime.mockReturnValue(false);
  mocks.tauriListen.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("listen —— desktop", () => {
  it("直通 Tauri listen，参数逐字一致，解绑转发", async () => {
    mocks.isTauriRuntime.mockReturnValue(true);
    const unlisten = vi.fn();
    mocks.tauriListen.mockResolvedValue(unlisten);
    stubWindow();
    const { listen } = await freshBarrel();

    const handler = vi.fn();
    const stop = await listen("acp://event", handler);

    expect(mocks.tauriListen).toHaveBeenCalledWith("acp://event", handler);
    stop();
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(FakeSocket.instances).toHaveLength(0);
  });
});

describe("listen —— browser-preview", () => {
  it("抛 HostUnavailableError 且不建连（与 invoke 一致，不静默降级）", async () => {
    stubWindow();
    const { listen, HostUnavailableError } = await freshBarrel();

    await expect(listen("acp://event", vi.fn())).rejects.toBeInstanceOf(HostUnavailableError);
    expect(FakeSocket.instances).toHaveLength(0);
  });
});

describe("listen —— server", () => {
  it("共用一条连接、按事件名多路分发、投递 { payload }", async () => {
    const { listen } = await serverBarrel();

    const acp = vi.fn();
    const llm = vi.fn();
    const stopAcp = await listen("acp://event", acp);
    const stopLlm = await listen("llm://event", llm);

    expect(FakeSocket.instances).toHaveLength(1);
    const socket = FakeSocket.instances[0];
    expect(socket.url).toBe("ws://localhost:3000/api/events");

    socket.frame("acp://event", { kind: "permission-request" });
    expect(acp).toHaveBeenCalledWith({ payload: { kind: "permission-request" } });
    expect(llm).not.toHaveBeenCalled();

    socket.frame("llm://event", { kind: "delta" });
    expect(llm).toHaveBeenCalledWith({ payload: { kind: "delta" } });

    stopAcp();
    stopLlm();
  });

  it("最后一个订阅者退订即拆连接", async () => {
    const { listen } = await serverBarrel();

    const stopA = await listen("a://x", vi.fn());
    const stopB = await listen("b://x", vi.fn());
    const socket = FakeSocket.instances[0];

    stopA();
    expect(socket.closed).toBe(false);
    stopB();
    expect(socket.closed).toBe(true);
  });

  it("非法帧、缺 event 字段、未订阅事件、非字符串帧都被忽略", async () => {
    const { listen } = await serverBarrel();

    const handler = vi.fn();
    const stop = await listen("acp://event", handler);
    const socket = FakeSocket.instances[0];

    socket.emit("message", { data: "not json" });
    socket.emit("message", { data: JSON.stringify({ payload: 1 }) });
    socket.emit("message", { data: JSON.stringify({ event: "other://x", payload: 1 }) });
    socket.emit("message", { data: 42 });

    expect(handler).not.toHaveBeenCalled();
    stop();
  });

  it("单个处理器抛错不影响其余处理器", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { listen } = await serverBarrel();

    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    const stopBad = await listen("acp://event", bad);
    const stopGood = await listen("acp://event", good);

    FakeSocket.instances[0].frame("acp://event", { n: 1 });

    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledWith({ payload: { n: 1 } });
    expect(consoleError).toHaveBeenCalled();

    stopBad();
    stopGood();
    consoleError.mockRestore();
  });

  it("断线后退避重连，重连后重新收到 host://hello", async () => {
    vi.useFakeTimers();
    const { listen, HOST_HELLO_EVENT } = await serverBarrel();

    const hello = vi.fn();
    const stop = await listen(HOST_HELLO_EVENT, hello);

    const first = FakeSocket.instances[0];
    first.emit("open");
    first.emit("close");
    expect(FakeSocket.instances).toHaveLength(1); // 退避期内不立刻重连

    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.instances).toHaveLength(2);

    FakeSocket.instances[1].frame(HOST_HELLO_EVENT, { version: "0.3.0" });
    expect(hello).toHaveBeenCalledWith({ payload: { version: "0.3.0" } });

    stop();
  });

  it("退避期内新增订阅立即建连，且重连定时器不叠加", async () => {
    vi.useFakeTimers();
    const { listen } = await serverBarrel();

    const stopA = await listen("a://x", vi.fn());
    FakeSocket.instances[0].emit("close"); // 连接断开，退避定时器已挂

    const stopB = await listen("b://x", vi.fn()); // 新订阅立刻建连
    expect(FakeSocket.instances).toHaveLength(2);

    FakeSocket.instances[1].emit("close"); // 已有定时器在跑 → 不叠加
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.instances).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeSocket.instances).toHaveLength(3);

    stopA();
    stopB();
  });

  it("退避期内最后一个订阅者退订会取消待执行的重连", async () => {
    vi.useFakeTimers();
    const { listen } = await serverBarrel();

    const stop = await listen("a://x", vi.fn());
    FakeSocket.instances[0].emit("close"); // 退避定时器已挂
    stop(); // 最后一个订阅者退订

    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("没有 location / WebSocket 时不建连也不抛错", async () => {
    stubWindow("server");
    const { listen } = await freshBarrel();

    const stop = await listen("a://x", vi.fn());
    expect(FakeSocket.instances).toHaveLength(0);
    stop();
  });
});
