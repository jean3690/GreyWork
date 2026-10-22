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
  /** 该插件 manifest 里此项能力声明的参数（如 hosts 白名单 / schedule 定时），归一化后的对象形态。 */
  grant: {
    capability: string;
    hosts?: string[];
    methods?: string[];
    paths?: string[];
    maxBytes?: number;
    schedule?: ManifestScheduleDeclaration;
    models?: string[];
    ops?: string[];
  };
  /** 审计写入（能力实现内部在关键决策点调用）。 */
  audit(entry: CapabilityAuditEntry): void;
}

/** schedule 能力的定时参数（与 Rust `ManifestSchedule` 同构，安装期已校验）。 */
export interface ManifestScheduleDeclaration {
  /** 目前只有固定间隔一种形态。 */
  kind: "interval";
  /** 最小触发间隔（分钟），5..1440。 */
  min: number;
}

/**
 * manifest `requires` 项：字符串 = 无参数默认形态（向后兼容）；
 * 对象 = 带资源参数的最小特权声明（net.fetch 的 hosts/methods/paths/maxBytes、
 * schedule 的定时参数）。
 */
export type CapabilityGrantSpec =
  | string
  | {
      capability: string;
      hosts?: string[];
      methods?: string[];
      paths?: string[];
      maxBytes?: number;
      schedule?: ManifestScheduleDeclaration;
      models?: string[];
      ops?: string[];
    };

