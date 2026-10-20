/**
 * 「当前是哪个前端」的运行时身份。
 *
 * 与 `runtime.ts` 的运行时模式（server / browser-preview）是**两条正交的轴**，别合并：
 * - 运行时模式回答「这个宿主能不能执行命令」（能力面，看有没有服务端在应答）；
 * - 前端身份回答「这是哪一端」（形态面：桌面 / Web / 移动 / CLI）。
 *
 * 同一个 server 运行时可以同时托管 Web 端与桌面端（S3 之后每端一个 base、同一份
 * `greywork-server`），所以后者推不出前者 —— 两个请求打进来，`runtimeMode()` 都是
 * `"server"`，只有 `frontId()` 不同。
 *
 * 判定顺序与 `runtimeMode()` 同构（都是实时计算、不缓存）：
 *   1. `window.__GREYWORK_FRONT__` 显式覆盖（测试 / 调试 / e2e 注入）；
 *   2. `declareFront()` 写下的声明。
 * 两者都没有时返回 `null` —— **「未知」不等于「是某一端」**。这里刻意不猜一个缺省：
 * 猜错了等于给第三方前端一个错误的身份，而它多半会拿这个身份去做分支。
 * 调用方自己决定缺省（诊断就报「未声明」）。
 *
 * 为什么不在 `runtime.ts` 里：`frontContext()` 要读 `shell.ts` 的 `hasNativeShell()`，
 * 而 `shell.ts` 已经 import 了 `runtime.ts` —— 放那边就成环。这里只单向依赖两者。
 */
import { hasHostCommands, runtimeMode, type RuntimeMode } from "./runtime";
import { hasNativeShell } from "./shell";

/** 已知前端。加一端要同时改这里与 `packages/workbench/src/front/` 的组装。 */
export type FrontId = "desktop" | "web" | "mobile" | "cli";

/** 显式覆盖键：置为合法 FrontId 即生效，优先于 `declareFront()`。 */
const OVERRIDE_KEY = "__GREYWORK_FRONT__";

/** 合法取值表。同时供覆盖值的**校验**用 —— 覆盖键来自 window，可能是任何东西。 */
const FRONT_IDS: readonly FrontId[] = ["desktop", "web", "mobile", "cli"];

/** `declareFront()` 写下的声明。 */
let declared: FrontId | null = null;

function isFrontId(value: unknown): value is FrontId {
  return typeof value === "string" && FRONT_IDS.includes(value as FrontId);
}

function readOverride(): FrontId | null {
  if (typeof window === "undefined") return null;
  const value = (window as unknown as Record<string, unknown>)[OVERRIDE_KEY];
  return isFrontId(value) ? value : null;
}

/**
 * 声明本端身份。前端入口在 mount 之前调用一次。
 *
 * 基于 workbench 的前端不必单独调它：`setFront(spec)` 会带上 `spec.id`（见
 * `packages/workbench/src/front/current.ts`）—— 「我是哪一端」与「我装哪些特性」
 * 是同一处声明，叫前端作者写两遍迟早对不上。这个函数留给**不经 workbench 的前端**
 * （S5 的 CLI/TUI、第三方前端），它们只消费传输层、没有 FrontSpec 可交。
 */
export function declareFront(id: FrontId): void {
  declared = id;
}

/**
 * 当前前端身份；无人声明且无覆盖时为 `null`。
 *
 * 与 `runtimeMode()` 同一个理由**实时读、不缓存**：调用点大多是组件求值期或纯函数内的
 * 同步读取，缓存会让入口的声明（或测试 / e2e 的覆盖）失效。
 */
export function frontId(): FrontId | null {
  return readOverride() ?? declared;
}

/** 四个分散探针的一次快照。字段语义见各自的原函数，这里不做任何加工。 */
export interface FrontContext {
  /** 未声明 / 未覆盖时为 null（见 `frontId()`）。 */
  frontId: FrontId | null;
  /** 运行时模式：有没有服务端在应答（见 `runtime.ts`）。 */
  runtimeMode: RuntimeMode;
  /** 是否有原生桌面壳（Electron）。**22 条 `desktop_only` 的守卫看它**，不是 `hasHostCommands`。 */
  isNativeShell: boolean;
  /** 宿主命令是否可用（Electron 与自托管服务端都 true，浏览器预览 false）。 */
  hasHostCommands: boolean;
}

/**
 * 把「我是哪一端 + 这个宿主能做什么」收成**一次读取**。
 *
 * 存在的意义是排查：今天这四个探针散在 runtime.ts / shell.ts 两个文件、由调用方自己
 * 拼，日志里只零散出现其中一两个，「Web 端为什么灰着导出按钮」这类问题要先猜再看。
 * 注意它只是一次快照、不做缓存 —— 需要响应式的调用方仍该直接调原函数。
 */
export function frontContext(): FrontContext {
  return {
    frontId: frontId(),
    runtimeMode: runtimeMode(),
    isNativeShell: hasNativeShell(),
    hasHostCommands: hasHostCommands(),
  };
}
