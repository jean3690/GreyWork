/**
 * 控制面（back/grey Java）客户端与云端自动化任务消费。
 *
 * 桌面端与控制面的联动都收口在这一层：
 * - 配置落 `<dataDir>/control-plane.json`（0600，与通道凭据同规格）；
 *   `GREYWORK_CONTROL_URL` + `GREYWORK_CONTROL_TOKEN` 同时给出时以环境变量为准
 *   （headless / Docker 不需要 UI 也能接入）；
 * - 心跳与认领各跑一条定时链：单条任务可能执行到分钟级，心跳必须独立维持，
 *   否则控制面 90s TTL 会把宿主判离线；
 * - 无人值守执行 = **本机模型直连单轮**，不碰 ACP / 工具 / 权限面（没人在场，没有裁决方）。
 *   绑定 ACP 后端的任务直接回执 failed，等应用内执行 —— 与本地兜底执行同一套语义。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Db } from "./db.js";
import { authHeaders, endpointUrl, resolveApiKey, truncate } from "./llm.js";
import { validateCloudRequest } from "./cloud.js";

/** 心跳/认领 tick 间隔（秒）。 */
export const DEFAULT_TICK_SECS = 30;
/** 每轮最多认领数：执行是串行的，多认只会把租约拖到超时。 */
export const MAX_CLAIM_PER_TICK = 1;
/** 单条执行上限（秒）：默认 25min，给控制面 30min 认领租约留回收缓冲。 */
export const DEFAULT_TIMEOUT_SECS = 1500;

const CONFIG_FILE = "control-plane.json";

/** 落在数据目录里的接入信息；token 永不回给渲染端。 */
export interface StoredControlPlane {
  baseUrl: string;
  token: string;
  email: string | null;
  deviceId: string | number | null;
  linkedAt: number | null;
}

export interface ControlPlaneStatus {
  configured: boolean;
  /** env = 环境变量接管（此时 clear 无效）；file = 应用设置里配的。 */
  source: "env" | "file" | null;
  baseUrl: string | null;
  email: string | null;
  registered: boolean;
  tickSecs: number;
  lastHeartbeatAt: number | null;
  lastClaimAt: number | null;
  lastError: string | null;
  lastOutcome: { name: string; ok: boolean; detail: string } | null;
}

/** Java /api/auth/me 的公开身份；不包含 token。用户 ID 是字符串，避免 Long 精度丢失。 */
export interface ControlPlaneSession {
  user: { id: string; email: string; displayName: string | null; role: string };
  device: { id: string | number; name: string; platform: string };
}

export interface ControlPlaneAccount {
  status: ControlPlaneStatus;
  session: ControlPlaneSession | null;
  error: string | null;
  devices?: ControlPlaneDevice[];
}

export interface ControlPlaneDevice {
  id: string;
  name: string;
  platform: string;
  lastSeenAt: string | null;
  createdAt: string | null;
  current: boolean;
}

/** 控制面 DueView（camelCase，与 Java 的 record 对齐）。 */
export interface ControlDue {
  id: string | number;
  taskId: string;
  name: string;
  target: string;
  intent: string;
  acpProviderId: string | null;
  model: string | null;
  dueAt: string | null;
}

/** 控制面调用的统一错误：消息直接给用户看（含状态码与可操作提示）。 */
export class ControlPlaneError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** 仅宿主内部使用的云端操作上下文：多步操作固定凭据，换号/断开时统一取消。 */
export interface CloudConnection {
  readonly signal: AbortSignal;
  request(method: string, pathname: string, body?: unknown): Promise<unknown>;
  /** 已发放票据的失败清理固定使用原会话，不跟随新账号，也不复用已取消的信号。 */
  cleanupUpload(objectId: string): Promise<void>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function filePath(dataDir: string): string {
  return path.join(dataDir, CONFIG_FILE);
}

function readStored(dataDir: string): StoredControlPlane | null {
  const file = filePath(dataDir);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<StoredControlPlane>;
    if (typeof parsed.baseUrl !== "string" || typeof parsed.token !== "string") return null;
    return {
      baseUrl: parsed.baseUrl,
      token: parsed.token,
      email: typeof parsed.email === "string" ? parsed.email : null,
      deviceId: typeof parsed.deviceId === "string" || typeof parsed.deviceId === "number" ? parsed.deviceId : null,
      linkedAt: typeof parsed.linkedAt === "number" ? parsed.linkedAt : null,
    };
  } catch {
    return null;
  }
}

