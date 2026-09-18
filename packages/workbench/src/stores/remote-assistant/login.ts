/**
 * 登录切片：微信的「扫码登录 → 状态长轮询」与飞书的「扫码创建应用 → 轮询到确认」。
 *
 * 两条扫描流各自用递增 epoch 作废在途轮询（取消 / 重开时旧循环自行退出）；轮询的
 * 失败计数、重试间隔为切片私有。
 *
 * 依赖 status 切片（刷新通道状态、记活动行）与 connect 切片（确认后直接连上），
 * 经 getStatus / getConnect 惰性访问。
 */
import { wechatBackend, type WechatLoginPoll } from "../../lib/wechat-backend";
import { feishuBackend, type FeishuRegisterPoll, type FeishuRegisterStart } from "../../lib/feishu-backend";
import { dingtalkBackend, type DingTalkRegisterPoll, type DingTalkRegisterStart } from "../../lib/dingtalk-backend";
import { notify } from "../notice";
import {
  delay,
  describeError,
  t,
  IDLE_DINGTALK_REGISTER,
  IDLE_FEISHU_REGISTER,
  QR_POLL_MAX_FAILURES,
  QR_POLL_MIN_INTERVAL_MS,
  QR_POLL_RETRY_MS,
} from "./shared";
import type { RemoteAssistantState } from "./state";
import type { StatusApi } from "./status";
import type { ConnectApi } from "./connect";

export interface LoginDeps {
  state: RemoteAssistantState;
  getStatus: () => StatusApi;
  getConnect: () => ConnectApi;
}

export interface LoginApi {
  startLogin(): Promise<void>;
  cancelLogin(): void;
  startFeishuRegistration(): Promise<void>;
  cancelFeishuRegistration(): void;
  startDingTalkRegistration(): Promise<void>;
  cancelDingTalkRegistration(): void;
}

