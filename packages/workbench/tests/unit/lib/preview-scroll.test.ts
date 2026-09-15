/**
 * 预览滚动位置备忘：切 tab 会销毁重建 viewer，位置挂在这两张模块级 Map 上。
 *
 * 语义里最容易踩的两点：
 * - **0 是有效值**（「滚回顶部」是状态，不记就会还原成旧位置），所以不能用 truthy 判断存取；
 * - **非法值不能污染**（负偏移 / NaN / 0 页），旧值要原样保留而不是被覆盖成垃圾。
 */
import { describe, expect, it } from "vitest";
import { recallPdfProgress, recallPixelScroll, rememberPdfProgress, rememberPixelScroll } from "@/lib/preview-scroll";

describe("preview-scroll · 像素偏移（DOM 类 viewer）", () => {
  it("记过就能原样取回", () => {
    rememberPixelScroll("px-roundtrip", 1234);
    expect(recallPixelScroll("px-roundtrip")).toBe(1234);
  });

  it("0 是有效状态：滚回顶部之后要能还原成顶部，而不是旧位置", () => {
    rememberPixelScroll("px-zero", 800);
    rememberPixelScroll("px-zero", 0);
    expect(recallPixelScroll("px-zero")).toBe(0);
  });

  it("没记过返回 null —— 调用方据此决定动不动滚动条", () => {
    expect(recallPixelScroll("px-never")).toBeNull();
  });

  it("非法偏移（负 / NaN / Infinity）不写入，且不清掉已有的旧值", () => {
    rememberPixelScroll("px-invalid", 500);
    rememberPixelScroll("px-invalid", -1);
    rememberPixelScroll("px-invalid", Number.NaN);
    rememberPixelScroll("px-invalid", Number.POSITIVE_INFINITY);
    expect(recallPixelScroll("px-invalid")).toBe(500);
  });

  it("容量上限 100：最旧的被丢，最新的还在", () => {
    // 不依赖前序用例的存量 —— 插满并溢出后，只断言「首条已淘汰 / 末条仍在」。
    for (let i = 0; i < 150; i += 1) rememberPixelScroll(`px-evict-${i}`, i + 1);
    expect(recallPixelScroll("px-evict-0")).toBeNull();
    expect(recallPixelScroll("px-evict-149")).toBe(150);
  });
});

describe("preview-scroll · PDF 进度（渐进渲染）", () => {
  it("页数与偏移一起存取", () => {
    rememberPdfProgress("pdf-roundtrip", { pages: 7, top: 900 });
    expect(recallPdfProgress("pdf-roundtrip")).toEqual({ pages: 7, top: 900 });
  });

  it("页数取整：非整数页数没有意义", () => {
    rememberPdfProgress("pdf-floor", { pages: 4.9, top: 12 });
    expect(recallPdfProgress("pdf-floor")?.pages).toBe(4);
  });

  it("0 页不写入 —— 一页都没渲染出来的条目没有还原意义", () => {
    rememberPdfProgress("pdf-zeropages", { pages: 0, top: 100 });
    expect(recallPdfProgress("pdf-zeropages")).toBeNull();
  });

  it("负页数不写入", () => {
    rememberPdfProgress("pdf-negpages", { pages: -3, top: 100 });
    expect(recallPdfProgress("pdf-negpages")).toBeNull();
  });

  it("非法偏移不写入，已有的旧值原样保留", () => {
    rememberPdfProgress("pdf-badtop", { pages: 5, top: 200 });
    rememberPdfProgress("pdf-badtop", { pages: 9, top: -5 });
    rememberPdfProgress("pdf-badtop", { pages: 9, top: Number.NaN });
    expect(recallPdfProgress("pdf-badtop")).toEqual({ pages: 5, top: 200 });
  });

  it("没记过返回 null", () => {
    expect(recallPdfProgress("pdf-never")).toBeNull();
  });

  it("存的是快照而非引用：调用方之后改对象不会污染备忘", () => {
    const progress = { pages: 3, top: 30 };
    rememberPdfProgress("pdf-copy", progress);
    progress.pages = 99;
    progress.top = 999;
    expect(recallPdfProgress("pdf-copy")).toEqual({ pages: 3, top: 30 });
  });

  it("取回的也是副本：改它不影响下一次取回", () => {
    rememberPdfProgress("pdf-copy2", { pages: 2, top: 20 });
    const first = recallPdfProgress("pdf-copy2");
    if (first) first.top = 777;
    expect(recallPdfProgress("pdf-copy2")).toEqual({ pages: 2, top: 20 });
  });
});
