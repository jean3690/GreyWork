/**
 * 设备性能分级：低内存 / 少核设备上主动降级，避免 WebView 渲染卡顿与崩溃。
 *
 * 动机：本项目是 Tauri + Vue 桌面应用，WebView 在低内存设备上最容易出两类问题 ——
 * 一是初始化/切视图时内存峰值触发 swap 或激进 GC，主线程卡死；二是持续动画、离屏渲染
 * 与大量 DOM 让 GPU/合成器跟不上。这两类问题都无法靠单点优化解决，需要在**已知设备弱**
 * 的前提下，把"默认就省"作为基线（关动效、降虚拟化开销、减批渲染页数）。
 *
 * 判定来源分两层，取"更悲观"的结果：
 *  1. 渲染端同步探测：`navigator.deviceMemory`（Chromium 系，单位 GiB，会被钳到 8）、
 *     `navigator.hardwareConcurrency`。**WebKitGTK 没有 deviceMemory** —— 也就是 Linux
 *     桌面态只能拿到核数，所以必须有第二层。
 *  2. 宿主快照（异步补齐）：Rust `sys_info` 的 `totalMemoryBytes` / `cpuCount`。宿主读的是
 *     真实物理内存与逻辑核数，比渲染端可靠，且能覆盖 WebKitGTK。
 *
 * 单调性：一旦判为 low 就不再回到 standard。两层信息先后到达，若允许回退，首帧后的
 * 一次降级→升级会让 `data-perf` 抖动，动效与虚拟化参数跟着来回切，反而制造卡顿。
 *
 * 为什么用模块级 ref 而不是 Pinia store：判定要在 `createPinia()` 之前就落地（首帧 CSS
 * 就得吃到 `data-perf`），那时还没有 active pinia。与 `host-platform.ts` 的 hostOs 同理。
 */

import { ref } from "vue";

/** 性能档位。`low` 表示已启用降级基线。 */
export type DeviceTier = "low" | "standard";

/** 判低端的物理内存阈值（GiB）：文章面向「内存通常小于 4GB（甚至 1GB）」的设备。 */
const LOW_MEMORY_GIB = 4;

/** 判低端的逻辑核数阈值：2 核及以下直接按低端处理。 */
const LOW_CORES = 2;

/** 当前档位。`standard` 是乐观默认 —— 拿不到任何信号时不该无端降级体验。 */
export const deviceTier = ref<DeviceTier>("standard");

/** 渲染端同步探测：拿不到信号返回 null，交由宿主快照或默认值决定。 */
function probeRenderer(): DeviceTier | null {
  if (typeof navigator === "undefined") return null;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const cores = navigator.hardwareConcurrency;
  let low = false;
  let known = false;
  if (typeof memory === "number" && memory > 0) {
    known = true;
    if (memory <= LOW_MEMORY_GIB) low = true;
  }
  if (typeof cores === "number" && cores > 0) {
    known = true;
    if (cores <= LOW_CORES) low = true;
  }
  if (!known) return null;
  return low ? "low" : "standard";
}

/** 把档位写到 DOM：CSS 侧所有降级规则都挂在 `[data-perf="low"]` 下。 */
function applyToDom(tier: DeviceTier): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.perf = tier;
}

/** 只在"升级到 low"时落地，保证单调性（见文件头说明）。 */
function raiseTo(tier: DeviceTier): void {
  if (tier === "low" && deviceTier.value !== "low") {
    deviceTier.value = "low";
    applyToDom("low");
  }
}

/**
 * 首帧前的同步初始化：只用渲染端信号。
 *
 * 必须在 `app.mount()` 之前调用 —— 晚一帧就意味着首帧动画与首屏虚拟列表已按 standard
 * 渲染过一遍，低端机上那次开销正是要避免的。
 */
export function initDeviceTier(): void {
  const probed = probeRenderer();
  if (probed === "low") raiseTo("low");
  // standard 也写一次：显式落 `data-perf` 而不是依赖 CSS 缺省，便于排查"到底判成了哪档"。
  else applyToDom(deviceTier.value);
}

/**
 * 用宿主快照校正。`totalMemoryBytes` 为字节，`cpuCount` 为逻辑核数；缺字段就跳过该项。
 * 宿主信息晚于首帧到达是正常的，这里只做单向升级。
 */
export function refineDeviceTierFromHost(info: { totalMemoryBytes?: number | null; cpuCount?: number | null }): void {
  const bytes = info.totalMemoryBytes;
  if (typeof bytes === "number" && bytes > 0 && bytes <= LOW_MEMORY_GIB * 1024 ** 3) {
    raiseTo("low");
    return;
  }
  const cores = info.cpuCount;
  if (typeof cores === "number" && cores > 0 && cores <= LOW_CORES) raiseTo("low");
}
