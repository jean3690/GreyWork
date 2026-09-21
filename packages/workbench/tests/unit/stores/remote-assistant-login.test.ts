// 登录切片的可观测契约：三条扫码流（微信登录 / 飞书建应用 / 钉钉建应用）的出码、
// 轮询确认 / 状态机 / 连续失败上限 / epoch 作废与取消。轮询带定时器，走 fake timers 驱动。
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { i18n } from "@/i18n";
import {
  IDLE_DINGTALK_REGISTER,
  IDLE_FEISHU_REGISTER,
  QR_POLL_MAX_FAILURES,
  QR_POLL_MIN_INTERVAL_MS,
  QR_POLL_RETRY_MS,
} from "@/stores/remote-assistant/shared";

const t = i18n.global.t;

const notices = vi.hoisted(() => ({ notify: vi.fn() }));

const backends = vi.hoisted(() => ({
  loginQr: vi.fn<() => Promise<unknown>>(() => Promise.resolve({ content: "qr://content" })),
  loginPoll: vi.fn<() => Promise<unknown>>(() => Promise.resolve({ status: "wait" })),
  loginCancel: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  feishuRegisterBegin: vi.fn<() => Promise<unknown>>(() =>
    Promise.resolve({ qrUrl: "fe://qr", userCode: "uc", expiresIn: 300, interval: 1 }),
  ),
  feishuRegisterPoll: vi.fn<() => Promise<unknown>>(() =>
    Promise.resolve({ state: "pending", detail: null, appId: null, intervalMs: null }),
  ),
  feishuRegisterCancel: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  dingtalkRegisterBegin: vi.fn<() => Promise<unknown>>(() =>
    Promise.resolve({ qrUrl: "dt://qr", userCode: "uc", expiresIn: 300, interval: 1 }),
  ),
  dingtalkRegisterPoll: vi.fn<() => Promise<unknown>>(() => Promise.resolve({ state: "pending", detail: null, clientId: null })),
  dingtalkRegisterCancel: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));

vi.mock("@/stores/notice", () => ({ notify: (input: unknown) => notices.notify(input) }));
vi.mock("@/lib/wechat-backend", () => ({
  wechatBackend: {
    loginQr: () => backends.loginQr(),
    loginPoll: () => backends.loginPoll(),
    loginCancel: () => backends.loginCancel(),
  },
}));
vi.mock("@/lib/feishu-backend", () => ({
  feishuBackend: {
    registerBegin: () => backends.feishuRegisterBegin(),
    registerPoll: () => backends.feishuRegisterPoll(),
    registerCancel: () => backends.feishuRegisterCancel(),
  },
}));
vi.mock("@/lib/dingtalk-backend", () => ({
  dingtalkBackend: {
    registerBegin: () => backends.dingtalkRegisterBegin(),
    registerPoll: () => backends.dingtalkRegisterPoll(),
    registerCancel: () => backends.dingtalkRegisterCancel(),
  },
}));

import { createLoginSlice, type LoginApi } from "@/stores/remote-assistant/login";
import type { StatusApi } from "@/stores/remote-assistant/status";
import type { ConnectApi } from "@/stores/remote-assistant/connect";
import type { RemoteAssistantState } from "@/stores/remote-assistant/state";

interface LoginHarness {
  api: LoginApi;
  available: { value: boolean };
  qr: { value: unknown };
  qrError: { value: string | null };
  feishuRegister: { value: typeof IDLE_FEISHU_REGISTER };
  dingtalkRegister: { value: typeof IDLE_DINGTALK_REGISTER };
  recordActivity: Mock<(entry: unknown) => void>;
  connect: { connect: Mock<() => Promise<void>>; connectFeishu: Mock<() => Promise<void>>; connectDingTalk: Mock<() => Promise<void>> };
  refresh: {
    refreshStatus: Mock<() => Promise<unknown>>;
    refreshFeishuStatus: Mock<() => Promise<unknown>>;
    refreshDingTalkStatus: Mock<() => Promise<unknown>>;
  };
}

function build(): LoginHarness {
  const available = { value: true };
  const qr = { value: null };
  const qrError = { value: null };
  const feishuRegister = { value: { ...IDLE_FEISHU_REGISTER } };
  const dingtalkRegister = { value: { ...IDLE_DINGTALK_REGISTER } };
  const recordActivity = vi.fn();
  const refreshStatus = vi.fn(() => Promise.resolve({}));
  const refreshFeishuStatus = vi.fn(() => Promise.resolve({}));
  const refreshDingTalkStatus = vi.fn(() => Promise.resolve({}));
  const connect = {
    connect: vi.fn(() => Promise.resolve()),
    connectFeishu: vi.fn(() => Promise.resolve()),
    connectDingTalk: vi.fn(() => Promise.resolve()),
  };
  const api = createLoginSlice({
    state: { available, qr, qrError, feishuRegister, dingtalkRegister } as unknown as RemoteAssistantState,
    getStatus: () => ({ refreshStatus, refreshFeishuStatus, refreshDingTalkStatus, recordActivity }) as unknown as StatusApi,
    getConnect: () => connect as unknown as ConnectApi,
  });
  return {
    api,
    available,
    qr,
    qrError,
    feishuRegister,
    dingtalkRegister,
    recordActivity,
    connect,
    refresh: { refreshStatus, refreshFeishuStatus, refreshDingTalkStatus },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  notices.notify.mockClear();
  for (const value of Object.values(backends)) {
    (value as Mock).mockClear();
  }
  backends.loginQr.mockImplementation(() => Promise.resolve({ content: "qr://content" }));
  backends.loginPoll.mockImplementation(() => Promise.resolve({ status: "wait" }));
  backends.feishuRegisterBegin.mockImplementation(() => Promise.resolve({ qrUrl: "fe://qr", userCode: "uc", expiresIn: 300, interval: 1 }));
  backends.feishuRegisterPoll.mockImplementation(() => Promise.resolve({ state: "pending", detail: null, appId: null, intervalMs: null }));
  backends.dingtalkRegisterBegin.mockImplementation(() =>
    Promise.resolve({ qrUrl: "dt://qr", userCode: "uc", expiresIn: 300, interval: 1 }),
  );
  backends.dingtalkRegisterPoll.mockImplementation(() => Promise.resolve({ state: "pending", detail: null, clientId: null }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("微信扫码登录", () => {
  it("浏览器态：只提示桌面专属，不碰宿主", async () => {
    const h = build();
    h.available.value = false;
    await h.api.startLogin();
    expect(backends.loginQr).not.toHaveBeenCalled();
    expect(h.qr.value).toBeNull();
    expect(notices.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "warning", key: "wechat-runtime" }));
  });

  it("出码成功：qr 进入 wait，轮询确认后清码、刷新、记活动并连上", async () => {
    const h = build();
    let resolvePoll!: (result: { status: string }) => void;
    backends.loginPoll.mockImplementation(() => new Promise((resolve) => (resolvePoll = resolve)));
    const finished = h.api.startLogin();
    await finished;
    expect(h.qr.value).toEqual({ content: "qr://content", phase: "wait" });
    resolvePoll({ status: "confirmed" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.qr.value).toBeNull();
    expect(h.refresh.refreshStatus).toHaveBeenCalled();
    expect(h.recordActivity).toHaveBeenCalledWith(expect.objectContaining({ kind: "system", text: t("remoteAssist.wechat.loggedIn") }));
    expect(h.connect.connect).toHaveBeenCalledTimes(1);
    expect(notices.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "success", key: "wechat-login" }));
  });

  it("scaned：轮询结果推进相位，随后确认收尾", async () => {
    const h = build();
    backends.loginPoll.mockResolvedValueOnce({ status: "scaned" }).mockResolvedValueOnce({ status: "confirmed" });
    await h.api.startLogin();
    await vi.advanceTimersByTimeAsync(0);
    expect((h.qr.value as { phase: string }).phase).toBe("scaned");
    await vi.advanceTimersByTimeAsync(QR_POLL_MIN_INTERVAL_MS * 3);
    expect(h.qr.value).toBeNull();
    expect(h.connect.connect).toHaveBeenCalledTimes(1);
  });

  it("expired 且带新码：原地换码继续等扫", async () => {
    const h = build();
    backends.loginPoll.mockResolvedValueOnce({ status: "expired", qrContent: "qr://new" }).mockResolvedValueOnce({ status: "confirmed" });
    await h.api.startLogin();
    await vi.advanceTimersByTimeAsync(QR_POLL_MIN_INTERVAL_MS + 10);
    expect(h.qr.value).toBeNull();
    expect(h.connect.connect).toHaveBeenCalledTimes(1);
  });

  it("expired 无新码：清码并把原因落进 qrError", async () => {
    const h = build();
    backends.loginPoll.mockResolvedValueOnce({ status: "expired", detail: "扫码超时" });
    await h.api.startLogin();
    await vi.advanceTimersByTimeAsync(QR_POLL_MIN_INTERVAL_MS + 10);
    expect(h.qr.value).toBeNull();
    expect(h.qrError.value).toBe("扫码超时");
    expect(h.connect.connect).not.toHaveBeenCalled();
  });

  it("出码失败：记录原因并提示", async () => {
    const h = build();
    backends.loginQr.mockRejectedValueOnce(new Error("宿主无响应"));
    await h.api.startLogin();
    expect(h.qrError.value).toBe("宿主无响应");
    expect(notices.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "error", key: "wechat-login" }));
  });

  it("连续失败到达上限：放弃扫码并落错误", async () => {
    const h = build();
    backends.loginPoll.mockRejectedValue(new Error("网络断"));
    await h.api.startLogin();
    for (let i = 0; i < QR_POLL_MAX_FAILURES; i += 1) {
      await vi.advanceTimersByTimeAsync(QR_POLL_RETRY_MS + 10);
    }
    expect(backends.loginPoll).toHaveBeenCalledTimes(QR_POLL_MAX_FAILURES);
    expect(h.qr.value).toBeNull();
    expect(h.qrError.value).toBe("网络断");
  });

  it("在途扫码被作废：出码晚到也不再进入轮询", async () => {
    const h = build();
    let resolveQr!: (value: { content: string }) => void;
    backends.loginQr.mockImplementation(() => new Promise<{ content: string }>((resolve) => (resolveQr = resolve)));
    const started = h.api.startLogin();
    await vi.advanceTimersByTimeAsync(0);
    h.api.cancelLogin();
    resolveQr({ content: "qr://late" });
    await started;
    expect(h.qr.value).toBeNull();
    expect(backends.loginPoll).not.toHaveBeenCalled();
  });

  it("cancelLogin：作废轮询、清空扫码视图、通知宿主取消", async () => {
    const h = build();
    await h.api.startLogin();
    h.api.cancelLogin();
    expect(backends.loginCancel).toHaveBeenCalledTimes(1);
    expect(h.qr.value).toBeNull();
    expect(h.qrError.value).toBeNull();
  });
});