function writeStored(dataDir: string, value: StoredControlPlane): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(filePath(dataDir), JSON.stringify(value), { mode: 0o600 });
}

/**
 * 环境变量接管（与 Rust 时代同名同义）：URL + TOKEN 都给了才生效，
 * 否则回落到文件配置。tick / 超时只影响节奏，不参与「是否启用」的判定。
 */
function envOverride(): { baseUrl: string; token: string } | null {
  const url = (process.env.GREYWORK_CONTROL_URL ?? "").trim();
  const token = (process.env.GREYWORK_CONTROL_TOKEN ?? "").trim();
  if (url === "" || token === "") return null;
  return { baseUrl: stripSlash(url), token };
}

function envNumber(name: string, fallback: number, min: number): number {
  const raw = (process.env[name] ?? "").trim();
  const value = Number(raw);
  return Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;
}

function stripSlash(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** 只接受 http(s)，并顺手去掉结尾斜杠（拼接路径时不再做判断）。 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ControlPlaneError("控制面地址不是合法 URL（例：http://192.168.1.10:8080）");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ControlPlaneError("控制面地址只支持 http/https");
  }
  return stripSlash(trimmed);
}

function describeFailure(status: number, action: string, body: string): string {
  const hint =
    status === 401
      ? "（登录态失效：请重新用入场码接入，或更新 GREYWORK_CONTROL_TOKEN）"
      : status === 404
        ? "（设备或任务不存在，可能已被吊销/回收）"
        : status === 409
          ? "（任务已被其他宿主认领或状态已变化）"
          : "";
  let detail = body.trim();
  try {
    const parsed = JSON.parse(detail) as { message?: unknown };
    if (typeof parsed.message === "string" && parsed.message !== "") detail = parsed.message;
  } catch {
    // 不是 JSON 就保留原文
  }
  return `${action} 失败：HTTP ${status}${hint}${detail === "" ? "" : " " + truncate(detail, 200)}`;
}

export interface EnrollInput {
  code: string;
  email: string;
  displayName?: string;
  deviceName?: string;
  platform?: string;
}

/** 控制面 HTTP 客户端；所有失败都抛 ControlPlaneError（消息可直接展示）。 */
export class ControlPlaneClient {
  constructor(
    readonly baseUrl: string,
    private readonly token: string,
  ) {}

