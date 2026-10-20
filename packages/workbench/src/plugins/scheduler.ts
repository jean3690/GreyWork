import { createJsonStorage } from "@greywork/core";
import type { ManifestScheduleDeclaration } from "./capabilities";
import type { DeclarativeValue } from "./market-types";

/**
 * schedule 能力的工作台侧宿主持调度器（纯 TS 引擎，与 Vue 解耦）。
 *
 * 语义（roadmap「宿主持调度器」落地形态——代码插件的宿主即工作台渲染进程，worker 由
 * 工作台持有）：
 * - 声明：manifest `requires: [{ capability: "schedule", schedule: { kind: "interval", min } }]`
 *   （安装期 Rust 校验形态与 5–1440 分钟边界）；
 * - 授权：区域挂载面在「声明 + 已授权」时才挂钟（`effectiveRegionSchedule`），
 *   未授权不挂钟 = 宿主不执行任何定时唤醒；
 * - 执行：挂载面存活期间每隔 everyMin 分钟唤醒 worker 的 registerSchedule 处理器
 *   （复用 invoke 通道，补丁同路径合并进区域状态并持久化）；
 * - 离线补结算：不在内存时跳过（nextDue 推进仅发生在触发时），下次挂载若已过期
 *   立即补触发一次，再重置到下一周期起点——沿用 pet 的离线结算思路。
 *
 * nextDue 持久化在 localStorage（`greywork.plugins.schedule.due`），键
 * `${pluginId}/region/${regionId}`，epoch ms。
 */

/** schedule 间隔边界（与 Rust `SCHEDULE_MIN_MIN`/`SCHEDULE_MAX_MIN` 一致）。 */
export const SCHEDULE_MIN_MIN = 5;
export const SCHEDULE_MAX_MIN = 24 * 60;

export interface DeclaredSchedule {
  everyMin: number;
}

type GrantSpec = string | { capability: string; hosts?: string[]; schedule?: ManifestScheduleDeclaration };

/** 从 requires 里解析 schedule 声明；形态不符或越界返回 null（Rust 安装期已拦，这里只管得住）。 */
export function declaredScheduleOf(requires: readonly GrantSpec[] | undefined): DeclaredSchedule | null {
  for (const spec of requires ?? []) {
    if (typeof spec === "string" || spec.capability !== "schedule") continue;
    const schedule = spec.schedule;
    if (!schedule || schedule.kind !== "interval") return null;
    if (!Number.isInteger(schedule.min) || schedule.min < SCHEDULE_MIN_MIN || schedule.min > SCHEDULE_MAX_MIN) {
      return null;
    }
    return { everyMin: schedule.min };
  }
  return null;
}

/** 授权门禁：声明 + 已授权才生效（未授权 = 宿主不挂钟、不执行任何定时唤醒）。 */
export function effectiveRegionSchedule(
  manifest: { requires?: readonly GrantSpec[] },
  granted: (capability: string) => boolean,
): DeclaredSchedule | null {
  const declared = declaredScheduleOf(manifest.requires);
  return declared && granted("schedule") ? declared : null;
}

/** 挂钟：一个插件-区域挂载面在宿主侧的定时契约。 */
export interface ScheduledClock {
  pluginId: string;
  regionId: string;
  everyMin: number;
  /** 当前区域状态快照（传给处理器）。 */
  state: () => Readonly<Record<string, DeclarativeValue>>;
  /** 处理器返回的补丁全量合并进区域状态（与动作同路径）。 */
  applyPatch: (patch: Record<string, DeclarativeValue>) => void;
  /**
   * 唤醒调用：等价于区域动作的 invoke（内部校验 isPatch）。
   * 处理器名为保留的 `"schedule"`。
   */
  invoke: (handler: string, state: Readonly<Record<string, DeclarativeValue>>) => Promise<Record<string, DeclarativeValue> | void>;
}

function clockKey(pluginId: string, regionId: string): string {
  return `${pluginId}/region/${regionId}`;
}