describe("飞书扫码创建应用", () => {
  it("浏览器态：不发起注册", async () => {
    const h = build();
    h.available.value = false;
    await h.api.startFeishuRegistration();
    expect(backends.feishuRegisterBegin).not.toHaveBeenCalled();
  });

  it("pending → done：phase 收尾 done，刷新状态并连上", async () => {
    const h = build();
    backends.feishuRegisterPoll
      .mockResolvedValueOnce({ state: "pending", detail: null, appId: null, intervalMs: null })
      .mockResolvedValueOnce({ state: "done", detail: null, appId: "app-f", intervalMs: null });
    await h.api.startFeishuRegistration();
    expect(h.feishuRegister.value).toMatchObject({ phase: "waiting", qrUrl: "fe://qr", userCode: "uc" });
    await vi.advanceTimersByTimeAsync(QR_POLL_MIN_INTERVAL_MS * 3);
    expect(h.feishuRegister.value.phase).toBe("done");
    expect(h.refresh.refreshFeishuStatus).toHaveBeenCalled();
    expect(h.connect.connectFeishu).toHaveBeenCalledTimes(1);
    expect(notices.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "success", key: "feishu-register" }));
  });

  it("注册被拒：用服务端 detail 落 failed", async () => {
    const h = build();
    backends.feishuRegisterPoll.mockResolvedValueOnce({ state: "denied", detail: "用户拒绝", appId: null, intervalMs: null });
    await h.api.startFeishuRegistration();
    await vi.advanceTimersByTimeAsync(QR_POLL_MIN_INTERVAL_MS * 2);
    expect(h.feishuRegister.value.phase).toBe("failed");
    expect(h.feishuRegister.value.detail).toBe("用户拒绝");
  });

  it("注册过期：无 detail 时回落本地文案", async () => {
    const h = build();
    backends.feishuRegisterPoll.mockResolvedValueOnce({ state: "expired", detail: null, appId: null, intervalMs: null });
    await h.api.startFeishuRegistration();
    await vi.advanceTimersByTimeAsync(QR_POLL_MIN_INTERVAL_MS * 2);
    expect(h.feishuRegister.value.phase).toBe("failed");
    expect(h.feishuRegister.value.detail).toBe(t("remoteAssist.feishu.registerExpired"));
  });

  it("连续失败到达上限：放弃并落错误", async () => {
    const h = build();
    backends.feishuRegisterPoll.mockRejectedValue(new Error("轮询挂了"));
    await h.api.startFeishuRegistration();
    for (let i = 0; i < QR_POLL_MAX_FAILURES; i += 1) {
      await vi.advanceTimersByTimeAsync(QR_POLL_MIN_INTERVAL_MS + 10);
    }
    expect(h.feishuRegister.value.phase).toBe("failed");
    expect(h.feishuRegister.value.detail).toBe("轮询挂了");
    expect(h.connect.connectFeishu).not.toHaveBeenCalled();
  });

  it("cancelFeishuRegistration：回 idle 并作废宿主侧 device_code", async () => {
    const h = build();
    await h.api.startFeishuRegistration();
    h.api.cancelFeishuRegistration();
    expect(backends.feishuRegisterCancel).toHaveBeenCalledTimes(1);
    expect(h.feishuRegister.value).toEqual(IDLE_FEISHU_REGISTER);
  });
});

