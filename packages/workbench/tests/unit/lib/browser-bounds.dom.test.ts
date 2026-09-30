// 槽位几何与遮挡判定（lib/browser-bounds）。两个最容易错的点用例直接钉住：
// - 坐标口径：CSS px == Tauri 逻辑像素，量化 0.5px、夹到 ≥0，与宿主 sanitize_rect 同口径；
// - 常驻空壳容器（notice-host 等）有内容才算弹层，否则 webview 永远处于「被遮挡」态。
import { afterEach, describe, expect, it, vi } from "vitest";
import { isOverlayPresent, rectEquals, rectOf } from "@/lib/browser-bounds";

afterEach(() => {
  document.body.innerHTML = "";
});

/** 造一个 getBoundingClientRect 可控的元素（happy-dom 不做真实布局）。 */
function el(left: number, top: number, width: number, height: number): HTMLElement {
  const node = document.createElement("div");
  vi.spyOn(node, "getBoundingClientRect").mockReturnValue({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => undefined,
  } as DOMRect);
  return node;
}

describe("rectOf", () => {
  it("量化到 0.5px 网格", () => {
    expect(rectOf(el(10.3, 20.6, 300.4, 150.9))).toEqual({ x: 10.5, y: 20.5, width: 300.5, height: 151 });
  });

  it("负坐标夹到 0（槽位永远在窗口客户区内）", () => {
    expect(rectOf(el(-5, -0.4, 100, 50))).toEqual({ x: 0, y: 0, width: 100, height: 50 });
  });
});

describe("rectEquals", () => {
  const base = { x: 0, y: 0, width: 100, height: 100 };

  it("0.5px 容差内视为相等（省掉无意义的宿主往返）", () => {
    expect(rectEquals(base, { x: 0.4, y: 0, width: 100.5, height: 99.5 })).toBe(true);
  });

  it("任一维超出容差即不等", () => {
    expect(rectEquals(base, { x: 0.6, y: 0, width: 100, height: 100 })).toBe(false);
    expect(rectEquals(base, { x: 0, y: 0, width: 101, height: 100 })).toBe(false);
  });
});

describe("isOverlayPresent", () => {
  it("干净文档回 false", () => {
    expect(isOverlayPresent()).toBe(false);
  });

  it("常驻空壳容器不算弹层", () => {
    document.body.innerHTML = '<div data-testid="notice-host"></div><div data-testid="workspace-overlay-regions"></div>';
    expect(isOverlayPresent()).toBe(false);
  });

  it("空壳容器有了子元素才算弹层（文本节点不算）", () => {
    document.body.innerHTML = '<div data-testid="notice-host"><p>通知</p></div>';
    expect(isOverlayPresent()).toBe(true);

    document.body.innerHTML = '<div data-testid="workspace-overlay-regions">   </div>';
    expect(isOverlayPresent()).toBe(false);
  });

  it("role=dialog / reka popper 包装 / 权限卡命中", () => {
    for (const html of [
      '<div role="dialog"></div>',
      '<div role="alertdialog"></div>',
      '<div role="menu"></div>',
      '<div role="listbox"></div>',
      '<div role="tooltip"></div>',
      "<div data-reka-popper-content-wrapper></div>",
      '<div data-testid="permission-prompt-host"></div>',
    ]) {
      document.body.innerHTML = html;
      expect(isOverlayPresent(), html).toBe(true);
    }
  });
});
