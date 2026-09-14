<script setup lang="ts">
/**
 * 预览划词层：监听选区 → 快照 → 弹工具条 → 注入对话。
 *
 * 三个关键决定：
 *
 * 1. **在 `selectionchange` 时快照 `{ text, unit, rect }`，不在 click handler 里读选区。**
 *    即使工具条阻止了 mousedown 的默认行为，某些引擎仍会在焦点或布局变化时折叠选区；
 *    等到点击那一刻再读，结果就是「按钮点了没反应」或「附上去是空的」。
 *
 * 2. **作用域用 `data-selection-scope` 惰性解析，不追组件根。** `DocxBlocks` 是 fragment
 *    没有根元素，`DocViewer` 的根又是面板外壳（会把「共 N 页」也圈进来）。惰性解析顺带
 *    绕开异步 viewer 的时序问题 —— 内容不存在时本来也不会有选区。
 *
 * 3. **滚动监听要 `capture`。** 各 viewer 的滚动容器是 `overflow-y-auto`，scroll 事件
 *    不冒泡到 document，普通监听收不到。
 *
 * pptx 的 `scale()` / `rotate()` 不需要特殊处理：全程用 `getBoundingClientRect()`
 * （已是变换后的视口坐标）配合 fixed 定位；用 offsetTop + 滚动量算反而会算错。
 */
import { onBeforeUnmount, onMounted, ref } from "vue";
import SelectionToolbar from "./SelectionToolbar.vue";
import { resolveSemanticUnit, type AnchorRect, type SemanticUnit } from "../../lib/selection";
import { injectSelectionIntoChat, selectionPrompt, type SelectionAction } from "../../lib/selection-injection";
import { chatReceiverAvailable } from "../../lib/chat-receiver";
import type { PreviewTab } from "../../stores/preview";

const props = defineProps<{ tab: PreviewTab; root: HTMLElement | null }>();

interface SelectionSnapshot {
  text: string;
  unit: SemanticUnit;
  scope: Element;
  rect: AnchorRect;
}

const snapshot = ref<SelectionSnapshot | null>(null);
const available = chatReceiverAvailable;
/** 指针正压在工具条上：此窗口内不因选区折叠而收起（见 capture）。 */
let pressingToolbar = false;

function resolveScope(): Element | null {
  const root = props.root;
  if (!root) return null;
  return root.querySelector("[data-selection-scope]") ?? root;
}

function hide(): void {
  snapshot.value = null;
}

/** 选区的锚定矩形。`getBoundingClientRect` 在跨行/折叠等场景下可能是全零，退回逐行矩形。 */
function anchorRectOf(range: Range): AnchorRect | null {
  const box = range.getBoundingClientRect();
  if (box.width > 0 || box.height > 0) {
    return { left: box.left, top: box.top, width: box.width, height: box.height };
  }
  const rects = range.getClientRects();
  const last = rects.length > 0 ? rects[rects.length - 1] : null;
  if (last && (last.width > 0 || last.height > 0)) {
    return { left: last.left, top: last.top, width: last.width, height: last.height };
  }
  return null;
}

function capture(): void {
  // 正在按工具条：忽略这段窗口里的选区变化。
  // 按下按钮时浏览器可能清空选区 → selectionchange 触发 → 这里若照常 hide()，
  // 浮层会在 click 之前被拆掉，按钮就永远点不动了。快照在按下之前已经取好，不受影响。
  if (pressingToolbar) return;

  const scope = resolveScope();
  const selection = window.getSelection();
  if (!scope || !selection || selection.isCollapsed || selection.rangeCount === 0) {
    hide();
    return;
  }
  const range = selection.getRangeAt(0);
  if (!scope.contains(range.commonAncestorContainer)) {
    hide();
    return;
  }
  const text = selection.toString().trim();
  if (!text) {
    hide();
    return;
  }
  const rect = anchorRectOf(range);
  if (!rect) {
    hide();
    return;
  }

  // 起止落在不同语义块里就无从归属单一单元，回落 block。
  // 但 location 保留 startUnit 的 —— 跨段选择时页码/区块信息依然成立，丢掉就白给了。
  const startUnit = resolveSemanticUnit(range.startContainer, scope);
  const endUnit = resolveSemanticUnit(range.endContainer, scope);
  const unit: SemanticUnit =
    startUnit.element && endUnit.element && startUnit.element !== endUnit.element
      ? { ...startUnit, role: "block", level: null, listLevel: null, element: null }
      : startUnit;

  snapshot.value = { text, unit, scope, rect };
}

/** selectionchange 每次按键都会触发，用 rAF 合并成每帧一次。 */
let frame = 0;
function onSelectionChange(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    capture();
  });
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") hide();
}

/**
 * 点浮层以外的地方就收起 —— 用捕获阶段，这样在滚动容器内部点击也能收到。
 * 点浮层自身时（含按钮）不收起，否则按钮还没触发 click 就被拆掉了。
 * 这里靠 DOM 属性判断而非组件 ref：浮层是 teleport 出去的，组件 ref 拿不到元素。
 */
function onDocumentPointerDown(event: PointerEvent): void {
  const target = event.target;
  if (target instanceof Element && target.closest('[data-testid="selection-toolbar"]')) {
    pressingToolbar = true;
    return;
  }
  hide();
}

/** 松开即恢复；不依赖 click 是怕按钮被 disabled 时收不到 click 而把标记永久留下。 */
function onDocumentPointerUp(): void {
  pressingToolbar = false;
}

function run(action: SelectionAction): void {
  const current = snapshot.value;
  if (!current) return;
  // 无接收方时 inject 返回 false 且不发任何事件。按钮此时也是 disabled ——
  // 这一层是防「UI 那层漏挂 disabled」的第二道闸。
  injectSelectionIntoChat(selectionPrompt(action), {
    selectionText: current.text,
    unit: current.unit,
    scope: current.scope,
    sourceName: props.tab.name,
  });
  window.getSelection()?.removeAllRanges();
  hide();
}

onMounted(() => {
  document.addEventListener("selectionchange", onSelectionChange);
  // capture 必需：viewer 的 overflow-y-auto 滚动容器不冒泡 scroll。
  document.addEventListener("scroll", hide, { capture: true, passive: true });
  document.addEventListener("pointerdown", onDocumentPointerDown, true);
  document.addEventListener("pointerup", onDocumentPointerUp, true);
  document.addEventListener("keydown", onKeydown);
  window.addEventListener("resize", hide);
});

onBeforeUnmount(() => {
  if (frame) cancelAnimationFrame(frame);
  document.removeEventListener("selectionchange", onSelectionChange);
  document.removeEventListener("scroll", hide, { capture: true });
  document.removeEventListener("pointerdown", onDocumentPointerDown, true);
  document.removeEventListener("pointerup", onDocumentPointerUp, true);
  document.removeEventListener("keydown", onKeydown);
  window.removeEventListener("resize", hide);
});
</script>

<template>
  <SelectionToolbar v-if="snapshot" :anchor="snapshot.rect" :available="available" @select="run" />
</template>
