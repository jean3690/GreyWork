/**
 * 分隔条拖拽（Pointer Events 全套）：非主键拒绝 / 指针捕获 / rAF 节流只交最后一帧 /
 * 兜底收尾（buttons 归零、pointercancel、lostpointercapture、blur）/ 拖拽期样式与监听的还原。
 *
 * `requestAnimationFrame` 用受控队列替代：节流语义是「一帧只交一次、只交最新」，用真实帧
 * 会让断言依赖主机帧率（CI 上时快时慢），受控队列则让每个分支都确定。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { mount, type VueWrapper } from "@vue/test-utils";

import { useResizableSplit, type ResizableSplitOptions } from "@/lib/resizable-split";

const raf = vi.hoisted(() => ({
  cb: null as null | (() => void),
  flush(): void {
    const cb = raf.cb;
    raf.cb = null;
    cb?.();
  },
}));

const ORIG = {
  setPointerCapture: HTMLElement.prototype.setPointerCapture,
  hasPointerCapture: HTMLElement.prototype.hasPointerCapture,
  releasePointerCapture: HTMLElement.prototype.releasePointerCapture,
};

function mountSplit(options: ResizableSplitOptions): { wrapper: VueWrapper; dragging: () => boolean } {
  let api: ReturnType<typeof useResizableSplit>;
  const wrapper = mount(
    defineComponent({
      setup() {
        api = useResizableSplit(options);
        return () => h("div", { "data-testid": "handle", onPointerdown: api.onPointerDown });
      },
    }),
  );
  return { wrapper, dragging: () => api.dragging.value };
}

function pointerDown(clientX: number, init: { button?: number; pointerId?: number; pointerType?: string } = {}): PointerEvent {
  return new PointerEvent("pointerdown", {
    clientX,
    button: init.button ?? 0,
    buttons: 1,
    pointerId: init.pointerId ?? 1,
    pointerType: init.pointerType ?? "mouse",
  });
}

function windowPointer(type: "pointermove" | "pointerup" | "pointercancel", clientX: number, buttons = 1): void {
  window.dispatchEvent(new PointerEvent(type, { clientX, buttons, pointerId: 1, pointerType: "mouse" }));
}

beforeEach(() => {
  raf.cb = null;
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => true);
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  vi.stubGlobal("requestAnimationFrame", ((cb: () => void) => {
    raf.cb = cb;
    return 1;
  }) as typeof requestAnimationFrame);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.style.userSelect = "";
  document.body.style.cursor = "";
  HTMLElement.prototype.setPointerCapture = ORIG.setPointerCapture;
  HTMLElement.prototype.hasPointerCapture = ORIG.hasPointerCapture;
  HTMLElement.prototype.releasePointerCapture = ORIG.releasePointerCapture;
});

describe("useResizableSplit", () => {
  it("非触控下非主键（中键/右键）按下不进拖拽，后续移动也不生效", () => {
    const onWidth = vi.fn();
    const { wrapper, dragging } = mountSplit({ width: () => 400, onWidth });

    wrapper.get('[data-testid="handle"]').element.dispatchEvent(pointerDown(100, { button: 2 }));
    windowPointer("pointermove", 300);

    expect(dragging()).toBe(false);
    expect(onWidth).not.toHaveBeenCalled();
  });

  it("按下即接管指针：捕获 pointerId、锁定 body 光标与文字选择", () => {
    const onWidth = vi.fn();
    const { wrapper, dragging } = mountSplit({ width: () => 400, onWidth });
    const handle = wrapper.get('[data-testid="handle"]');

    handle.element.dispatchEvent(pointerDown(100));

    expect(dragging()).toBe(true);
    expect(HTMLElement.prototype.setPointerCapture).toHaveBeenCalledWith(1);
    expect(document.body.style.userSelect).toBe("none");
    expect(document.body.style.cursor).toBe("col-resize");

    // 收尾清理，别把 body 样式泄漏给后面的用例。
    windowPointer("pointerup", 150);
    wrapper.unmount();
  });

  it("rAF 节流：同一帧内多次移动只交最后一次，且都是 commit=false", () => {
    const onWidth = vi.fn();
    const { wrapper, dragging } = mountSplit({ width: () => 400, onWidth });

    wrapper.get('[data-testid="handle"]').element.dispatchEvent(pointerDown(100));
    windowPointer("pointermove", 120);
    windowPointer("pointermove", 140);
    expect(onWidth).not.toHaveBeenCalled();

    raf.flush();
    expect(onWidth).toHaveBeenCalledTimes(1);
    expect(onWidth).toHaveBeenCalledWith(440, false);
    expect(dragging()).toBe(true);

    windowPointer("pointermove", 160);
    raf.flush();
    expect(onWidth).toHaveBeenLastCalledWith(460, false);
  });

  it("松手提交最终值（commit=true），并还原样式、释放监听与指针捕获", () => {
    const onWidth = vi.fn();
    const { wrapper, dragging } = mountSplit({ width: () => 400, onWidth });
    wrapper.get('[data-testid="handle"]').element.dispatchEvent(pointerDown(100));
    windowPointer("pointermove", 120);

    // 帧还没 flush 就松手：先交出 pending 过程值，再交最终值。
    windowPointer("pointerup", 150);

    expect(onWidth.mock.calls).toEqual([
      [420, false],
      [450, true],
    ]);
    expect(dragging()).toBe(false);
    expect(document.body.style.userSelect).toBe("");
    expect(document.body.style.cursor).toBe("");
    expect(HTMLElement.prototype.releasePointerCapture).toHaveBeenCalledWith(1);

    // 收尾后不再响应窗口上的移动。
    windowPointer("pointermove", 999);
    expect(onWidth).toHaveBeenCalledTimes(2);
  });

  it("reverse：把手在面板左边缘，向左拖 = 变宽", () => {
    const onWidth = vi.fn();
    const { wrapper } = mountSplit({ width: () => 400, onWidth, reverse: true });

    wrapper.get('[data-testid="handle"]').element.dispatchEvent(pointerDown(100));
    windowPointer("pointermove", 80);
    raf.flush();
    expect(onWidth).toHaveBeenCalledWith(420, false);

    windowPointer("pointerup", 60);
    expect(onWidth).toHaveBeenLastCalledWith(440, true);
  });

  it("移动中 buttons 归零（按键已在别处松开）→ 立即以该坐标收尾", () => {
    const onWidth = vi.fn();
    const { wrapper, dragging } = mountSplit({ width: () => 400, onWidth });

    wrapper.get('[data-testid="handle"]').element.dispatchEvent(pointerDown(100));
    windowPointer("pointermove", 150, 0);

    expect(dragging()).toBe(false);
    expect(onWidth.mock.calls).toEqual([[450, true]]);

    windowPointer("pointermove", 999, 1);
    expect(onWidth).toHaveBeenCalledTimes(1);
  });

  it("pointercancel / lostpointercapture / blur：无坐标收尾，用最后一次已交的值提交", () => {
    const onWidthA = vi.fn();
    const { wrapper: a } = mountSplit({ width: () => 400, onWidth: onWidthA });
    a.get('[data-testid="handle"]').element.dispatchEvent(pointerDown(100));
    windowPointer("pointermove", 120);
    windowPointer("pointercancel", 200);
    expect(onWidthA.mock.calls).toEqual([
      [420, false],
      [420, true],
    ]);

    const onWidthB = vi.fn();
    const { wrapper: b } = mountSplit({ width: () => 400, onWidth: onWidthB });
    b.get('[data-testid="handle"]').element.dispatchEvent(pointerDown(100));
    windowPointer("pointermove", 120);
    raf.flush();
    b.get('[data-testid="handle"]').element.dispatchEvent(new Event("lostpointercapture"));
    expect(onWidthB.mock.calls.at(-1)).toEqual([420, true]);

    const onWidthC = vi.fn();
    const { wrapper: c } = mountSplit({ width: () => 400, onWidth: onWidthC });
    c.get('[data-testid="handle"]').element.dispatchEvent(pointerDown(100));
    windowPointer("pointermove", 120);
    window.dispatchEvent(new Event("blur"));
    expect(onWidthC.mock.calls.at(-1)).toEqual([420, true]);
  });

  it("拖拽中组件卸载：还原样式、解除拖拽态，窗口监听随之拆除", () => {
    const onWidth = vi.fn();
    const { wrapper, dragging } = mountSplit({ width: () => 400, onWidth });

    wrapper.get('[data-testid="handle"]').element.dispatchEvent(pointerDown(100));
    windowPointer("pointermove", 120);
    wrapper.unmount();

    expect(dragging()).toBe(false);
    expect(document.body.style.userSelect).toBe("");
    expect(document.body.style.cursor).toBe("");
    windowPointer("pointermove", 500);
    expect(onWidth).not.toHaveBeenCalled();
  });
});
