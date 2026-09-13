/**
 * 能力注册表：授权门禁、插件中心展示与宿主 broker 实现的单一事实源。
 *
 * 能力 = 一项受控宿主 API。每项定义声明：
 * - 元数据（title/description/danger）：授权 UI 与门禁报错文案；
 * - `invoke(args, ctx)`：宿主侧唯一执行入口。域名校权、限速、审计都在该函数内收口，
 *   worker 内没有宿主中转就不可能触达任何宿主资源。
 *
 * 新能力先在此登记再被插件引用 —— 单文件目录便于审计；本模块不 import
 * loader/builtin/market 任何东西，避免环。
 */

/** 调用审计：环形缓冲 + localStorage 持久化，插件中心「能力」页签展示。 */
export interface CapabilityAuditEntry {
  /** 插件 id */
  plugin: string;
  /** 能力 id */
  capability: string;
  /** ISO 时间戳 */
  at: string;
  /** 调用结果：ok / denied / error */
  outcome: "ok" | "denied" | "error";
  /** 结果备注（拒绝原因 / 错误摘要 / 目标 host），≤200 字符 */
  detail?: string;
}

export interface CapabilityCallContext {
  /** 发起调用的插件 id。 */
  pluginId: string;
  /** 该插件 manifest 里此项能力声明的参数（如 hosts 白名单），归一化后的对象形态。 */
  grant: { capability: string; hosts?: string[] };
  /** 审计写入（能力实现内部在关键决策点调用）。 */
  audit(entry: CapabilityAuditEntry): void;
}

/**
 * manifest `requires` 项：字符串 = 无参数默认形态（向后兼容）；
 * 对象 = 带资源参数的最小特权声明（如 net.fetch 的域名白名单）。
 */
export type CapabilityGrantSpec = string | { capability: string; hosts?: string[] };

/** 归一化：把 requires 项映成 { capability, params }。 */
export function normalizeGrantSpec(spec: CapabilityGrantSpec): { capability: string; hosts?: string[] } {
  return typeof spec === "string" ? { capability: spec } : { capability: spec.capability, hosts: spec.hosts };
}

export type CapabilityDanger = "low" | "medium" | "high";

export interface CapabilityDefinition {
  id: string;
  title: string;
  /** 授权弹窗 / 能力页签里给用户看的精确语义说明。 */
  description: string;
  danger: CapabilityDanger;
  /**
   * 宿主 broker：插件经 worker host-call 通道发起的唯一入口。
   * 实现内部必须自行完成参数校验、资源限域、审计。
   */
  invoke(args: unknown, ctx: CapabilityCallContext): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// 审计日志
// ---------------------------------------------------------------------------

const AUDIT_STORAGE_KEY = "greywork.plugins.capabilityAudit";
const AUDIT_MAX_ENTRIES = 200;

function isAuditEntry(value: unknown): value is CapabilityAuditEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.plugin === "string" &&
    typeof entry.capability === "string" &&
    typeof entry.at === "string" &&
    (entry.outcome === "ok" || entry.outcome === "denied" || entry.outcome === "error") &&
    (entry.detail === undefined || typeof entry.detail === "string")
  );
}

