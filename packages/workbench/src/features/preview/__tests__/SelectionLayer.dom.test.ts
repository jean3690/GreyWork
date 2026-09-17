/**
 * 划词层的集成契约。
 *
 * **测试基建**：happy-dom 没有布局引擎，`Range.getBoundingClientRect()` 与
 * `offsetWidth/Height` 恒为全零，也没法用鼠标真的划出一段选区。所以这里手工造一个
 * 带非零矩形的 Range 并 stub `window.getSelection`。几何本身另有纯函数用例
 * （`selection-geometry.test.ts`）覆盖，这里只验行为。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import SelectionLayer from "@/features/preview/SelectionLayer.vue";
import { appEvents } from "@/events";
import { i18n } from "@/i18n";
import { registerChatReceiver, resetChatReceiversForTest } from "@/lib/chat-receiver";
import type { PreviewTab } from "@/stores/preview";

const TAB: PreviewTab = { id: "t1", path: "notes/a.md", name: "a.md", kind: "md", source: "vfs", revision: 0 };

function rect(): DOMRect {
  return {
    left: 100,
    top: 200,
    width: 80,
    height: 18,
    right: 180,
    bottom: 218,
    x: 100,
    y: 200,
    toJSON: () => ({}),
  } as DOMRect;
}

interface Harness {
  root: HTMLElement;
  wrapper: ReturnType<typeof mount>;
}

function setupDom(): { root: HTMLElement; unit: HTMLElement } {
  document.body.innerHTML = "";
  const root = document.createElement("div");
  root.innerHTML = `<div data-selection-scope><p id="unit">选中的文字</p></div>`;
  document.body.appendChild(root);
  return { root, unit: root.querySelector<HTMLElement>("#unit")! };
}

function stubSelection(node: Element | null, text: string): void {
  if (!node) {
    vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: true,
      rangeCount: 0,
      toString: () => "",
      removeAllRanges: () => undefined,
    } as unknown as Selection);
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(node);
  range.getBoundingClientRect = rect;
  range.getClientRects = () => [] as unknown as DOMRectList;
  vi.spyOn(window, "getSelection").mockReturnValue({
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: () => range,
    toString: () => text,
    removeAllRanges: () => undefined,
  } as unknown as Selection);
}

async function mountLayer(root: HTMLElement): Promise<Harness> {
  const wrapper = mount(SelectionLayer, {
    props: { tab: TAB, root },
    attachTo: document.body,
    global: { plugins: [i18n] },
  });
  await flushPromises();
  return { root, wrapper };
}

/** 触发一次选区变化并等到浮层渲染完成（层用 rAF 合并了 selectionchange）。 */
async function selectAndSettle(): Promise<void> {
  document.dispatchEvent(new Event("selectionchange"));
  await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  await flushPromises();
  await nextTick();
  await flushPromises();
}

function toolbar(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="selection-toolbar"]');
}

beforeEach(() => {
  resetChatReceiversForTest();
  vi.restoreAllMocks();
});

afterEach(() => {
  appEvents.clear();
  vi.restoreAllMocks();
});