  /** 入场码换取登录态：桌面端第一次接入控制面走这条。 */
  static async enroll(baseUrl: string, input: EnrollInput): Promise<{ token: string; email: string; deviceId: string | number | null }> {
    const body = {
      code: input.code.trim(),
      email: input.email.trim(),
      ...(input.displayName?.trim() ? { displayName: input.displayName.trim() } : {}),
      deviceName: input.deviceName?.trim() || "GreyWork 桌面端",
      platform: input.platform?.trim() || "desktop",
    };
    let response: Response;
    try {
      response = await fetch(stripSlash(baseUrl) + "/api/auth/enroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new ControlPlaneError("连不上控制面：" + message(error));
    }
    const text = await response.text();
    if (!response.ok) {
      // 入场码的 401 是「码不对」，不是「登录态失效」，这里必须给对提示。
      if (response.status === 401) {
        throw new ControlPlaneError("入场码无效或已过期（可能已被使用，或未在运维台签发）");
      }
      throw new ControlPlaneError(describeFailure(response.status, "入场码登录", text));
    }
    const parsed = JSON.parse(text) as {
      token?: unknown;
      user?: { email?: unknown };
      device?: { id?: unknown };
    };
    if (typeof parsed.token !== "string" || parsed.token === "") {
      throw new ControlPlaneError("控制面返回的登录结果里没有 token");
    }
    return {
      token: parsed.token,
      email: typeof parsed.user?.email === "string" ? parsed.user.email : body.email,
      deviceId: typeof parsed.device?.id === "string" || typeof parsed.device?.id === "number" ? parsed.device.id : null,
    };
  }

  private async call(method: string, pathname: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { authorization: "Bearer " + this.token };
    if (body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await fetch(this.baseUrl + pathname, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new ControlPlaneError(pathname + " 请求失败：" + message(error));
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ControlPlaneError(describeFailure(response.status, pathname, text), response.status);
    }
    return response;
  }

  async cloudRequest(method: string, pathname: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    validateCloudRequest(method, pathname);
    const response = await this.call(method, pathname, body, signal);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async notifications(signal: AbortSignal, wake: () => void): Promise<void> {
    const response = await fetch(this.baseUrl + "/api/hosts/me/automation/events", {
      headers: { authorization: "Bearer " + this.token, accept: "text/event-stream" },
      signal,
    });
    if (!response.ok || !response.body) throw new ControlPlaneError("云端通知连接失败", response.status);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        pending += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline).trim();
          pending = pending.slice(newline + 1);
          if (line === "event:due" || line === "event: due" || line === "event:ready" || line === "event: ready") wake();
        }
        if (pending.length > 8192) throw new ControlPlaneError("云端通知帧过大");
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  async me(): Promise<ControlPlaneSession> {
    const response = await this.call("GET", "/api/auth/me");
    const value = (await response.json()) as Partial<ControlPlaneSession>;
    if (
      !value.user ||
      typeof value.user.id !== "string" ||
      typeof value.user.email !== "string" ||
      typeof value.user.role !== "string" ||
      !value.device ||
      !["string", "number"].includes(typeof value.device.id) ||
      typeof value.device.name !== "string" ||
      typeof value.device.platform !== "string"
    ) {
      throw new ControlPlaneError("控制面返回的用户或设备信息不完整，请检查后端版本");
    }
    // 只转发公开字段，不能把后端响应里的额外凭据带到渲染端。
    return {
      user: {
        id: value.user.id,
        email: value.user.email,
        displayName: typeof value.user.displayName === "string" ? value.user.displayName : null,
        role: value.user.role,
      },
      device: { id: value.device.id, name: value.device.name, platform: value.device.platform },
    };
  }

  async logout(): Promise<void> {
    await this.call("POST", "/api/auth/logout");
  }

  async updateProfile(displayName: string): Promise<void> {
    await this.call("PATCH", "/api/auth/me", { displayName });
  }

  async devices(): Promise<ControlPlaneDevice[]> {
    const payload: unknown = await (await this.call("GET", "/api/devices")).json();
    if (!Array.isArray(payload)) throw new ControlPlaneError("控制面返回的设备列表不完整");
    return payload.map((item: Partial<ControlPlaneDevice>) => {
      if (
        !item ||
        typeof item.id !== "string" ||
        !/^\d+$/.test(item.id) ||
        typeof item.name !== "string" ||
        typeof item.platform !== "string" ||
        typeof item.current !== "boolean"
      ) {
        throw new ControlPlaneError("控制面返回的设备信息不完整，请更新后端版本");
      }
      return {
        id: item.id,
        name: item.name,
        platform: item.platform,
        current: item.current,
        lastSeenAt: typeof item.lastSeenAt === "string" ? item.lastSeenAt : null,
        createdAt: typeof item.createdAt === "string" ? item.createdAt : null,
      };
    });
  }

  async revokeDevice(id: string): Promise<void> {
    await this.call("DELETE", `/api/devices/${encodeURIComponent(id)}`);
  }

  async revokeOtherSessions(): Promise<void> {
    await this.call("DELETE", "/api/auth/sessions?includeCurrent=false");
  }

  /** 注册/更新当前设备为宿主（按设备 upsert）。 */
  async register(name: string, version: string, capabilities: string[] = []): Promise<void> {
    await this.call("PUT", "/api/hosts/me", { name, version, capabilities });
  }

  async heartbeat(): Promise<void> {
    await this.call("POST", "/api/hosts/me/heartbeat");
  }

  /** 认领到期任务；认领即租约生效，必须回执 finish 才能释放。 */
  async claim(limit: number): Promise<ControlDue[]> {
    const response = await this.call("POST", "/api/hosts/me/automation/claim", { limit });
    const payload = (await response.json()) as ControlDue[];
    return Array.isArray(payload) ? payload : [];
  }

  async finish(
    dueId: string | number,
    input: { status: "ok" | "failed"; detail: string; sessionId: string | null; output: string | null },
  ): Promise<void> {
    await this.call("POST", `/api/hosts/me/automation/due/${dueId}/finish`, input);
  }
}

/** 宿主执行侧用的模型供应商（设置快照里 modelProviders 的最小形状）。 */
interface ProviderSnapshot {
  id: string;
  name?: string;
  kind?: string;
  baseUrl?: string;
  model?: string;
  apiKeyEnv?: string;
  enabled?: boolean;
  temperature?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  reasoningEffort?: string;
}

interface Outcome {
  name: string;
  ok: boolean;
  detail: string;
  output?: string;
}

function normalizeContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "",
      )
      .join("");
  }
  return "";
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done(): void {
      signal.removeEventListener("abort", onAbort);
      clearTimeout(timer);
      resolve();
    }
    function onAbort(): void {
      done();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 控制面接入运行时：持有配置、定时链与最近状态。
 *
 * 生命周期是「configure/start → 心跳 + 认领两条链 → stop/clear」；
 * 渲染端只通过三条命令看状态、改配置、手动跑一轮，不接触 token。
 */
export class ControlPlaneRuntime {
  private stored: StoredControlPlane | null = null;
  private client: ControlPlaneClient | null = null;
  private controller: AbortController | null = null;
  private registered = false;
  private lastHeartbeatAt: number | null = null;
  private lastClaimAt: number | null = null;
  private lastError: string | null = null;
  private lastOutcome: ControlPlaneStatus["lastOutcome"] = null;
  private readonly tickSecs: number;
  private readonly timeoutSecs: number;
  private claiming = false;
  private readonly cloudOperations = new Set<AbortController>();

  constructor(
    private readonly options: {
      dataDir: string;
      version: string;
      db: Db;
      /** 测试注入：覆盖 tick / 单条执行超时（秒）。 */
      tickSecs?: number;
      timeoutSecs?: number;
      /** 运行时给宿主起的显示名（控制面宿主列表里看得到）。 */
      name?: string;
    },
  ) {
    this.tickSecs = options.tickSecs ?? envNumber("GREYWORK_CONTROL_TICK_SECS", DEFAULT_TICK_SECS, 1);
    this.timeoutSecs = options.timeoutSecs ?? envNumber("GREYWORK_CONTROL_TIMEOUT_SECS", DEFAULT_TIMEOUT_SECS, 5);
    this.stored = envOverride() ? null : readStored(options.dataDir);
  }

  private get name(): string {
    return this.options.name?.trim() || "greywork-host";
  }

  /** 当前生效的接入信息：env 优先于文件。 */
  private active(): { baseUrl: string; token: string; email: string | null; source: "env" | "file" } | null {
    const env = envOverride();
    if (env) return { baseUrl: env.baseUrl, token: env.token, email: null, source: "env" };
    if (this.stored) {
      return { baseUrl: this.stored.baseUrl, token: this.stored.token, email: this.stored.email, source: "file" };
    }
    return null;
  }

  status(): ControlPlaneStatus {
    const active = this.active();
    return {
      configured: active !== null,
      source: active?.source ?? null,
      baseUrl: active?.baseUrl ?? null,
      email: active?.email ?? null,
      registered: this.registered,
      tickSecs: this.tickSecs,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastClaimAt: this.lastClaimAt,
      lastError: this.lastError,
      lastOutcome: this.lastOutcome,
    };
  }

  async cloudRequest(method: string, pathname: string, body?: unknown): Promise<unknown> {
    return this.withCloudConnection((connection) => connection.request(method, pathname, body));
  }

  async withCloudConnection<T>(run: (connection: CloudConnection) => Promise<T>): Promise<T> {
    const active = this.active();
    if (!active) throw new ControlPlaneError("请先登录服务器账号");
    const client = new ControlPlaneClient(active.baseUrl, active.token);
    const controller = new AbortController();
    const changed = (): ControlPlaneError => new ControlPlaneError("账号连接已改变，云端操作已停止，请重试");
    const assertCurrent = (): void => {
      if (controller.signal.aborted || this.active()?.token !== active.token || this.active()?.baseUrl !== active.baseUrl) throw changed();
    };
    const connection: CloudConnection = {
      signal: controller.signal,
      request: async (method, pathname, body) => {
        assertCurrent();
        const result = await client.cloudRequest(method, pathname, body, controller.signal);
        assertCurrent();
        return result;
      },
      cleanupUpload: async (objectId) => {
        await client.cloudRequest("DELETE", `/api/storage/objects/${objectId}`);
      },
    };
    this.cloudOperations.add(controller);
    try {
      const result = await run(connection);
      assertCurrent();
      return result;
    } catch (error) {
      if (controller.signal.aborted) throw changed();
      throw error;
    } finally {
      this.cloudOperations.delete(controller);
    }
  }

  /** 身份每次向 Java 核验：不能把「有配置」或「宿主在线」误当成用户已登录。 */
  async account(): Promise<ControlPlaneAccount> {
    const active = this.active();
    if (!active) return { status: this.status(), session: null, error: null };
    try {
      const session = await new ControlPlaneClient(active.baseUrl, active.token).me();
      if (this.active()?.token !== active.token || this.active()?.baseUrl !== active.baseUrl) {
        return { status: this.status(), session: null, error: null };
      }
      return { status: this.status(), session, error: null };
    } catch (error) {
      if (this.active()?.token !== active.token || this.active()?.baseUrl !== active.baseUrl) {
        return { status: this.status(), session: null, error: null };
      }
      if (error instanceof ControlPlaneError && error.status === 401) this.stop();
      return { status: this.status(), session: null, error: message(error) };
    }
  }

  /** 账号管理固定走白名单操作，凭据及后端额外字段均不出宿主。 */
  async manageAccount(action: "devices" | "profile" | "revokeDevice" | "revokeOthers", value?: string): Promise<ControlPlaneAccount> {
    const active = this.active();
    if (!active) throw new ControlPlaneError("请先登录服务器账号");
    if (action !== "devices" && active.source === "env") throw new ControlPlaneError("当前账号由环境变量管理，不能从界面修改");
    const unchanged = (): boolean => this.active()?.token === active.token && this.active()?.baseUrl === active.baseUrl;
    const client = new ControlPlaneClient(active.baseUrl, active.token);
    let session: ControlPlaneSession | null = null;
    try {
      session = await client.me();
      if (!unchanged()) throw new ControlPlaneError("账号已切换，请重试");
      if (action === "profile") {
        const name = value?.trim() ?? "";
        if (!name || name.length > 128) throw new ControlPlaneError("显示名称须为 1 至 128 个字符");
        await client.updateProfile(name);
        session = await client.me();
        if (!unchanged()) throw new ControlPlaneError("账号已切换，请重试");
        return { status: this.status(), session, error: null };
      } else if (action === "revokeDevice") {
        if (!value || !/^[1-9]\d{0,18}$/.test(value)) throw new ControlPlaneError("设备 ID 无效");
        if (value === String(session.device.id)) throw new ControlPlaneError("请使用退出服务器账号来退出当前设备");
        await client.revokeDevice(value);
      } else if (action === "revokeOthers") {
        await client.revokeOtherSessions();
      }
      const devices = await client.devices();
      if (!unchanged()) throw new ControlPlaneError("账号已切换，请重试");
      return { status: this.status(), session, devices, error: null };
    } catch (error) {
      if (!unchanged()) return { status: this.status(), session: null, error: "账号已切换，请重试" };
      if (error instanceof ControlPlaneError && error.status === 401) {
        this.stop();
        session = null;
      }
      return { status: this.status(), session, error: message(error) };
    }
  }

  /** 先撤销 Java 会话，再删除本机凭据。网络失败不伪装成已登出，401 则可安全清理。 */
  async logout(): Promise<ControlPlaneStatus> {
    if (envOverride()) {
      throw new ControlPlaneError("当前账号由环境变量管理：请移除 GREYWORK_CONTROL_URL / GREYWORK_CONTROL_TOKEN 后重启");
    }
    const active = this.active();
    if (!active) return this.clear();
    try {
      await new ControlPlaneClient(active.baseUrl, active.token).logout();
    } catch (error) {
      if (!(error instanceof ControlPlaneError && error.status === 401)) throw error;
    }
    if (this.active()?.token !== active.token || this.active()?.baseUrl !== active.baseUrl) {
      throw new ControlPlaneError("账号已切换，请重新确认要退出的账号");
    }
    return this.clear();
  }

  /** 进程启动时调用：有配置就直接开始心跳（失败按 tick 重试，不阻塞启动）。 */
  start(): void {
    const active = this.active();
    if (!active) {
      console.log("[control-plane] 未配置控制面（设置 → 控制面，或 GREYWORK_CONTROL_URL + TOKEN）");
      return;
    }
    this.client = new ControlPlaneClient(active.baseUrl, active.token);
    console.log(`[control-plane] 接入 ${active.baseUrl}（tick ${this.tickSecs}s，来源 ${active.source}）`);
    this.startLoops();
  }

  stop(): void {
    for (const operation of this.cloudOperations) operation.abort();
    this.controller?.abort();
    this.controller = null;
    this.client = null;
    this.registered = false;
  }

  clear(): ControlPlaneStatus {
    if (envOverride()) {
      throw new ControlPlaneError("当前控制面配置来自环境变量：请改 GREYWORK_CONTROL_URL / GREYWORK_CONTROL_TOKEN 后重启");
    }
    this.stop();
    rmSync(filePath(this.options.dataDir), { force: true });
    this.stored = null;
    this.lastError = null;
    this.lastOutcome = null;
    this.lastHeartbeatAt = null;
    this.lastClaimAt = null;
    return this.status();
  }

  /**
   * 保存接入配置：给 token 直接用，给 email + 入场码则先换 token。
   * 保存后立刻注册一次，把「连没连上」当场返回给界面，而不是让用户等心跳。
   */
  async configure(input: {
    baseUrl: string;
    token?: string;
    email?: string;
    code?: string;
    displayName?: string;
    deviceName?: string;
  }): Promise<ControlPlaneStatus> {
    if (envOverride()) {
      throw new ControlPlaneError("当前控制面配置来自环境变量：请改 GREYWORK_CONTROL_URL / GREYWORK_CONTROL_TOKEN 后重启");
    }
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    let token = (input.token ?? "").trim();
    let email = (input.email ?? "").trim() || null;
    let deviceId: string | number | null = null;
    if (token === "") {
      const code = (input.code ?? "").trim();
      if (code === "" || email === null) {
        throw new ControlPlaneError("缺少凭据：填登录 token，或填邮箱 + 入场码");
      }
      const session = await ControlPlaneClient.enroll(baseUrl, {
        code,
        email,
        displayName: input.displayName,
        deviceName: input.deviceName,
      });
      token = session.token;
      email = session.email;
      deviceId = session.deviceId;
    }
    this.stop();
    this.stored = { baseUrl, token, email, deviceId, linkedAt: Date.now() };
    writeStored(this.options.dataDir, this.stored);
    this.client = new ControlPlaneClient(baseUrl, token);
    this.registered = false;
    this.lastError = null;
    try {
      await this.connectOnce();
    } catch (error) {
      // 配置已经落盘：注册失败只记错误，下个 tick 自动重试，不让用户重填。
      this.lastError = message(error);
    }
    this.startLoops();
    return this.status();
  }

  /** 注册 + 心跳一次；成功后 registered 为真。 */
  async connectOnce(): Promise<void> {
    const client = this.client;
    if (!client) throw new ControlPlaneError("控制面未配置");
    await client.register(this.name, this.options.version, []);
    await client.heartbeat();
    if (this.client !== client) return;
    this.registered = true;
    this.lastHeartbeatAt = Date.now();
    this.lastError = null;
  }

  /** 手动跑一轮（认领 → 执行 → 回执）；界面上的「立即同步」与联调都用它。 */
  async runOnce(limit = MAX_CLAIM_PER_TICK): Promise<{ status: ControlPlaneStatus; outcomes: Outcome[] }> {
    if (!this.client) throw new ControlPlaneError("控制面未配置");
    await this.connectOnce();
    const outcomes = await this.claimRound(this.controller?.signal ?? new AbortController().signal, limit);
    return { status: this.status(), outcomes };
  }

  private startLoops(): void {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const signal = controller.signal;
    void this.heartbeatLoop(signal);
    void this.claimLoop(signal);
    void this.notificationLoop(signal);
  }

  private async notificationLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const client = this.client;
      if (client && this.registered) {
        try {
          await client.notifications(signal, () => {
            if (!signal.aborted && this.client === client)
              void this.claimRound(signal, 1).catch((error) => {
                this.lastError = message(error);
              });
          });
        } catch {
          // 老服务器、不支持 SSE 的反向代理及断线：认领轮询仍继续工作。
        }
      }
      await sleep(5_000, signal);
    }
  }

  /** 心跳：未注册先注册，失败就退回「未注册」，下个 tick 重试。 */
  private async heartbeatLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await sleep(this.tickSecs * 1000, signal);
      if (signal.aborted) return;
      try {
        await this.connectOnce();
      } catch (error) {
        if (signal.aborted) return;
        this.registered = false;
        this.lastError = message(error);
        console.error("[control-plane] 心跳失败：" + this.lastError);
      }
    }
  }

  /** 认领：只在已注册时跑；执行串行，执行期间心跳由上面那条链维持。 */
  private async claimLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await sleep(this.tickSecs * 1000, signal);
      if (signal.aborted || !this.registered) continue;
      try {
        await this.claimRound(signal, MAX_CLAIM_PER_TICK);
      } catch (error) {
        this.lastError = message(error);
        console.error("[control-plane] 认领失败：" + this.lastError);
      }
    }
  }

  private async claimRound(signal: AbortSignal, limit: number): Promise<Outcome[]> {
    if (this.claiming || signal.aborted) return [];
    this.claiming = true;
    try {
      return await this.claimRoundInner(signal, limit);
    } finally {
      this.claiming = false;
    }
  }

  private async claimRoundInner(signal: AbortSignal, limit: number): Promise<Outcome[]> {
    const client = this.client;
    if (!client) return [];
    const dues = await client.claim(Math.min(limit, 1));
    if (signal.aborted || this.client !== client) return [];
    this.lastClaimAt = Date.now();
    const outcomes: Outcome[] = [];
    for (const due of dues) {
      if (signal.aborted) return outcomes;
      const outcome = await this.executeDue(due, signal);
      try {
        await client.finish(due.id, {
          status: outcome.ok ? "ok" : "failed",
          detail: outcome.detail,
          sessionId: null,
          output: outcome.output ?? null,
        });
      } catch (error) {
        this.lastError = "回执失败：" + message(error);
        console.error(`[control-plane] 回执失败 due=${due.id}：${this.lastError}`);
      }
      this.lastOutcome = { name: outcome.name, ok: outcome.ok, detail: outcome.detail };
      outcomes.push(outcome);
      console.log(`[control-plane] 云端任务${outcome.ok ? "执行完成" : "执行失败"}：${outcome.name} — ${outcome.detail}`);
    }
    return outcomes;
  }

  /** 设置快照里的默认供应商：选中项优先，否则第一个启用的。 */
  private resolveProvider(): ProviderSnapshot {
    const raw = this.options.db.loadSettings() as {
      modelProviders?: ProviderSnapshot[];
      selectedModelProviderId?: string | null;
    } | null;
    const providers = (raw?.modelProviders ?? []).filter((item) => item && item.enabled !== false && (item.model ?? "") !== "");
    if (providers.length === 0) {
      throw new Error("没有可用的模型供应商：请先在 设置 → Agent 里启用一个");
    }
    return providers.find((item) => item.id === raw?.selectedModelProviderId) ?? providers[0];
  }

  /** 执行单条云端任务：与本地兜底同语义（LLM 直连单轮、无工具）。 */
  private async executeDue(due: ControlDue, signal: AbortSignal): Promise<Outcome> {
    const name = due.name || due.taskId;
    if (due.acpProviderId !== null && due.acpProviderId !== "") {
      return { name, ok: false, detail: "任务绑定 ACP 后端：无人值守执行只支持本机模型直连，需在应用内执行" };
    }
    let provider: ProviderSnapshot;
    try {
      provider = this.resolveProvider();
    } catch (error) {
      return { name, ok: false, detail: message(error) };
    }
    if (provider.kind === "anthropic") {
      return { name, ok: false, detail: "Anthropic 原生协议不在宿主直连范围：请改用 OpenAI 兼容端点，或在应用内执行" };
    }
    const baseUrl = (provider.baseUrl ?? "").trim();
    if (baseUrl === "") {
      return { name, ok: false, detail: `供应商 ${provider.name ?? provider.id} 没填 Base URL` };
    }
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutSecs * 1000);
    timer.unref?.();
    try {
      const apiKey = resolveApiKey(provider.apiKeyEnv);
      const body: Record<string, unknown> = {
        model: (due.model ?? "").trim() || provider.model,
        stream: false,
        messages: [{ role: "user", content: due.intent }],
      };
      if (typeof provider.temperature === "number") body.temperature = provider.temperature;
      if (typeof provider.maxTokens === "number") body.max_tokens = provider.maxTokens;
      if ((provider.reasoningEffort ?? "") !== "") body.reasoning_effort = provider.reasoningEffort;
      const response = await fetch(endpointUrl(baseUrl, "chat/completions"), {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(apiKey, provider.headers) },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return { name, ok: false, detail: `模型端点返回 ${response.status}: ${truncate(text, 180)}` };
      }
      const payload = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
      const content = normalizeContent(payload.choices?.[0]?.message?.content).trim();
      if (content === "") return { name, ok: false, detail: "模型返回空内容" };
      return { name, ok: true, detail: truncate(content, 200), output: content };
    } catch (error) {
      if (controller.signal.aborted) {
        return { name, ok: false, detail: signal.aborted ? "宿主正在关闭，任务未完成" : `执行超时（${this.timeoutSecs} 秒上限）` };
      }
      return { name, ok: false, detail: message(error) };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }
}
