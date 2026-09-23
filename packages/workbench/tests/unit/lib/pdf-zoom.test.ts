import { describe, expect, it } from "vitest";
import { PDF_MAX_ZOOM, PDF_MIN_ZOOM, clampPage, clampZoom, zoomBy } from "@/lib/pdf-zoom";

describe("pdf-zoom", () => {
  it("clampZoom 收敛到上下限", () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(100)).toBe(PDF_MAX_ZOOM);
    expect(clampZoom(0.001)).toBe(PDF_MIN_ZOOM);
    // 输入框给空串 → Number("") = 0，不该被当成「缩到最小」而应是回到适应宽度
    expect(clampZoom(Number.NaN)).toBe(1);
  });

  it("zoomBy 按档位增减且不越界", () => {
    expect(zoomBy(1, 1)).toBeCloseTo(1.25);
    expect(zoomBy(1, -1)).toBeCloseTo(0.8);
    expect(zoomBy(PDF_MAX_ZOOM, 1)).toBe(PDF_MAX_ZOOM);
    expect(zoomBy(PDF_MIN_ZOOM, -1)).toBe(PDF_MIN_ZOOM);
  });

  it("clampPage 收敛到 [1, total] 并取整", () => {
    expect(clampPage(3, 10)).toBe(3);
    expect(clampPage(0, 10)).toBe(1);
    expect(clampPage(99, 10)).toBe(10);
    expect(clampPage(2.6, 10)).toBe(3);
    // 文档还没解析出来（total = 0）时至少给 1，不能是 0
    expect(clampPage(5, 0)).toBe(1);
    expect(clampPage(Number.NaN, 10)).toBe(1);
  });
});
