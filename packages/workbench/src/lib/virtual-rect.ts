/**
 * 虚拟化视口测量的包装：丢弃 0×0 的读数。
 *
 * 为什么需要：virtual-core 的 `observeElementRect` 在滚动元素挂上的那一刻会**同步**用
 * `getBoundingClientRect` 报一次尺寸。元素尚未布局时（首帧、或被 `v-if` 延迟挂载、
 * 或所在面板此刻 display:none）读到的就是 0×0，而这个 0 会覆盖 `initialRect` ——
 * 可视范围随即算成空集，整列渲染不出来。之后 ResizeObserver 只在尺寸**变化**时再报，
 * 若一直没变化就永远停在 0。无布局环境（happy-dom 单测）则始终是 0。
 *
 * 丢弃 0 是安全的：0 不携带"视口很小"的信息，只表示"还没量出来"，此时保留上一次读数
 * （或 `initialRect`）给出更好的首帧；真实尺寸到达时 ResizeObserver 会正常覆盖。
 *
 * 这里把滚动元素类型固定成 `HTMLElement`（本仓三处虚拟化都用 HTMLElement 容器）：写成
 * 泛型 `<T extends Element>` 会让 `useVirtualizer` 的 `TScrollElement` 推导不出来而报逆变错误，
 * 而直接照抄 `Parameters<typeof observeElementRect>[0]` 又会把 T 固定成 `Element`，同样对不上。
 */
import { observeElementRect, type Rect, type Virtualizer } from "@tanstack/vue-virtual";

export function observeNonZeroRect(instance: Virtualizer<HTMLElement, Element>, cb: (rect: Rect) => void): (() => void) | undefined {
  return observeElementRect(instance, (rect) => {
    if (rect.width === 0 && rect.height === 0) return;
    cb(rect);
  });
}