const dueStorage = createJsonStorage<Record<string, number>>(
  "greywork.plugins.schedule.due",
  (value): value is Record<string, number> => typeof value === "object" && value !== null && !Array.isArray(value),
);

const clocks = new Map<string, ScheduledClock>();
const running = new Set<string>();

/** 轮询周期：挂钟存活时每 30s 校一次（到点误差 ≤30s，对 5 分钟起步的间隔足够）。 */
const POLL_MS = 30_000;
let pollInterval: ReturnType<typeof setInterval> | null = null;

function readDue(): Record<string, number> {
  return dueStorage.read() ?? {};
}

function ensurePollLoop(): void {
  if (pollInterval === null) {
    pollInterval = setInterval(() => {
      void runScheduledChecks();
    }, POLL_MS);
  }
}

function stopPollLoopIfIdle(): void {
  if (clocks.size === 0 && pollInterval !== null) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

/**
 * 挂载面挂钟：挂载即校对（离线补结算——拖过期立刻补一次并重置到下一周期起点），
 * 之后由轮询/手动 `runScheduledChecks` 按周期触发。同一插件-区域只挂一只钟。
 */
export async function attachScheduledClock(clock: ScheduledClock, nowMs = Date.now()): Promise<void> {
  const key = clockKey(clock.pluginId, clock.regionId);
  if (clocks.has(key)) return;
  clocks.set(key, clock);
  ensurePollLoop();
  const due = readDue();
  const existing = due[key];
  if (existing === undefined) {
    // 首次挂载：排定首轮到期（不写则永不到期）。
    due[key] = nowMs + clock.everyMin * 60_000;
    dueStorage.write(due);
  } else if (existing <= nowMs) {
    // 补结算：过期立即补触发一次，随后重置到「当前时间 + 周期」。
    due[key] = await fireClock(key, clock, nowMs);
    dueStorage.write(due);
  }
}

export function detachScheduledClock(pluginId: string, regionId: string): void {
  const key = clockKey(pluginId, regionId);
  clocks.delete(key);
  running.delete(key);
  stopPollLoopIfIdle();
}

/** 轮询到点校验：触发所有到期挂钟并推进 nextDue；正在运行的跳帧（不重入）。 */
export async function runScheduledChecks(nowMs = Date.now()): Promise<void> {
  const due = readDue();
  let changed = false;
  for (const [key, clock] of [...clocks.entries()]) {
    const nextDue = due[key];
    if (nextDue === undefined || nextDue > nowMs) continue;
    due[key] = await fireClock(key, clock, nowMs);
    changed = true;
  }
  if (changed) dueStorage.write(due);
}

/** 读某挂钟当前记录的 nextDue（未挂钟或从未排期为 undefined）。 */
export function nextDueFor(pluginId: string, regionId: string): number | undefined {
  return readDue()[clockKey(pluginId, regionId)];
}

/** 触发一次；返回下一周期到期时间。依赖未就绪（worker 崩溃/超时）也推进，避免每 tick 空转。 */
async function fireClock(key: string, clock: ScheduledClock, nowMs: number): Promise<number> {
  if (running.has(key)) return nowMs + clock.everyMin * 60_000;
  running.add(key);
  try {
    const patch = await clock.invoke("schedule", Object.freeze({ ...clock.state() }));
    if (patch) clock.applyPatch(patch);
  } catch {
    // 唤醒失败不抛：定时是旁路行为，绝不影响主流程。
  } finally {
    running.delete(key);
  }
  return nowMs + clock.everyMin * 60_000;
}

/** 测试用：清空挂钟、运行态与持久化排期（module 级单例，跨用例需复位）。 */
export function resetSchedulerForTest(): void {
  try {
    dueStorage.write({});
  } catch {
    // 无 localStorage（node 平坦环境）时忽略；单测注入的 storage 总可用。
  }
  clocks.clear();
  running.clear();
  if (pollInterval !== null) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

/** 供测试断言：当前是否有挂钟。 */
export function scheduledClockCount(): number {
  return clocks.size;
}