/** 归一化：把 requires 项映成 { capability, params }。 */
export function normalizeGrantSpec(spec: CapabilityGrantSpec): {
  capability: string;
  hosts?: string[];
  methods?: string[];
  paths?: string[];
  maxBytes?: number;
  schedule?: ManifestScheduleDeclaration;
  models?: string[];
  ops?: string[];
} {
  return typeof spec === "string"
    ? { capability: spec }
    : {
        capability: spec.capability,
        hosts: spec.hosts,
        methods: spec.methods,
        paths: spec.paths,
        maxBytes: spec.maxBytes,
        schedule: spec.schedule,
        models: spec.models,
        ops: spec.ops,
      };
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
export type NetFetchMethod = "GET" | "HEAD" | "POST";

/**
 * net.fetch 传输层：桌面态由外壳注入 Tauri IPC 代理（Rust 侧二次校验
 * hosts 白名单 + methods/paths/maxBytes 与体积/超时防线 —— webview CSP 是静态策略，
 * 无法按插件动态放宽）；未注入时（Web 预览 / 单测）回退受限 webview fetch。
 * 域名校权/限速/审计恒在本层。
 */
export type NetFetchTransport = (request: {
  url: string;
  method?: NetFetchMethod;
  headers?: Record<string, string>;
  /** 仅 POST 允许携带的请求体。 */
  body?: string;
  allowedHosts: string[];
  /** 允许的 HTTP 方法子集（来自 manifest 声明，已归一化）。 */
  methods: string[];
  /** POST 允许的路径模板。 */
  paths: string[];
  /** 单次上下行字节上限。 */
  maxBytes: number;
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
const NET_FETCH_DEFAULT_MAX_BYTES = 1024 * 1024;
/** 声明 maxBytes 的下界（1 KiB）：低于此值无实际用途。 */
const NET_FETCH_MIN_MAX_BYTES = 1024;
/** 声明 maxBytes 的硬上限（8 MiB）：纵深防御，声明再大也封顶。 */
const NET_FETCH_CEILING_MAX_BYTES = 8 * 1024 * 1024;
const NET_FETCH_WINDOW_MS = 60_000;
const NET_FETCH_MAX_CALLS_PER_WINDOW = 30;
/** 声明未给出 methods 时的缺省方法子集。 */
const NET_FETCH_DEFAULT_METHODS: readonly NetFetchMethod[] = ["GET", "HEAD"];
/** 允许声明的方法全集。 */
const NET_FETCH_ALLOWED_METHODS: readonly NetFetchMethod[] = ["GET", "HEAD", "POST"];

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

/** 声明 → 生效方法子集：只保留白名单内的方法（去重）；未声明 = GET/HEAD。 */
function resolveNetFetchMethods(declared: readonly string[] | undefined): NetFetchMethod[] {
  if (!declared || declared.length === 0) return [...NET_FETCH_DEFAULT_METHODS];
  const result: NetFetchMethod[] = [];
  for (const method of declared) {
    if (NET_FETCH_ALLOWED_METHODS.includes(method as NetFetchMethod) && !result.includes(method as NetFetchMethod)) {
      result.push(method as NetFetchMethod);
    }
  }
  return result;
}

/** 声明 → 生效字节上限：夹在 [1 KiB, 8 MiB]；未声明 / 非法 = 默认 1 MiB。 */
function resolveNetFetchMaxBytes(declared: number | undefined): number {
  if (typeof declared !== "number" || !Number.isFinite(declared)) return NET_FETCH_DEFAULT_MAX_BYTES;
  return Math.min(Math.max(Math.floor(declared), NET_FETCH_MIN_MAX_BYTES), NET_FETCH_CEILING_MAX_BYTES);
}

/** UTF-8 字节数（配额按字节而非 UTF-16 码元）。 */
function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * 路径模板匹配（与 Rust 宿主同构，纵深防御）：
 * `*` 匹配段内任意字符（不含 `/`），整段 `**` 匹配零个或多个路径段。
 */
function pathMatchesTemplate(pathname: string, template: string): boolean {
  return segmentsMatch(pathname.split("/"), template.split("/"));
}

function segmentsMatch(path: string[], template: string[]): boolean {
  if (template.length === 0) return path.length === 0;
  const [segment, ...rest] = template;
  if (segment === "**") {
    for (let index = 0; index <= path.length; index++) {
      if (segmentsMatch(path.slice(index), rest)) return true;
    }
    return false;
  }
  if (path.length === 0) return false;
  return segmentMatches(path[0], segment) && segmentsMatch(path.slice(1), rest);
}

/** 段内 glob：`*` 匹配任意字符序列（含空）。经典单星回溯匹配。 */
function segmentMatches(text: string, pattern: string): boolean {
  let textIndex = 0;
  let patternIndex = 0;
  let star = -1;
  let starText = 0;
  while (textIndex < text.length) {
    if (patternIndex < pattern.length && pattern[patternIndex] === "*") {
      star = patternIndex;
      starText = textIndex;
      patternIndex += 1;
    } else if (patternIndex < pattern.length && pattern[patternIndex] === text[textIndex]) {
      textIndex += 1;
      patternIndex += 1;
    } else if (star >= 0) {
      patternIndex = star + 1;
      starText += 1;
      textIndex = starText;
    } else {
      return false;
    }
  }
  while (patternIndex < pattern.length && pattern[patternIndex] === "*") patternIndex += 1;
  return patternIndex === pattern.length;
}

interface NetFetchArgs {
  url: string;
  method?: NetFetchMethod;
  headers?: Record<string, string>;
  body?: string;
}

function isNetFetchArgs(value: unknown): value is NetFetchArgs {
  if (typeof value !== "object" || value === null) return false;
  const args = value as Record<string, unknown>;
  if (typeof args.url !== "string") return false;
  if (args.method !== undefined && args.method !== "GET" && args.method !== "HEAD" && args.method !== "POST") return false;
  if (args.body !== undefined && typeof args.body !== "string") return false;
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
  description:
    "允许插件向其声明的域名白名单发起 HTTPS 请求（默认 GET/HEAD；POST 仅限声明的路径模板）；每分钟最多 30 次，上下行默认 1MB（可按声明放宽到 8MB）。",
  danger: "medium",
  async invoke(args, ctx) {
    if (!isNetFetchArgs(args)) throw new Error("net.fetch requires { url, method?, headers?, body? } with string values");
    const allowedHosts = ctx.grant.hosts ?? [];
    if (!allowedHosts.length)
      throw new Error('net.fetch requires a manifest host allowlist (requires: { capability: "net.fetch", hosts: [...] })');
    const methods = resolveNetFetchMethods(ctx.grant.methods);
    const paths = ctx.grant.paths ?? [];
    const maxBytes = resolveNetFetchMaxBytes(ctx.grant.maxBytes);

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

    const method: NetFetchMethod = args.method ?? "GET";
    if (!methods.includes(method)) {
      ctx.audit({
        plugin: ctx.pluginId,
        capability: "net.fetch",
        at: new Date().toISOString(),
        outcome: "denied",
        detail: `method not declared: ${method}`,
      });
      throw new Error(`net.fetch method is not declared for this plugin: ${method}`);
    }
    if (method === "POST") {
      if (!paths.length) {
        ctx.audit({
          plugin: ctx.pluginId,
          capability: "net.fetch",
          at: new Date().toISOString(),
          outcome: "denied",
          detail: "POST requires declared path templates",
        });
        throw new Error("net.fetch POST requires declared path templates");
      }
      if (!paths.some((template) => pathMatchesTemplate(parsed.pathname, template))) {
        ctx.audit({
          plugin: ctx.pluginId,
          capability: "net.fetch",
          at: new Date().toISOString(),
          outcome: "denied",
          detail: `POST path not in allowlist: ${parsed.pathname}`,
        });
        throw new Error(`net.fetch POST path is not in the plugin allowlist: ${parsed.pathname}`);
      }
    } else if (args.body !== undefined) {
      throw new Error("net.fetch body is only allowed for POST");
    }
    if (args.body !== undefined && utf8Length(args.body) > maxBytes) {
      ctx.audit({
        plugin: ctx.pluginId,
        capability: "net.fetch",
        at: new Date().toISOString(),
        outcome: "denied",
        detail: `request body too large: ${parsed.hostname}`,
      });
      throw new Error(`net.fetch request body exceeds ${maxBytes} bytes`);
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
        const result = await netFetchTransport({
          url: args.url,
          method: args.method,
          headers: args.headers,
          body: args.body,
          allowedHosts,
          methods,
          paths,
          maxBytes,
        });
        ctx.audit({
          plugin: ctx.pluginId,
          capability: "net.fetch",
          at: new Date().toISOString(),
          outcome: "ok",
          detail: `${method} ${result.status} ${parsed.hostname}`,
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
        method,
        headers: args.headers,
        body: args.body,
        signal: controller.signal,
        redirect: "error",
      });
      const contentLength = Number(response.headers.get("content-length") ?? "0");
      if (contentLength > maxBytes) {
        ctx.audit({
          plugin: ctx.pluginId,
          capability: "net.fetch",
          at: new Date().toISOString(),
          outcome: "denied",
          detail: `response too large: ${parsed.hostname}`,
        });
        throw new Error(`net.fetch response exceeds ${maxBytes} bytes`);
      }
      // HEAD 或不可读 body：不消费 body。
      const text = method === "HEAD" || response.status === 204 ? undefined : await response.text();
      if (text !== undefined && utf8Length(text) > maxBytes) {
        ctx.audit({
          plugin: ctx.pluginId,
          capability: "net.fetch",
          at: new Date().toISOString(),
          outcome: "denied",
          detail: `response too large: ${parsed.hostname}`,
        });
        throw new Error(`net.fetch response exceeds ${maxBytes} bytes`);
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
        detail: `${method} ${response.status} ${parsed.hostname}`,
      });
      return { status: response.status, ok: response.ok, headers: responseHeaders, body: text };
    } catch (error) {
      if (error instanceof Error && !/allowlist|rate limit|exceeds|not declared|only allowed|requires declared/.test(error.message)) {
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

// ---------------------------------------------------------------------------
// storage.kv：插件级键值存储（纯前端沙箱）
// ---------------------------------------------------------------------------
// 与 declarativeState 同构（webview localStorage 持久化），但职责不同：
// declarativeState 是宿主为页面字段渲染的状态；storage.kv 是插件 worker 自己的
// 私有存储 —— 任意 JSON、按键隔离、带配额。worker 无文件/无 IndexedDB 感知，
// 这是插件当前唯一可依赖的持久化出口。
//
// 防护：键名白名单正则、单值 64 KiB、每插件总量 256 KiB、值必须 JSON 安全
// （拒 undefined/函数/NaN/循环引用/Date 等非普通对象），违规一律审计 denied。

const KV_STORAGE_KEY = "greywork.plugins.storageKv";
const KV_MAX_TOTAL_BYTES = 256 * 1024;
const KV_MAX_VALUE_BYTES = 64 * 1024;
/** 键规则与插件 id 一致：小写字母/数字开头，允许 . _ - :，最长 128。 */
const KV_KEY_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

type KvNamespace = Record<string, unknown>;
type KvArchive = Record<string, KvNamespace>;

function isKvArchive(value: unknown): value is KvArchive {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (namespace) =>
      typeof namespace === "object" &&
      namespace !== null &&
      !Array.isArray(namespace) &&
      Object.keys(namespace).every((key) => KV_KEY_PATTERN.test(key)),
  );
}

function readKvArchive(): KvArchive {
  try {
    const raw = localStorage.getItem(KV_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return isKvArchive(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeKvArchive(archive: KvArchive): void {
  try {
    localStorage.setItem(KV_STORAGE_KEY, JSON.stringify(archive));
  } catch {
    // 存储满 / 隐私模式：尽力而为，不阻断调用（本会话内存态继续可用）。
  }
}

let kvArchive: KvArchive = readKvArchive();

/** 测试钩子：清空内存与持久化存储（单测 / e2e 共享）。 */
export function resetStorageKvForTest(): void {
  kvArchive = {};
  try {
    localStorage.removeItem(KV_STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** 命名空间当前占用（近似 JSON 字节数，与配额检查口径一致）。 */
function namespaceBytes(namespace: KvNamespace): number {
  let total = 0;
  for (const value of Object.values(namespace)) {
    try {
      total += JSON.stringify(value).length;
    } catch {
      total += KV_MAX_VALUE_BYTES; // 不可序列化值视为已占满单值配额
    }
  }
  return total;
}

/**
 * set 值必须 JSON 安全：null / string / boolean / 有限 number / 数组 / 普通对象。
 * 递归带 seen 集防循环引用；Date/Map/Set 等非普通对象拒收（JSON.stringify 会静默变形）。
 */
function isStorageKvValue(value: unknown, seen = new Set<object>()): boolean {
  if (value === null) return true;
  // 逐个 inline 检查 typeof，才能让 TS 对 value: unknown 正常收窄（中间变量会阻断收窄）。
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false; // undefined / function / symbol / bigint
  if (seen.has(value)) return false; // 循环引用
  seen.add(value);
  const plain = Object.getPrototypeOf(value) === Object.prototype;
  const ok = Array.isArray(value)
    ? value.every((item) => isStorageKvValue(item, seen))
    : plain && Object.values(value).every((item) => isStorageKvValue(item, seen));
  seen.delete(value);
  return ok;
}

type StorageKvOp = "get" | "set" | "remove" | "list" | "clear";

interface StorageKvArgs {
  op: StorageKvOp;
  key?: string;
  value?: unknown;
}

function isStorageKvArgs(value: unknown): value is StorageKvArgs {
  if (typeof value !== "object" || value === null) return false;
  const args = value as Record<string, unknown>;
  const op = args.op;
  if (op !== "get" && op !== "set" && op !== "remove" && op !== "list" && op !== "clear") return false;
  // 只有 set 可以携带 value；get/remove/list/clear 带 value 视为非法。
  if (op !== "set" && args.value !== undefined) return false;
  // get/set/remove 必须带合法 key；list/clear 不得带 key。
  const keyed = op === "get" || op === "set" || op === "remove";
  if (keyed) {
    if (typeof args.key !== "string" || !KV_KEY_PATTERN.test(args.key)) return false;
  } else if (args.key !== undefined) {
    return false;
  }
  return true;
}

const storageKvCapability: CapabilityDefinition = {
  id: "storage.kv",
  title: "插件存储",
  description:
    "插件级键值存储：读/写/删除/枚举/清空（get/set/remove/list/clear），值为任意 JSON；每插件总量 256 KiB、单值 64 KiB，按插件隔离。",
  danger: "low",
  async invoke(args, ctx) {
    if (!isStorageKvArgs(args)) {
      throw new Error("storage.kv requires { op: get|set|remove|list|clear, key?, value? } with a valid lowercase key");
    }
    const audit = (outcome: "ok" | "denied" | "error", detail: string): void => {
      ctx.audit({
        plugin: ctx.pluginId,
        capability: "storage.kv",
        at: new Date().toISOString(),
        outcome,
        detail: detail.slice(0, 200),
      });
    };
    const namespace: KvNamespace = kvArchive[ctx.pluginId] ?? {};
    const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(namespace, key);

    switch (args.op) {
      case "get": {
        audit("ok", `get ${args.key}`);
        return { value: has(args.key!) ? namespace[args.key!] : null };
      }
      case "set": {
        if (!isStorageKvValue(args.value)) {
          audit("denied", "value is not JSON-safe (undefined/functions/NaN/circular references and Date/Map/Set are rejected)");
          throw new Error("storage.kv value must be JSON-safe (finite numbers, strings, booleans, arrays and plain objects only)");
        }
        const serialized = JSON.stringify(args.value) as string;
        if (serialized.length > KV_MAX_VALUE_BYTES) {
          audit("denied", `value exceeds ${KV_MAX_VALUE_BYTES} bytes`);
          throw new Error(`storage.kv value exceeds the ${KV_MAX_VALUE_BYTES} byte per-value limit`);
        }
        const previousBytes = has(args.key!) ? (JSON.stringify(namespace[args.key!])?.length ?? 0) : 0;
        if (namespaceBytes(namespace) - previousBytes + serialized.length > KV_MAX_TOTAL_BYTES) {
          audit("denied", `namespace would exceed ${KV_MAX_TOTAL_BYTES} bytes`);
          throw new Error(`storage.kv namespace exceeds the ${KV_MAX_TOTAL_BYTES} byte per-plugin quota`);
        }
        namespace[args.key!] = args.value;
        kvArchive[ctx.pluginId] = namespace;
        writeKvArchive(kvArchive);
        audit("ok", `set ${args.key}`);
        return { ok: true };
      }
      case "remove": {
        if (has(args.key!)) {
          delete namespace[args.key!];
          // 删空后清理顶层键：空命名空间不再占位（磁盘结构与语义一致）。
          if (Object.keys(namespace).length === 0) {
            delete kvArchive[ctx.pluginId];
          } else {
            kvArchive[ctx.pluginId] = namespace;
          }
          writeKvArchive(kvArchive);
        }
        audit("ok", `remove ${args.key}`);
        return { ok: true };
      }
      case "list": {
        audit("ok", "list");
        return { keys: Object.keys(namespace) };
      }
      case "clear": {
        delete kvArchive[ctx.pluginId];
        writeKvArchive(kvArchive);
        audit("ok", "clear");
        return { ok: true };
      }
      default: {
        throw new Error(`unknown storage.kv op: ${args.op as string}`);
      }
    }
  },
};

// ---------------------------------------------------------------------------
// fs.scoped 传输（宿主沙箱文件区；无宿主时调用直接失败 —— 文件系统不是
// webview 能等价降级的东西，与 net.fetch 的 webview 回退不同）
// ---------------------------------------------------------------------------

export type PluginFsOp = "read" | "write" | "remove" | "list" | "stat";

export interface PluginFsHostEntry {
  name: string;
  dir: boolean;
  bytes: number;
}

/** 宿主侧（Rust plugin_fs 命令）返回的扁平结构，与 `PluginFsResponse` 对齐。 */
export interface PluginFsHostResponse {
  bytes: number;
  totalBytes: number;
  data?: string;
  entries?: PluginFsHostEntry[];
  removed?: boolean;
  exists?: boolean;
}

/**
 * fs.scoped 传输层：桌面/服务端态由外壳注入 IPC 代理（Rust 侧二次校验路径净化 +
 * 符号链接 + 配额）。Net.fetch 有 webview 回退是因为浏览器自带 fetch；文件系统
 * 没有等价物，无宿主时 invoke 直接失败。
 */
export type PluginFsTransport = (request: {
  pluginId: string;
  op: PluginFsOp;
  path: string;
  data?: string;
}) => Promise<PluginFsHostResponse>;

let fsTransport: PluginFsTransport | null = null;

/** 桌面态由外壳注入 IPC 传输；传 null 恢复「无宿主即失败」。 */
export function setPluginFsTransportForHost(transport: PluginFsTransport | null): void {
  fsTransport = transport;
}

// ---------------------------------------------------------------------------
// 能力实现：fs.scoped
// ---------------------------------------------------------------------------

const FS_PATH_MAX_CHARS = 1024;
const FS_VALUE_MAX_BYTES = 1024 * 1024; // 前端粗校验，Rust 侧为准

interface FsArgs {
  op: PluginFsOp;
  path: string;
  data?: string;
}

function isFsArgs(value: unknown): value is FsArgs {
  if (typeof value !== "object" || value === null) return false;
  const args = value as Record<string, unknown>;
  const op = args.op;
  if (op !== "read" && op !== "write" && op !== "remove" && op !== "list" && op !== "stat") return false;
  // read/write/remove 必须带非空路径；list/stat 允许缺省或空路径（= 沙箱根）。
  if (op === "read" || op === "write" || op === "remove") {
    if (typeof args.path !== "string" || args.path.trim() === "" || args.path.length > FS_PATH_MAX_CHARS) {
      return false;
    }
  } else if (args.path !== undefined && (typeof args.path !== "string" || args.path.length > FS_PATH_MAX_CHARS)) {
    return false;
  }
  if (op === "write") {
    if (typeof args.data !== "string") return false;
    if (args.data.length > FS_VALUE_MAX_BYTES) return false;
  } else if (args.data !== undefined) {
    return false;
  }
  return true;
}

const fsScopedCapability: CapabilityDefinition = {
  id: "fs.scoped",
  title: "文件沙箱",
  description:
    "插件私有文件区（<app_data>/plugins/<id>/files/）：读写/删除/枚举/统计（read/write/remove/list/stat）；仅相对路径、拒符号链接、单文件 1 MiB、每插件 8 MiB。",
  danger: "medium",
  async invoke(args, ctx) {
    if (!isFsArgs(args)) {
      throw new Error("fs.scoped requires { op: read|write|remove|list|stat, path, data? }");
    }
    const audit = (outcome: "ok" | "denied" | "error", detail: string): void => {
      ctx.audit({
        plugin: ctx.pluginId,
        capability: "fs.scoped",
        at: new Date().toISOString(),
        outcome,
        detail: detail.slice(0, 200),
      });
    };
    if (!fsTransport) {
      audit("denied", "no host transport: fs.scoped requires the desktop/server host");
      throw new Error("fs.scoped requires a desktop or server host (file system is unavailable in the web preview)");
    }
    const path = typeof args.path === "string" && args.path.trim() !== "" ? args.path : "";
    let response: PluginFsHostResponse;
    try {
      response = await fsTransport({
        pluginId: ctx.pluginId,
        op: args.op,
        path,
        data: args.data,
      });
    } catch (error) {
      audit("error", `host: ${String(error).slice(0, 180)}`);
      throw error;
    }
    switch (args.op) {
      case "read": {
        audit("ok", `read ${path}`);
        return { exists: !!response.exists, data: response.exists ? (response.data ?? "") : null, bytes: response.bytes ?? 0 };
      }
      case "write": {
        audit("ok", `write ${path}`);
        return { bytes: response.bytes ?? 0, totalBytes: response.totalBytes ?? 0 };
      }
      case "remove": {
        audit("ok", `remove ${path}`);
        return { removed: !!response.removed, totalBytes: response.totalBytes ?? 0 };
      }
      case "list": {
        audit("ok", `list ${path || "(root)"}`);
        return { exists: !!response.exists, entries: response.entries ?? [] };
      }
      case "stat": {
        audit("ok", `stat ${path || "(root)"}`);
        return { exists: !!response.exists, bytes: response.bytes ?? 0 };
      }
      default: {
        throw new Error(`unknown fs.scoped op: ${args.op as string}`);
      }
    }
  },
};

// ---------------------------------------------------------------------------
// workspace.read 传输（宿主授权工作区的只读访问；无宿主时调用直接失败）
// ---------------------------------------------------------------------------

export type PluginWorkspaceOp = "roots" | "read";

/** 一个已授权的工作区根。 */
export interface PluginWorkspaceRoot {
  /** 绝对路径。 */
  path: string;
  /** 目录名（展示用）。 */
  name: string;
}

/** 宿主侧（Rust `plugin_workspace` 命令）返回的扁平结构。 */
export interface PluginWorkspaceHostResponse {
  roots?: PluginWorkspaceRoot[];
  path?: string;
  name?: string;
  data?: string;
  /** 文件**总**字节数（配合 `truncated` 判断）。 */
  bytes?: number;
  truncated?: boolean;
  exists?: boolean;
}

/**
 * workspace.read 传输层：桌面/服务端态由外壳注入 IPC 代理。宿主侧复用
 * `WorkspaceFsAccess::resolve_existing`（不新建白名单）并做 256 KiB 预览截断；
 * 无宿主时 invoke 直接失败，与 fs.scoped 同一约定。
 */
export type PluginWorkspaceTransport = (request: {
  pluginId: string;
  op: PluginWorkspaceOp;
  path?: string;
}) => Promise<PluginWorkspaceHostResponse>;

let workspaceTransport: PluginWorkspaceTransport | null = null;

/** 桌面态由外壳注入 IPC 传输；传 null 恢复「无宿主即失败」。 */
export function setPluginWorkspaceTransportForHost(transport: PluginWorkspaceTransport | null): void {
  workspaceTransport = transport;
}

// ---------------------------------------------------------------------------
// 能力实现：workspace.read
// ---------------------------------------------------------------------------

const WORKSPACE_PATH_MAX_CHARS = 4096;

interface WorkspaceReadArgs {
  op: PluginWorkspaceOp;
  path?: string;
}

function isWorkspaceReadArgs(value: unknown): value is WorkspaceReadArgs {
  if (typeof value !== "object" || value === null) return false;
  const args = value as Record<string, unknown>;
  if (args.op !== "roots" && args.op !== "read") return false;
  if (args.op === "roots") return args.path === undefined;
  return typeof args.path === "string" && args.path.trim() !== "" && args.path.length <= WORKSPACE_PATH_MAX_CHARS;
}

const workspaceReadCapability: CapabilityDefinition = {
  id: "workspace.read",
  title: "读取工作区",
  description:
    "只读访问用户已授权的工作区：roots 列出授权根，read 读取根内文本文件（单次最多 256 KiB，超出截断；二进制/目录拒绝）。路径必须落在授权根内 —— 不会新建第二张白名单，也不能写。",
  danger: "high",
  async invoke(args, ctx) {
    if (!isWorkspaceReadArgs(args)) {
      throw new Error("workspace.read requires { op: roots|read, path? }");
    }
    const audit = (outcome: "ok" | "denied" | "error", detail: string): void => {
      ctx.audit({
        plugin: ctx.pluginId,
        capability: "workspace.read",
        at: new Date().toISOString(),
        outcome,
        detail: detail.slice(0, 200),
      });
    };
    if (!workspaceTransport) {
      audit("denied", "no host transport: workspace.read requires the desktop/server host");
      throw new Error("workspace.read requires a desktop or server host");
    }

    let response: PluginWorkspaceHostResponse;
    try {
      response = await workspaceTransport({
        pluginId: ctx.pluginId,
        op: args.op,
        path: args.op === "read" ? args.path : undefined,
      });
    } catch (error) {
      audit("error", `host: ${String(error).slice(0, 180)}`);
      throw error;
    }

    if (args.op === "roots") {
      const roots = response.roots ?? [];
      audit("ok", `roots (${roots.length})`);
      return { roots };
    }
    audit("ok", `read ${response.path ?? args.path}`);
    return {
      exists: !!response.exists,
      path: response.path ?? args.path ?? "",
      name: response.name ?? "",
      data: response.data ?? "",
      bytes: response.bytes ?? 0,
      truncated: !!response.truncated,
    };
  },
};

// ---------------------------------------------------------------------------
// notify 传输（系统通知是桌面专属；无宿主时调用失败并留 denied 审计）
// ---------------------------------------------------------------------------

/** 宿主侧（桌面壳 Rust `plugin_notify` 命令）返回的、已加归属前缀的最终文案。 */
export interface PluginNotifyHostResponse {
  title: string;
  body: string;
}

/**
 * notify 传输层：桌面态由外壳注入 IPC 代理（Rust 侧复核长度/控制字符并加
 * `[pluginId] ` 前缀，归属不可伪造）。无宿主（web 预览 / headless 服务端）时调用失败。
 */
export type PluginNotifyTransport = (request: { pluginId: string; title: string; body: string }) => Promise<PluginNotifyHostResponse>;

let notifyTransport: PluginNotifyTransport | null = null;

export function setPluginNotifyTransportForHost(transport: PluginNotifyTransport | null): void {
  notifyTransport = transport;
}

// ---------------------------------------------------------------------------
// 能力实现：notify
// ---------------------------------------------------------------------------

const NOTIFY_WINDOW_MS = 60_000;
const NOTIFY_MAX_CALLS_PER_WINDOW = 10;
const NOTIFY_TITLE_MAX_CHARS = 64;
const NOTIFY_BODY_MAX_CHARS = 240;

/** 每插件滑动窗口限速（module 级，应用单例）。 */
const notifyWindows = new Map<string, number[]>();

function takeNotifyToken(pluginId: string): boolean {
  const now = Date.now();
  const window = (notifyWindows.get(pluginId) ?? []).filter((ts) => now - ts < NOTIFY_WINDOW_MS);
  if (window.length >= NOTIFY_MAX_CALLS_PER_WINDOW) {
    notifyWindows.set(pluginId, window);
    return false;
  }
  window.push(now);
  notifyWindows.set(pluginId, window);
  return true;
}

/** 测试用：清空限速窗口（module 级单例，跨用例需复位）。 */
export function resetNotifyRateLimitForTest(): void {
  notifyWindows.clear();
}

interface NotifyArgs {
  title: string;
  body: string;
}

function isNotifyArgs(value: unknown): value is NotifyArgs {
  if (typeof value !== "object" || value === null) return false;
  const args = value as Record<string, unknown>;
  if (typeof args.title !== "string" || typeof args.body !== "string") return false;
  const title = args.title.trim();
  const body = args.body.trim();
  if (title === "" || body === "") return false;
  // 按 Unicode 码点计长，与 Rust 侧 `chars().count()` 口径一致。
  if ([...title].length > NOTIFY_TITLE_MAX_CHARS) return false;
  if ([...body].length > NOTIFY_BODY_MAX_CHARS) return false;
  // 控制字符会破坏通知布局：标题全禁，正文只放行换行（\n）。
  // 这里就是要匹配控制字符码点，正则本身必须含它们。
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(title)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(body)) return false;
  return true;
}

const notifyCapability: CapabilityDefinition = {
  id: "notify",
  title: "系统通知",
  description:
    "弹一条系统通知（标题带 `[插件 id]` 归属前缀，归属不可伪造）；每分钟最多 10 条；仅桌面端可用，窗口可见时宿主也可能改用 Toast。",
  danger: "low",
  async invoke(args, ctx) {
    if (!isNotifyArgs(args)) {
      throw new Error("notify requires { title, body } (non-empty strings; title ≤64 / body ≤240 chars, no control characters)");
    }
    const audit = (outcome: "ok" | "denied" | "error", detail: string): void => {
      ctx.audit({
        plugin: ctx.pluginId,
        capability: "notify",
        at: new Date().toISOString(),
        outcome,
        detail: detail.slice(0, 200),
      });
    };
    if (!notifyTransport) {
      audit("denied", "no host transport: notify requires the desktop host");
      throw new Error("notify requires the desktop host (system notifications are unavailable in the web preview)");
    }
    if (!takeNotifyToken(ctx.pluginId)) {
      audit("denied", `rate limit exceeded (${NOTIFY_MAX_CALLS_PER_WINDOW}/min)`);
      throw new Error(`notify rate limit exceeded (${NOTIFY_MAX_CALLS_PER_WINDOW} per minute)`);
    }
    try {
      const response = await notifyTransport({
        pluginId: ctx.pluginId,
        title: args.title.trim(),
        body: args.body.trim(),
      });
      audit("ok", response.title);
      return { sent: true, title: response.title, body: response.body };
    } catch (error) {
      audit("error", (error instanceof Error ? error.message : String(error)).slice(0, 200));
      throw error;
    }
  },
};

// ---------------------------------------------------------------------------
// llm.chat 传输（凭证永远在宿主侧；插件只传 prompt 与白名单内的模型）
// ---------------------------------------------------------------------------

/** 一次插件补全请求：模型已通过 manifest 白名单校验，system / prompt 已截断。 */
export interface PluginLlmChatRequest {
  pluginId: string;
  model: string;
  system?: string;
  prompt: string;
}

/** 宿主返回的正文（model 回显实际使用的模型，便于审计与调试）。 */
export interface PluginLlmChatResponse {
  text: string;
  model: string;
}

/**
 * llm.chat 传输层：由外壳注入。宿主侧按**当前设置**解析供应商（baseUrl / 密钥变量名），
 * 再走 `llm_chat_complete` 聚合式单轮补全 —— 插件既拿不到密钥，也改不了 baseUrl。
 * 无宿主（web 预览）时调用失败并记 denied 审计。
 */
export type PluginLlmChatTransport = (request: PluginLlmChatRequest) => Promise<PluginLlmChatResponse>;

let llmChatTransport: PluginLlmChatTransport | null = null;

export function setPluginLlmChatTransportForHost(transport: PluginLlmChatTransport | null): void {
  llmChatTransport = transport;
}

// ---------------------------------------------------------------------------
// 能力实现：llm.chat
// ---------------------------------------------------------------------------

/** 单次 prompt 上限：插件做的是摘要 / 分类 / 翻译，8 KiB 已远超一轮对话的合理输入。 */
const LLM_CHAT_PROMPT_MAX_CHARS = 8000;
const LLM_CHAT_SYSTEM_MAX_CHARS = 2000;
/** 限速：10 分钟 20 次（与 notify 同款滑动窗口，按插件隔离）。 */
const LLM_CHAT_WINDOW_MS = 10 * 60_000;
const LLM_CHAT_MAX_CALLS_PER_WINDOW = 20;

const llmChatWindows = new Map<string, number[]>();

function takeLlmChatToken(pluginId: string): boolean {
  const now = Date.now();
  const window = (llmChatWindows.get(pluginId) ?? []).filter((ts) => now - ts < LLM_CHAT_WINDOW_MS);
  if (window.length >= LLM_CHAT_MAX_CALLS_PER_WINDOW) {
    llmChatWindows.set(pluginId, window);
    return false;
  }
  window.push(now);
  llmChatWindows.set(pluginId, window);
  return true;
}

interface LlmChatArgs {
  prompt: string;
  system?: string;
  model?: string;
}

function isLlmChatArgs(value: unknown): value is LlmChatArgs {
  if (typeof value !== "object" || value === null) return false;
  const args = value as Record<string, unknown>;
  if (typeof args.prompt !== "string" || args.prompt.trim() === "") return false;
  if (args.prompt.length > LLM_CHAT_PROMPT_MAX_CHARS) return false;
  if (args.system !== undefined && (typeof args.system !== "string" || args.system.length > LLM_CHAT_SYSTEM_MAX_CHARS)) {
    return false;
  }
  if (args.model !== undefined && (typeof args.model !== "string" || args.model.trim() === "")) return false;
  return true;
}

const llmChatCapability: CapabilityDefinition = {
  id: "llm.chat",
  title: "调用模型",
  description:
    '一次单轮模型补全（摘要 / 分类 / 翻译这类「智能动作」）。凭证永远在宿主侧，插件只传 prompt 与可选 system；模型必须落在 manifest 声明的白名单内（`{ capability: "llm.chat", models: [...] }`），宿主按当前设置解析供应商 —— 插件拿不到 key、也改不了 baseUrl。单次 prompt ≤ 8 KiB，每插件 10 分钟最多 20 次。',
  danger: "high",
  async invoke(args, ctx) {
    const audit = (outcome: "ok" | "denied" | "error", detail: string): void => {
      ctx.audit({
        plugin: ctx.pluginId,
        capability: "llm.chat",
        at: new Date().toISOString(),
        outcome,
        detail: detail.slice(0, 200),
      });
    };
    if (!isLlmChatArgs(args)) {
      audit("denied", "invalid args (prompt / system / model shape)");
      throw new Error(`llm.chat requires { prompt: string ≤ ${LLM_CHAT_PROMPT_MAX_CHARS} chars, system?, model? }`);
    }
    // 白名单来自 manifest（安装期 Rust 侧已校验 1-8 条）：缺声明一律拒绝，不回落「不限模型」。
    const allowed = ctx.grant.models ?? [];
    if (!allowed.length) {
      audit("denied", "manifest declared no models allowlist");
      throw new Error("llm.chat requires a models allowlist in the plugin manifest");
    }
    const model = args.model?.trim() || allowed[0];
    if (!allowed.includes(model)) {
      audit("denied", `model not in allowlist: ${model}`);
      throw new Error(`llm.chat model not allowed: ${model} (allowed: ${allowed.join(", ")})`);
    }
    if (!llmChatTransport) {
      audit("denied", "no host transport: llm.chat requires the desktop/server host");
      throw new Error("llm.chat requires a desktop or server host");
    }
    if (!takeLlmChatToken(ctx.pluginId)) {
      audit("denied", `rate limit exceeded (${LLM_CHAT_MAX_CALLS_PER_WINDOW}/window)`);
      throw new Error(`llm.chat rate limit exceeded (${LLM_CHAT_MAX_CALLS_PER_WINDOW} per ${LLM_CHAT_WINDOW_MS / 60_000} minutes)`);
    }
    const system = args.system?.trim();
    try {
      const response = await llmChatTransport({
        pluginId: ctx.pluginId,
        model,
        system: system || undefined,
        prompt: args.prompt,
      });
      audit("ok", `${response.model} · ${response.text.length} chars`);
      return { text: response.text, model: response.model };
    } catch (error) {
      audit("error", (error instanceof Error ? error.message : String(error)).slice(0, 200));
      throw error;
    }
  },
};

// ---------------------------------------------------------------------------
// artifacts.publish 传输（产物面板；前端能力，浏览器态同样可用）
// ---------------------------------------------------------------------------

/** 一次产物发布请求：路径由能力层净化后给出，publisher 只负责落盘 + 登记卡片。 */
export interface PluginArtifactPublishRequest {
  pluginId: string;
  /** 展示名（已净化，≤120 字符）。 */
  name: string;
  /** VFS 路径（已限定在 plugins/<id>/ 下）。 */
  path: string;
  format: "md" | "html" | "csv";
  data: string;
}

/**
 * artifacts.publish 传输层：由外壳注入（产物面板是前端概念，web 预览同样可用）。
 * 宿主侧不需要新命令 —— 落盘走既有 `deliverArtifact`（VFS + 默认目录 + 事件广播）。
 */
export type PluginArtifactPublisher = (request: PluginArtifactPublishRequest) => Promise<{ id: string }>;

let artifactPublisher: PluginArtifactPublisher | null = null;

export function setPluginArtifactPublisher(publisher: PluginArtifactPublisher | null): void {
  artifactPublisher = publisher;
}

// ---------------------------------------------------------------------------
// 能力实现：artifacts.publish
// ---------------------------------------------------------------------------

/** 单份产物上限 256 KiB：产物面板是「看一眼」的地方，不是文件传输通道。 */
const ARTIFACT_MAX_BYTES = 256 * 1024;
const ARTIFACT_NAME_MAX_CHARS = 120;
/** 限速：10 分钟 20 次（产物会开预览 tab，刷屏比多占几 KB 更烦）。 */
const ARTIFACT_WINDOW_MS = 10 * 60_000;
const ARTIFACT_MAX_CALLS_PER_WINDOW = 20;
/** 允许发布的文本格式：二进制与「能执行的东西」一律不放行（html 由查看器去脚本渲染）。 */
const ARTIFACT_FORMATS = ["md", "html", "csv"] as const;
type ArtifactFormat = (typeof ARTIFACT_FORMATS)[number];

const artifactWindows = new Map<string, number[]>();

function takeArtifactToken(pluginId: string): boolean {
  const now = Date.now();
  const window = (artifactWindows.get(pluginId) ?? []).filter((ts) => now - ts < ARTIFACT_WINDOW_MS);
  if (window.length >= ARTIFACT_MAX_CALLS_PER_WINDOW) {
    artifactWindows.set(pluginId, window);
    return false;
  }
  window.push(now);
  artifactWindows.set(pluginId, window);
  return true;
}

interface ArtifactsPublishArgs {
  name: string;
  format: ArtifactFormat;
  data: string;
}

function isArtifactsPublishArgs(value: unknown): value is ArtifactsPublishArgs {
  if (typeof value !== "object" || value === null) return false;
  const args = value as Record<string, unknown>;
  if (typeof args.name !== "string" || args.name.trim() === "" || args.name.length > ARTIFACT_NAME_MAX_CHARS) {
    return false;
  }
  if (typeof args.format !== "string" || !ARTIFACT_FORMATS.includes(args.format as ArtifactFormat)) return false;
  return typeof args.data === "string" && args.data.length > 0 && args.data.length <= ARTIFACT_MAX_BYTES;
}

/**
 * 文件名净化：去路径分隔 / 控制字符 / 前后空白，并压掉连续点（防 `..` 段）。
 * 空结果回落到 "artifact" —— 宁可用默认名，也不让插件通过名字逃出 `plugins/<id>/`。
 */
function safeArtifactName(name: string): string {
  const cleaned = name
    .replace(/[/\\]/g, "_")
    .replace(/\p{Cc}/gu, "_")
    .replace(/\.{2,}/g, ".")
    .trim();
  return cleaned.slice(0, ARTIFACT_NAME_MAX_CHARS) || "artifact";
}

/** 插件 id 在 manifest 里已校验，这里再做一次「只留安全字符」的兜底。 */
function safePluginSegment(pluginId: string): string {
  const cleaned = pluginId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned || "plugin";
}

const artifactsPublishCapability: CapabilityDefinition = {
  id: "artifacts.publish",
  title: "发布产物",
  description:
    "把文本产物（md / html / csv）送进产物面板，用户可预览、下载、在文件夹中打开。落盘位置由宿主决定（VFS 的 plugins/<id>/ 下 + 当前工作区的 artifacts/ 目录），插件给的名字只用于展示；单份 ≤ 256 KiB，每插件 10 分钟最多 20 次。HTML 由查看器去脚本渲染（sandbox 不含 allow-scripts）。",
  danger: "medium",
  async invoke(args, ctx) {
    const audit = (outcome: "ok" | "denied" | "error", detail: string): void => {
      ctx.audit({
        plugin: ctx.pluginId,
        capability: "artifacts.publish",
        at: new Date().toISOString(),
        outcome,
        detail: detail.slice(0, 200),
      });
    };
    if (!isArtifactsPublishArgs(args)) {
      audit("denied", "invalid args (name / format / data shape)");
      throw new Error(
        `artifacts.publish requires { name: string ≤ ${ARTIFACT_NAME_MAX_CHARS} chars, format: ${ARTIFACT_FORMATS.join(" | ")}, data: string ≤ ${ARTIFACT_MAX_BYTES} bytes }`,
      );
    }
    if (!artifactPublisher) {
      audit("denied", "no artifact publisher: the workbench shell is not mounted");
      throw new Error("artifacts.publish requires the workbench shell");
    }
    if (!takeArtifactToken(ctx.pluginId)) {
      audit("denied", "rate limit exceeded");
      throw new Error(
        `artifacts.publish rate limit exceeded (${ARTIFACT_MAX_CALLS_PER_WINDOW} per ${ARTIFACT_WINDOW_MS / 60_000} minutes)`,
      );
    }
    const name = safeArtifactName(args.name.trim());
    const path = `plugins/${safePluginSegment(ctx.pluginId)}/${Date.now()}-${name.replace(/\s+/g, "-")}.${args.format}`;
    try {
      const { id } = await artifactPublisher({
        pluginId: ctx.pluginId,
        name,
        path,
        format: args.format,
        data: args.data,
      });
      audit("ok", `${args.format} · ${args.data.length} bytes · ${path}`);
      return { id, name, path, format: args.format };
    } catch (error) {
      audit("error", (error instanceof Error ? error.message : String(error)).slice(0, 200));
      throw error;
    }
  },
};

// ---------------------------------------------------------------------------
// clipboard 传输（宿主剪贴板桥：Electron 走主进程，浏览器态走 Web API）
// ---------------------------------------------------------------------------

/**
 * 剪贴板传输层：由外壳注入 `hostClipboard()` 门面（见 `@greywork/host-ipc`）。
 * 读剪贴板在浏览器态可能需要用户手势，失败按普通错误上抛（会记 error 审计）。
 */
export interface PluginClipboardTransport {
  writeText(text: string): Promise<void>;
  readText(): Promise<string>;
}

let clipboardTransport: PluginClipboardTransport | null = null;

export function setPluginClipboardTransportForHost(transport: PluginClipboardTransport | null): void {
  clipboardTransport = transport;
}

// ---------------------------------------------------------------------------
// 能力实现：clipboard
// ---------------------------------------------------------------------------

/** 单次写入 / 读取上限 64 KiB：剪贴板是「一段文本」的通道，不是文件传输。 */
const CLIPBOARD_MAX_CHARS = 64 * 1024;
/** 限速：1 分钟 20 次（写剪贴板会覆盖用户手上的内容，刷屏比多读几次更烦）。 */
const CLIPBOARD_WINDOW_MS = 60_000;
const CLIPBOARD_MAX_CALLS_PER_WINDOW = 20;
/** 缺省允许的操作：只写不读 —— 读剪贴板是隐私面，必须在 manifest 里显式声明 `ops`。 */
const CLIPBOARD_DEFAULT_OPS: readonly string[] = ["write"];

const clipboardWindows = new Map<string, number[]>();

function takeClipboardToken(pluginId: string): boolean {
  const now = Date.now();
  const window = (clipboardWindows.get(pluginId) ?? []).filter((ts) => now - ts < CLIPBOARD_WINDOW_MS);
  if (window.length >= CLIPBOARD_MAX_CALLS_PER_WINDOW) {
    clipboardWindows.set(pluginId, window);
    return false;
  }
  window.push(now);
  clipboardWindows.set(pluginId, window);
  return true;
}

type ClipboardArgs = { op: "write"; text: string } | { op: "read" };

function isClipboardArgs(value: unknown): value is ClipboardArgs {
  if (typeof value !== "object" || value === null) return false;
  const args = value as Record<string, unknown>;
  if (args.op === "read") return args.text === undefined;
  if (args.op !== "write") return false;
  return typeof args.text === "string" && args.text.length <= CLIPBOARD_MAX_CHARS;
}

const clipboardCapability: CapabilityDefinition = {
  id: "clipboard",
  title: "剪贴板",
  description:
    '写 / 读系统剪贴板。**写默认允许、读默认拒绝**：字符串形态的 `"clipboard"` 只给 write，要读必须在 manifest 里声明 `{ capability: "clipboard", ops: ["read"] }`（可加 write）。单次 ≤ 64 KiB，每插件 1 分钟最多 20 次；读取内容只记长度进审计，不落日志。',
  danger: "medium",
  async invoke(args, ctx) {
    const audit = (outcome: "ok" | "denied" | "error", detail: string): void => {
      ctx.audit({
        plugin: ctx.pluginId,
        capability: "clipboard",
        at: new Date().toISOString(),
        outcome,
        detail: detail.slice(0, 200),
      });
    };
    if (!isClipboardArgs(args)) {
      audit("denied", "invalid args (op: read|write, text for write)");
      throw new Error(`clipboard requires { op: "write", text ≤ ${CLIPBOARD_MAX_CHARS} chars } or { op: "read" }`);
    }
    const allowedOps = ctx.grant.ops?.length ? ctx.grant.ops : CLIPBOARD_DEFAULT_OPS;
    if (!allowedOps.includes(args.op)) {
      audit("denied", `op not granted: ${args.op} (granted: ${allowedOps.join(", ")})`);
      throw new Error(`clipboard op not granted: ${args.op} (declare { capability: "clipboard", ops: ["${args.op}"] } in the manifest)`);
    }
    if (!clipboardTransport) {
      audit("denied", "no clipboard transport: the host shell is not available");
      throw new Error("clipboard requires the host shell");
    }
    if (!takeClipboardToken(ctx.pluginId)) {
      audit("denied", "rate limit exceeded");
      throw new Error(`clipboard rate limit exceeded (${CLIPBOARD_MAX_CALLS_PER_WINDOW} per ${CLIPBOARD_WINDOW_MS / 60_000} minutes)`);
    }
    try {
      if (args.op === "write") {
        await clipboardTransport.writeText(args.text);
        audit("ok", `write · ${args.text.length} chars`);
        return { written: true };
      }
      const text = await clipboardTransport.readText();
      const truncated = text.length > CLIPBOARD_MAX_CHARS;
      // 只记长度：剪贴板内容可能含密码 / 私密文本，绝不进审计日志。
      audit("ok", `read · ${text.length} chars${truncated ? " (truncated)" : ""}`);
      return { text: truncated ? text.slice(0, CLIPBOARD_MAX_CHARS) : text, truncated };
    } catch (error) {
      audit("error", (error instanceof Error ? error.message : String(error)).slice(0, 200));
      throw error;
    }
  },
};

const scheduleCapability: CapabilityDefinition = {
  id: "schedule",
  title: "后台定时",
  description:
    '宿主按声明的间隔唤醒 worker 的 `registerSchedule` 处理器（`{ capability: "schedule", schedule: { kind: "interval", min } }`，5–1440 分钟）。仅在插件挂载面（区域页）存活时执行：不在内存时跳过，下次激活补触发一次；触发补丁与动作同路径合并进区域状态。注意这是宿主驱动的能力，worker 不应 `call("schedule", …)`。',
  danger: "low",
  async invoke(_args, _ctx) {
    throw new Error(
      "schedule is host-driven: register a handler with greywork.registerSchedule(handler) instead of calling the capability",
    );
  },
};

/** 已知能力目录：授权门禁与插件中心展示的单一事实源。 */
export const CAPABILITY_REGISTRY: Readonly<Record<string, CapabilityDefinition>> = {
  [netFetchCapability.id]: netFetchCapability,
  [storageKvCapability.id]: storageKvCapability,
  [fsScopedCapability.id]: fsScopedCapability,
  [workspaceReadCapability.id]: workspaceReadCapability,
  [llmChatCapability.id]: llmChatCapability,
  [artifactsPublishCapability.id]: artifactsPublishCapability,
  [clipboardCapability.id]: clipboardCapability,
  [notifyCapability.id]: notifyCapability,
  [scheduleCapability.id]: scheduleCapability,
  [pluginAdminCapability.id]: pluginAdminCapability,
  [floatingWindowCapability.id]: floatingWindowCapability,
};

/** 能力显示名：已知能力取目录 title，未知能力回退 id 本身。 */
export function capabilityTitle(id: string): string {
  return CAPABILITY_REGISTRY[id]?.title ?? id;
}