describe("SelectionLayer", () => {
  it("作用域内选中非空文字 → 弹出浮层，三个动作齐全", async () => {
    const { root, unit } = setupDom();
    await mountLayer(root);
    stubSelection(unit, "选中的文字");
    await selectAndSettle();

    const bar = toolbar();
    expect(bar).not.toBeNull();
    expect(bar!.querySelector('[data-testid="selection-action-ask"]')).not.toBeNull();
    expect(bar!.querySelector('[data-testid="selection-action-explain"]')).not.toBeNull();
    expect(bar!.querySelector('[data-testid="selection-action-rewrite"]')).not.toBeNull();
  });

  it("选区落在作用域之外（例如消息列表里）不弹浮层", async () => {
    const { root } = setupDom();
    const outside = document.createElement("p");
    outside.textContent = "别的区域的文字";
    document.body.appendChild(outside);

    await mountLayer(root);
    stubSelection(outside, "别的区域的文字");
    await selectAndSettle();

    expect(toolbar()).toBeNull();
  });

  it("选区折叠（只是点了一下）不弹浮层", async () => {
    const { root } = setupDom();
    await mountLayer(root);
    stubSelection(null, "");
    await selectAndSettle();

    expect(toolbar()).toBeNull();
  });

  it("浮层上的 mousedown 被阻止默认行为 —— 否则按下按钮会先清空选区", async () => {
    const { root, unit } = setupDom();
    await mountLayer(root);
    stubSelection(unit, "选中的文字");
    await selectAndSettle();

    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    toolbar()!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("Esc 收起浮层", async () => {
    const { root, unit } = setupDom();
    await mountLayer(root);
    stubSelection(unit, "选中的文字");
    await selectAndSettle();
    expect(toolbar()).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await nextTick();
    expect(toolbar()).toBeNull();
  });

  it("滚动时收起浮层（滚动监听必须 capture，容器不冒泡）", async () => {
    const { root, unit } = setupDom();
    await mountLayer(root);
    stubSelection(unit, "选中的文字");
    await selectAndSettle();
    expect(toolbar()).not.toBeNull();

    document.dispatchEvent(new Event("scroll"));
    await nextTick();
    expect(toolbar()).toBeNull();
  });

  it("没有接收方：按钮禁用 + 给出原因，且点击不发射任何事件", async () => {
    const { root, unit } = setupDom();
    const attached: unknown[] = [];
    const prefilled: unknown[] = [];
    appEvents.on("chat:attachText", (payload) => attached.push(payload));
    appEvents.on("chat:prefill", (payload) => prefilled.push(payload));

    await mountLayer(root);
    stubSelection(unit, "选中的文字");
    await selectAndSettle();

    const ask = toolbar()!.querySelector<HTMLButtonElement>('[data-testid="selection-action-ask"]')!;
    expect(ask.disabled).toBe(true);
    expect(toolbar()!.querySelector('[data-testid="selection-toolbar-disabled"]')).not.toBeNull();

    ask.click();
    await flushPromises();
    expect(attached).toHaveLength(0);
    expect(prefilled).toHaveLength(0);
  });

  it("有接收方：点击同时发射附件与预填两个事件，并收起浮层", async () => {
    const unregister = registerChatReceiver();
    const { root, unit } = setupDom();
    const attached: { name: string; text: string }[] = [];
    const prefilled: { text: string; mode?: string }[] = [];
    appEvents.on("chat:attachText", (payload) => attached.push(payload));
    appEvents.on("chat:prefill", (payload) => prefilled.push(payload));

    await mountLayer(root);
    stubSelection(unit, "选中的文字");
    await selectAndSettle();

    const ask = toolbar()!.querySelector<HTMLButtonElement>('[data-testid="selection-action-ask"]')!;
    expect(ask.disabled).toBe(false);
    ask.click();
    await flushPromises();
    await nextTick();

    expect(attached).toHaveLength(1);
    expect(attached[0].text).toContain("选中的文字");
    expect(attached[0].name).toContain("a.md");
    expect(prefilled).toHaveLength(1);
    expect(prefilled[0].mode).toBe("append");
    expect(toolbar()).toBeNull();

    unregister();
  });

  it("按下按钮时选区被引擎折叠：浮层不能被拆掉，click 仍要生效", async () => {
    const unregister = registerChatReceiver();
    const { root, unit } = setupDom();
    const prefilled: unknown[] = [];
    appEvents.on("chat:prefill", (payload) => prefilled.push(payload));

    await mountLayer(root);
    stubSelection(unit, "选中的文字");
    await selectAndSettle();

    const ask = toolbar()!.querySelector<HTMLButtonElement>('[data-testid="selection-action-ask"]')!;

    // 真实交互顺序是 pointerdown → mousedown → click，而不是直接 click()
    ask.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
    ask.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

    // 模拟某些引擎在按下时把选区折叠掉：若此时照常 hide()，
    // 浮层会在 click 之前从 DOM 里消失，按钮就永远点不动。
    stubSelection(null, "");
    document.dispatchEvent(new Event("selectionchange"));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    await flushPromises();
    expect(toolbar()).not.toBeNull();

    ask.click();
    await flushPromises();
    expect(prefilled).toHaveLength(1);

    document.dispatchEvent(new Event("pointerup", { bubbles: true }));
    unregister();
  });

  it("重建后不残留上一份文档的浮层，也不捡挂载前就存在的选区", async () => {
    const { root, unit } = setupDom();
    const first = await mountLayer(root);
    stubSelection(unit, "选中的文字");
    await selectAndSettle();
    expect(toolbar()).not.toBeNull();

    // 切 tab 的真实机制是 PreviewSurface 的 :key="tab.id" → 本层卸载再挂新实例。
    first.wrapper.unmount();
    await nextTick();
    expect(toolbar()).toBeNull();

    // 快照必须是组件局部状态：新实例不该把挂载前就存在的选区当成自己的。
    // 只有 selectionchange 才触发捕获。
    await mountLayer(root);
    await flushPromises();
    expect(toolbar()).toBeNull();
  });
});