describe("钉钉扫码创建应用", () => {
  it("浏览器态：不发起注册", async () => {
    const h = build();
    h.available.value = false;
    await h.api.startDingTalkRegistration();
    expect(backends.dingtalkRegisterBegin).not.toHaveBeenCalled();
  });

  it("pending → done：phase 收尾 done，刷新状态并连上", async () => {
    const h = build();
    backends.dingtalkRegisterPoll
      .mockResolvedValueOnce({ state: "pending", detail: null, clientId: null })
      .mockResolvedValueOnce({ state: "done", detail: null, clientId: "cli-d" });
    await h.api.startDingTalkRegistration();
    expect(h.dingtalkRegister.value).toMatchObject({ phase: "waiting", qrUrl: "dt://qr", userCode: "uc" });
    await vi.advanceTimersByTimeAsync(QR_POLL_MIN_INTERVAL_MS * 3);
    expect(h.dingtalkRegister.value.phase).toBe("done");
    expect(h.refresh.refreshDingTalkStatus).toHaveBeenCalled();
    expect(h.connect.connectDingTalk).toHaveBeenCalledTimes(1);
    expect(notices.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "success", key: "dingtalk-register" }));
  });

  it("注册过期：无 detail 时回落本地文案（钉钉没有拒绝细分态）", async () => {
    const h = build();
    backends.dingtalkRegisterPoll.mockResolvedValueOnce({ state: "expired", detail: null, clientId: null });
    await h.api.startDingTalkRegistration();
    await vi.advanceTimersByTimeAsync(QR_POLL_MIN_INTERVAL_MS * 2);
    expect(h.dingtalkRegister.value.phase).toBe("failed");
    expect(h.dingtalkRegister.value.detail).toBe(t("remoteAssist.dingtalk.registerExpired"));
  });

  it("cancelDingTalkRegistration：回 idle 并作废宿主侧 device_code", async () => {
    const h = build();
    await h.api.startDingTalkRegistration();
    h.api.cancelDingTalkRegistration();
    expect(backends.dingtalkRegisterCancel).toHaveBeenCalledTimes(1);
    expect(h.dingtalkRegister.value).toEqual(IDLE_DINGTALK_REGISTER);
  });
});