function readAuditArchive(): CapabilityAuditEntry[] {
  try {
    const raw = localStorage.getItem(AUDIT_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every(isAuditEntry) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAuditArchive(entries: readonly CapabilityAuditEntry[]): void {
  try {
    localStorage.setItem(AUDIT_STORAGE_KEY, JSON.stringify(entries.slice(0, AUDIT_MAX_ENTRIES)));
  } catch {
    // 存储满 / 隐私模式：审计尽力而为，不阻断调用。
  }
}

let auditEntries: CapabilityAuditEntry[] = readAuditArchive();

/** 追加一条审计（环形缓冲，最新在前）。测试可读取快照断言。 */
export function recordCapabilityAudit(entry: CapabilityAuditEntry): void {
  auditEntries = [entry, ...auditEntries].slice(0, AUDIT_MAX_ENTRIES);
  writeAuditArchive(auditEntries);
}

/** 当前审计快照（最新在前）。 */
export function capabilityAuditLog(): readonly CapabilityAuditEntry[] {
  return auditEntries;
}

/** 测试钩子：清空内存与持久化审计。 */
export function resetCapabilityAuditForTest(): void {
  auditEntries = [];
  try {
    localStorage.removeItem(AUDIT_STORAGE_KEY);
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// net.fetch 传输（域名校权/限速/审计在下方 invoke 内；传输只管字节搬运）
// ---------------------------------------------------------------------------

/**
 * net.fetch 传输层：桌面态由外壳注入 Tauri IPC 代理（Rust 侧二次校验
 * hosts 白名单 + 体积/超时防线 —— webview CSP 是静态策略，无法按插件动态放宽）；
 * 未注入时（Web 预览 / 单测）回退受限 webview fetch。域名校权/限速/审计恒在本层。
 */
export type NetFetchTransport = (request: {
  url: string;
  method?: "GET" | "HEAD";
  headers?: Record<string, string>;
  allowedHosts: string[];
}) => Promise<{ status: number; ok: boolean; headers: Record<string, string>; body?: string }>;

let netFetchTransport: NetFetchTransport | null = null;

/** 桌面态由外壳注入 IPC 传输；传 null 恢复 webview fetch 回退。 */
export function setNetFetchTransportForHost(transport: NetFetchTransport | null): void {
  netFetchTransport = transport;
}

// ---------------------------------------------------------------------------
// 能力实现：net.fetch
// ---------------------------------------------------------------------------

const NET_FETCH_TIMEOUT_MS = 15_000;
const NET_FETCH_MAX_BYTES = 1024 * 1024;
const NET_FETCH_WINDOW_MS = 60_000;
const NET_FETCH_MAX_CALLS_PER_WINDOW = 30;

/** 每插件滑动窗口限速（module 级，应用单例）。 */
const netFetchWindows = new Map<string, number[]>();

function takeNetFetchToken(pluginId: string): boolean {
  const now = Date.now();
  const window = (netFetchWindows.get(pluginId) ?? []).filter((ts) => now - ts < NET_FETCH_WINDOW_MS);
  if (window.length >= NET_FETCH_MAX_CALLS_PER_WINDOW) {
    netFetchWindows.set(pluginId, window);
    return false;
  }
  window.push(now);
  netFetchWindows.set(pluginId, window);
  return true;
}

/** host 归一化比较：精确匹配或以 `.` 为界的后缀匹配（`api.github.com` 允许 `github.com`）。 */
function hostMatches(host: string, allowed: string): boolean {
  if (host === allowed) return true;
  return host.endsWith(`.${allowed}`) && !allowed.includes("/");
}

interface NetFetchArgs {
  url: string;
  method?: "GET" | "HEAD";
  headers?: Record<string, string>;
}

function isNetFetchArgs(value: unknown): value is NetFetchArgs {
  if (typeof value !== "object" || value === null) return false;
  const args = value as Record<string, unknown>;
  if (typeof args.url !== "string") return false;
  if (args.method !== undefined && args.method !== "GET" && args.method !== "HEAD") return false;
  if (args.headers !== undefined) {
    if (typeof args.headers !== "object" || args.headers === null || Array.isArray(args.headers)) return false;
    for (const [key, val] of Object.entries(args.headers)) {
      if (typeof val !== "string") return false;
      // 禁改安全敏感头：避免伪装来源 / 绕过内容协商。
      if (/^(authorization|cookie|host|origin|referer|sec-)/i.test(key)) return false;
    }
  }
  return true;
}

const netFetchCapability: CapabilityDefinition = {
  id: "net.fetch",
  title: "网络请求",
  description: "允许插件向其声明的域名白名单发起 HTTPS GET/HEAD 请求；每分钟最多 30 次，响应体上限 1MB。",
  danger: "medium",
  async invoke(args, ctx) {
    if (!isNetFetchArgs(args)) throw new Error("net.fetch requires { url, method?, headers? } with string values");
    const allowedHosts = ctx.grant.hosts ?? [];
    if (!allowedHosts.length)
      throw new Error('net.fetch requires a manifest host allowlist (requires: { capability: "net.fetch", hosts: [...] })');

    let parsed: URL;
    try {
      parsed = new URL(args.url);
    } catch {
      throw new Error(`net.fetch url is not absolute: ${args.url.slice(0, 120)}`);
    }
    if (parsed.protocol !== "https:") throw new Error("net.fetch only allows https: urls");
    if (parsed.username || parsed.password) throw new Error("net.fetch does not allow embedded credentials");
    if (!allowedHosts.some((allowed) => hostMatches(parsed.hostname, allowed))) {
      ctx.audit({
        plugin: ctx.pluginId,
        capability: "net.fetch",
        at: new Date().toISOString(),
        outcome: "denied",
        detail: `host not in allowlist: ${parsed.hostname}`,
      });
      throw new Error(`net.fetch host is not in the plugin allowlist: ${parsed.hostname}`);
    }
    if (!takeNetFetchToken(ctx.pluginId)) {
      ctx.audit({
        plugin: ctx.pluginId,
        capability: "net.fetch",
        at: new Date().toISOString(),
        outcome: "denied",
        detail: "rate limit exceeded (30/min)",
      });
      throw new Error("net.fetch rate limit exceeded (30 requests per minute)");
    }

    if (netFetchTransport) {
      try {
        const result = await netFetchTransport({ url: args.url, method: args.method, headers: args.headers, allowedHosts });
        ctx.audit({
          plugin: ctx.pluginId,
          capability: "net.fetch",
          at: new Date().toISOString(),
          outcome: "ok",
          detail: `${result.status} ${parsed.hostname}`,
        });
        return result;
      } catch (error) {
        ctx.audit({
          plugin: ctx.pluginId,
          capability: "net.fetch",
          at: new Date().toISOString(),
          outcome: "error",
          detail: (error instanceof Error ? error.message : String(error)).slice(0, 200),
        });
        throw error;
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NET_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(parsed.toString(), {
        method: args.method ?? "GET",
        headers: args.headers,
        signal: controller.signal,
        redirect: "error",
      });
      const contentLength = Number(response.headers.get("content-length") ?? "0");
      if (contentLength > NET_FETCH_MAX_BYTES) {
        ctx.audit({
          plugin: ctx.pluginId,
          capability: "net.fetch",
          at: new Date().toISOString(),
          outcome: "denied",
          detail: `response too large: ${parsed.hostname}`,
        });
        throw new Error(`net.fetch response exceeds ${NET_FETCH_MAX_BYTES} bytes`);
      }
      // HEAD 或不可读 body：不消费 body。
      const text = args.method === "HEAD" || response.status === 204 ? undefined : await response.text();
      if (text !== undefined && text.length > NET_FETCH_MAX_BYTES) {
        ctx.audit({
          plugin: ctx.pluginId,
          capability: "net.fetch",
          at: new Date().toISOString(),
          outcome: "denied",
          detail: `response too large: ${parsed.hostname}`,
        });
        throw new Error(`net.fetch response exceeds ${NET_FETCH_MAX_BYTES} bytes`);
      }
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      ctx.audit({
        plugin: ctx.pluginId,
        capability: "net.fetch",
        at: new Date().toISOString(),
        outcome: "ok",
        detail: `${response.status} ${parsed.hostname}`,
      });
      return { status: response.status, ok: response.ok, headers: responseHeaders, body: text };
    } catch (error) {
      if (error instanceof Error && !/allowlist|rate limit|exceeds/.test(error.message)) {
        ctx.audit({
          plugin: ctx.pluginId,
          capability: "net.fetch",
          at: new Date().toISOString(),
          outcome: "error",
          detail: error.message.slice(0, 200),
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  },
};

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

/** plugin-admin：宿主内建信任标记（内置插件经可信集自动满足），不构成 worker 可调用 API。 */
const pluginAdminCapability: CapabilityDefinition = {
  id: "plugin-admin",
  title: "插件管理",
  description: "允许启停插件、管理能力授权。",
  danger: "high",
  async invoke() {
    throw new Error("plugin-admin is a host trust mark, not callable from plugin code");
  },
};

/**
 * window.floating：宿主动作式能力 —— 插件声明后由宿主 UI 开透明置顶悬浮窗渲染
 * 其指令流（窗口句柄永不交给插件代码）。worker 内不可调用（同 plugin-admin）。
 */
const floatingWindowCapability: CapabilityDefinition = {
  id: "window.floating",
  title: "桌面悬浮窗",
  description: "允许在桌面创建透明置顶小窗（仅渲染该插件声明的画布；窗口由宿主托管）。",
  danger: "medium",
  async invoke() {
    throw new Error("window.floating is a host-gated action, not callable from plugin code");
  },
};

/** 已知能力目录：授权门禁与插件中心展示的单一事实源。 */
export const CAPABILITY_REGISTRY: Readonly<Record<string, CapabilityDefinition>> = {
  [netFetchCapability.id]: netFetchCapability,
  [pluginAdminCapability.id]: pluginAdminCapability,
  [floatingWindowCapability.id]: floatingWindowCapability,
};

/** 能力显示名：已知能力取目录 title，未知能力回退 id 本身。 */
export function capabilityTitle(id: string): string {
  return CAPABILITY_REGISTRY[id]?.title ?? id;
}
