/**
 * 运行时两态判定：server（宿主托管：Electron 壳 / 自托管服务端）/ browser-preview（无宿主）。
 *
 * 判定顺序（`runtimeMode()` 每次实时计算，不缓存结果）：
 *   1. `window.__GREYWORK_RUNTIME__` 显式覆盖（测试与调试用）；
 *   2. `initRuntimeMode()` 写下的探测结果 → server / browser-preview。
 *
 * 为什么实时判定而不是在 `initRuntimeMode()` 里一次定死：渲染端有大量守卫在组件求值期
 * 同步调用 `runtimeMode()`，它们的求值时机可能早于或晚于入口的探测；缓存会让后置的
 * 覆盖（测试 / 调试）失效。
 */
export type RuntimeMode = "server" | "browser-preview";

/** 显式覆盖键：置为合法 RuntimeMode 即生效，优先于一切探测。 */
const OVERRIDE_KEY = "__GREYWORK_RUNTIME__";

/** 探测结果（探测成功后写入）。 */
let probed: RuntimeMode | null = null;

/**
 * `/api/health` 里报出的宿主版本（服务端态才有）。
 *
 * 与 `probed` 同一时机写入：探测是渲染端唯一一次读 `/api/health` body 的机会，
 * 顺手留下版本，省掉「关于」卡与更新检查再发一次请求。
 */
let probedVersion: string | null = null;

/**
 * 浏览器预览态下使用宿主能力（命令或事件）时的错误。
 *
 * 刻意**抛错而不是静默降级**：静默 no-op 会让上层
 * 以为订阅成功、命令执行成功，把问题藏到更难排查的地方（见 llm 的 LlmUnavailableError）。
 */
export class HostUnavailableError extends Error {
  constructor(what: string) {
    super(`${what} 不可用：当前为浏览器预览态，没有宿主`);
    this.name = "HostUnavailableError";
  }
}

function readOverride(): RuntimeMode | null {
  if (typeof window === "undefined") return null;
  const value = (window as unknown as Record<string, unknown>)[OVERRIDE_KEY];
  return value === "server" || value === "browser-preview" ? value : null;
}

/** 当前运行时；同步、实时，可在任意组件求值期调用。 */
export function runtimeMode(): RuntimeMode {
  const override = readOverride();
  if (override) return override;
  return probed ?? "browser-preview";
}

/** 宿主命令是否可用（Electron 壳与自托管服务端都有宿主，浏览器预览没有）。 */
export function hasHostCommands(): boolean {
  return runtimeMode() !== "browser-preview";
}

/**
 * 宿主版本号；拿不到时为 `null`。
 *
 * 取自 `/api/health` 的 `version` 字段（`initRuntimeMode()` 探测时留存）。
 * Electron 壳的版本另有 `hostApp().version()`（读壳自己的 package.json）。
 */
export function hostVersion(): string | null {
  return runtimeMode() === "server" ? probedVersion : null;
}

/**
 * 解析运行时并缓存探测结果。只在入口 bootstrap 里 await 一次。
 *
 * 显式覆盖是零 I/O；无覆盖时才探测同源 `/api/health` —— 能应答就说明这份渲染端由
 * 服务端托管。探测失败（离线、静态托管）落到 browser-preview。
 */
export async function initRuntimeMode(): Promise<RuntimeMode> {
  const override = readOverride();
  if (override) {
    probed = override;
    return override;
  }
  const health = await probeServer();
  probedVersion = health?.version ?? null;
  probed = health ? "server" : "browser-preview";
  return probed;
}

/** `/api/health` 里我们关心的部分。 */
interface HealthProbe {
  version: string | null;
}

/**
 * 探测同源 `/api/health`。能应答就说明这份渲染端由服务端托管。
 *
 * 保留 body 里的 `version`（而非只看 `ok`）：这是渲染端拿到宿主版本最省事的一次机会。
 * 版本解析失败不影响判定 —— 探测的目的是「有没有服务端」，不是「服务端是什么版本」。
 */
async function probeServer(): Promise<HealthProbe | null> {
  try {
    const response = await fetch("/api/health", { credentials: "same-origin" });
    if (!response.ok) return null;
    const body: unknown = await response.json().catch(() => null);
    const version =
      body && typeof body === "object" && typeof (body as { version?: unknown }).version === "string"
        ? (body as { version: string }).version
        : null;
    return { version };
  } catch {
    return null;
  }
}