export function createLoginSlice({ state, getStatus, getConnect }: LoginDeps): LoginApi {
  /* ===== 微信 · 扫码登录 ===== */

  /** 递增即作废进行中的扫码轮询（取消 / 重开后旧循环自行退出）。 */
  let loginEpoch = 0;
  let loginFailures = 0;

  async function startLogin(): Promise<void> {
    if (!state.available.value) {
      notify({ kind: "warning", key: "wechat-runtime", title: t("remoteAssist.wechat.desktopOnly") });
      return;
    }
    const epoch = ++loginEpoch;
    state.qrError.value = null;
    loginFailures = 0;
    try {
      const started = await wechatBackend.loginQr();
      if (epoch !== loginEpoch) return;
      state.qr.value = { content: started.content, phase: "wait" };
      void pollLogin(epoch);
    } catch (error) {
      if (epoch !== loginEpoch) return;
      state.qrError.value = describeError(error);
      notify({ kind: "error", key: "wechat-login", title: t("remoteAssist.wechat.loginFailed"), detail: state.qrError.value });
    }
  }

  /** 扫码状态长轮询：一次调用在宿主侧最多挂 ~35s，服务端有状态变化即提前返回。 */
  async function pollLogin(epoch: number): Promise<void> {
    while (epoch === loginEpoch && state.qr.value) {
      let result: WechatLoginPoll;
      const startedAt = Date.now();
      try {
        result = await wechatBackend.loginPoll();
        loginFailures = 0;
      } catch (error) {
        if (epoch !== loginEpoch) return;
        loginFailures += 1;
        if (loginFailures >= QR_POLL_MAX_FAILURES) {
          state.qrError.value = describeError(error);
          state.qr.value = null;
          return;
        }
        await delay(QR_POLL_RETRY_MS);
        continue;
      }
      if (epoch !== loginEpoch) return;

      if (result.status === "confirmed") {
        state.qr.value = null;
        await getStatus().refreshStatus();
        getStatus().recordActivity({
          direction: "in",
          peer: t("remoteAssist.wechat.botName"),
          channel: "wechat",
          text: t("remoteAssist.wechat.loggedIn"),
          kind: "system",
        });
        notify({ kind: "success", key: "wechat-login", title: t("remoteAssist.wechat.loginSucceeded") });
        // 扫码成功后直接连上：用户的期待就是「扫完就能用」。
        await getConnect().connect();
        return;
      }
      if (result.status === "expired") {
        if (result.qrContent) {
          // 宿主已自动换了新码：原地刷新继续等扫。
          state.qr.value = { content: result.qrContent, phase: "wait" };
          continue;
        }
        state.qr.value = null;
        state.qrError.value = result.detail ?? t("remoteAssist.wechat.qrExpired");
        return;
      }
      if (state.qr.value) state.qr.value.phase = result.status;
      // 服务端会 hold 住请求，正常情况下每轮都等满 ~30s；万一它秒回（异常网关 /
      // 宿主兜底路径），这里留出最小间隔，别把等待变成热循环。
      const elapsed = Date.now() - startedAt;
      if (elapsed < QR_POLL_MIN_INTERVAL_MS) await delay(QR_POLL_MIN_INTERVAL_MS - elapsed);
    }
  }

  function cancelLogin(): void {
    loginEpoch += 1;
    state.qr.value = null;
    state.qrError.value = null;
    if (state.available.value) void wechatBackend.loginCancel().catch(() => undefined);
  }

  /* ===== 飞书 · 扫码创建应用 ===== */

  /** 递增即作废进行中的扫码轮询（取消 / 重开时旧循环自行退出）。 */
  let registerEpoch = 0;

  /** 发起扫码创建应用：出二维码 → 轮询到确认 → 宿主落盘，这里只刷新状态并连上。 */
  async function startFeishuRegistration(): Promise<void> {
    if (!state.available.value) return;
    const epoch = ++registerEpoch;
    state.feishuRegister.value = { ...IDLE_FEISHU_REGISTER, phase: "waiting" };
    let started: FeishuRegisterStart;
    try {
      started = await feishuBackend.registerBegin();
    } catch (error) {
      if (epoch !== registerEpoch) return;
      state.feishuRegister.value = { ...IDLE_FEISHU_REGISTER, phase: "failed", detail: describeError(error) };
      return;
    }
    if (epoch !== registerEpoch) return;
    state.feishuRegister.value = { phase: "waiting", qrUrl: started.qrUrl, userCode: started.userCode, detail: null };
    void pollFeishuRegistration(epoch, Math.max(started.interval * 1000, QR_POLL_MIN_INTERVAL_MS));
  }

  /** 轮询扫码结果；宿主给的间隔会被采纳（服务端要求放慢时会变大）。 */
  async function pollFeishuRegistration(epoch: number, intervalMs: number): Promise<void> {
    let wait = intervalMs;
    let failures = 0;
    while (epoch === registerEpoch && state.feishuRegister.value.phase === "waiting") {
      await new Promise((resolve) => setTimeout(resolve, wait));
      if (epoch !== registerEpoch) return;
      let result: FeishuRegisterPoll;
      try {
        result = await feishuBackend.registerPoll();
        failures = 0;
      } catch (error) {
        if (epoch !== registerEpoch) return;
        failures += 1;
        if (failures < QR_POLL_MAX_FAILURES) continue;
        state.feishuRegister.value = { ...IDLE_FEISHU_REGISTER, phase: "failed", detail: describeError(error) };
        return;
      }
      if (epoch !== registerEpoch) return;
      if (result.intervalMs && result.intervalMs > 0) wait = Math.max(result.intervalMs, QR_POLL_MIN_INTERVAL_MS);
      if (result.state === "pending") continue;
      if (result.state === "done") {
        state.feishuRegister.value = { phase: "done", qrUrl: null, userCode: null, detail: null };
        notify({ kind: "success", key: "feishu-register", title: t("remoteAssist.feishu.registerDone") });
        await getStatus()
          .refreshFeishuStatus()
          .catch(() => undefined);
        // 与手填凭证一致：存好就顺手连上，用户不必再点一次。
        await getConnect().connectFeishu();
        return;
      }
      // 失败原因优先用服务端给的描述，没有就用本地文案。
      const fallback =
        result.state === "denied"
          ? t("remoteAssist.feishu.registerDenied")
          : result.state === "expired"
            ? t("remoteAssist.feishu.registerExpired")
            : t("remoteAssist.feishu.registerFailed");
      state.feishuRegister.value = { ...IDLE_FEISHU_REGISTER, phase: "failed", detail: result.detail ?? fallback };
      return;
    }
  }

  /** 取消扫码：作废宿主那边的 device_code，并让轮询循环退出。 */
  function cancelFeishuRegistration(): void {
    registerEpoch += 1;
    state.feishuRegister.value = { ...IDLE_FEISHU_REGISTER };
    if (!state.available.value) return;
    void feishuBackend.registerCancel().catch(() => undefined);
  }

  /* ===== 钉钉 · 扫码创建应用 ===== */

  /** 递增即作废进行中的扫码轮询（取消 / 重开时旧循环自行退出）。 */
  let dingtalkRegisterEpoch = 0;

  /** 发起扫码创建应用：出二维码 → 轮询到确认 → 宿主落盘，这里只刷新状态并连上。 */
  async function startDingTalkRegistration(): Promise<void> {
    if (!state.available.value) return;
    const epoch = ++dingtalkRegisterEpoch;
    state.dingtalkRegister.value = { ...IDLE_DINGTALK_REGISTER, phase: "waiting" };
    let started: DingTalkRegisterStart;
    try {
      started = await dingtalkBackend.registerBegin();
    } catch (error) {
      if (epoch !== dingtalkRegisterEpoch) return;
      state.dingtalkRegister.value = { ...IDLE_DINGTALK_REGISTER, phase: "failed", detail: describeError(error) };
      return;
    }
    if (epoch !== dingtalkRegisterEpoch) return;
    state.dingtalkRegister.value = {
      phase: "waiting",
      qrUrl: started.qrUrl,
      userCode: started.userCode,
      detail: null,
    };
    void pollDingTalkRegistration(epoch, Math.max(started.interval * 1000, QR_POLL_MIN_INTERVAL_MS));
  }

  /** 轮询扫码结果；间隔固定（钉钉不支持服务端要求的放慢）。 */
  async function pollDingTalkRegistration(epoch: number, intervalMs: number): Promise<void> {
    let failures = 0;
    while (epoch === dingtalkRegisterEpoch && state.dingtalkRegister.value.phase === "waiting") {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      if (epoch !== dingtalkRegisterEpoch) return;
      let result: DingTalkRegisterPoll;
      try {
        result = await dingtalkBackend.registerPoll();
        failures = 0;
      } catch (error) {
        if (epoch !== dingtalkRegisterEpoch) return;
        failures += 1;
        if (failures < QR_POLL_MAX_FAILURES) continue;
        state.dingtalkRegister.value = {
          ...IDLE_DINGTALK_REGISTER,
          phase: "failed",
          detail: describeError(error),
        };
        return;
      }
      if (epoch !== dingtalkRegisterEpoch) return;
      if (result.state === "pending") continue;
      if (result.state === "done") {
        state.dingtalkRegister.value = { phase: "done", qrUrl: null, userCode: null, detail: null };
        notify({ kind: "success", key: "dingtalk-register", title: t("remoteAssist.dingtalk.registerDone") });
        await getStatus()
          .refreshDingTalkStatus()
          .catch(() => undefined);
        // 与手填凭证一致：存好就顺手连上，用户不必再点一次。
        await getConnect().connectDingTalk();
        return;
      }
      // 失败原因优先用服务端给的描述，没有就用本地文案。钉钉没有「拒绝」这一细分状态。
      const fallback = result.state === "expired" ? t("remoteAssist.dingtalk.registerExpired") : t("remoteAssist.dingtalk.registerFailed");
      state.dingtalkRegister.value = {
        ...IDLE_DINGTALK_REGISTER,
        phase: "failed",
        detail: result.detail ?? fallback,
      };
      return;
    }
  }

  /** 取消扫码：作废宿主那边的 device_code，并让轮询循环退出。 */
  function cancelDingTalkRegistration(): void {
    dingtalkRegisterEpoch += 1;
    state.dingtalkRegister.value = { ...IDLE_DINGTALK_REGISTER };
    if (!state.available.value) return;
    void dingtalkBackend.registerCancel().catch(() => undefined);
  }

  return {
    startLogin,
    cancelLogin,
    startFeishuRegistration,
    cancelFeishuRegistration,
    startDingTalkRegistration,
    cancelDingTalkRegistration,
  };
}
