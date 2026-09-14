/**
 * PDF 文本层的布局数学与 span 构建。
 *
 * 这套换算没写好不会报错，只会让选中位置整体偏掉 —— 而偏移在测试里看不出来（没布局引擎），
 * 所以这里逐项钉死坐标关系：矩阵乘法、ascent 换算、旋转、拉伸比。`measure` 由外部注入，
 * 因为 happy-dom 的 `getContext("2d")` 返回 null。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildTextLayer,
  computeStretch,
  DEFAULT_ASCENT,
  layoutTextItem,
  layoutTextItems,
  multiplyMatrix,
  type PdfTextItemLike,
} from "@/lib/pdf-text-layer";

/** 缩放 2 倍的视口矩阵。 */
const SCALE2 = [2, 0, 0, 2, 0, 0];
const IDENTITY = [1, 0, 0, 1, 0, 0];

function item(overrides: Partial<PdfTextItemLike> = {}): PdfTextItemLike {
  return { str: "文字", width: 50, transform: [1, 0, 0, 1, 10, 20], ...overrides };
}

describe("multiplyMatrix", () => {
  it("单位矩阵相乘不变", () => {
    expect(multiplyMatrix(IDENTITY, IDENTITY)).toEqual(IDENTITY);
  });

  it("平移量与缩放量分别累加", () => {
    // 缩放 2 倍后，子矩阵的平移 (3,4) 也被放大成 (6,8)
    expect(multiplyMatrix([2, 0, 0, 2, 0, 0], [1, 0, 0, 1, 3, 4])).toEqual([2, 0, 0, 2, 6, 8]);
  });
});

describe("layoutTextItem", () => {
  it("水平文字：位置取矩阵平移量，top 按 ascent 让到顶边", () => {
    const piece = layoutTextItem(item(), SCALE2);

    expect(piece).not.toBeNull();
    expect(piece!.fontSize).toBe(2); // 矩阵里的 y 缩放
    expect(piece!.angle).toBe(0);
    expect(piece!.left).toBe(20); // 10 × 2
    expect(piece!.top).toBe(40 - DEFAULT_ASCENT * 2); // 基线 20 × 2 再往上让
    expect(piece!.targetWidth).toBe(100); // 文本宽度 50 × 视口缩放 2
    expect(piece!.text).toBe("文字");
  });

  it("旋转文字：让的方向跟着转，否则斜排文字会整体偏出去", () => {
    // 90° 旋转：矩阵 [0,1,-1,0,...]
    const piece = layoutTextItem({ str: "x", width: 10, transform: [0, 1, -1, 0, 0, 0] }, IDENTITY);

    expect(piece!.fontSize).toBe(1);
    expect(piece!.angle).toBeCloseTo(Math.PI / 2, 6);
    expect(piece!.left).toBeCloseTo(DEFAULT_ASCENT, 6);
    expect(piece!.top).toBeCloseTo(0, 6);
  });

  it.each<[string, PdfTextItemLike]>([
    ["空串", { str: "", width: 10, transform: [1, 0, 0, 1, 0, 0] }],
    ["标记项（没有 str）", { width: 0, transform: [1, 0, 0, 1, 0, 0] }],
    ["缺 transform", { str: "x", width: 10 }],
    ["transform 长度不足", { str: "x", width: 10, transform: [1, 0, 0] }],
    ["零字号", { str: "x", width: 10, transform: [0, 0, 0, 0, 5, 5] }],
  ])("%s 不产出 span", (_label, input) => {
    expect(layoutTextItem(input, IDENTITY)).toBeNull();
  });

  it("视口矩阵非法（NaN）时也不产出", () => {
    expect(layoutTextItem(item(), [NaN, 0, 0, 1, 0, 0])).toBeNull();
  });

  it("缺 width 时 targetWidth 为 0，交给 computeStretch 退化为不拉伸", () => {
    const piece = layoutTextItem({ str: "x", transform: [1, 0, 0, 1, 0, 0] }, IDENTITY);
    expect(piece!.targetWidth).toBe(0);
    expect(computeStretch(piece!.targetWidth, 12)).toBe(1);
  });
});

describe("layoutTextItems", () => {
  it("跳过标记项与空串，只留真正有字的", () => {
    const pieces = layoutTextItems(
      [{ type: "beginMarkedContent" }, item({ str: "第一段" }), item({ str: "" }), item({ str: "第二段" })],
      IDENTITY,
    );
    expect(pieces.map((piece) => piece.text)).toEqual(["第一段", "第二段"]);
  });
});

describe("computeStretch", () => {
  it("按目标宽度与实际量宽之比拉伸", () => {
    expect(computeStretch(100, 80)).toBe(1.25);
    expect(computeStretch(50, 50)).toBe(1);
  });

  it("量不到宽度或宽度不合理时退化为 1（宁可不拉伸，也别拉成一条线）", () => {
    expect(computeStretch(100, 0)).toBe(1);
    expect(computeStretch(100, -5)).toBe(1);
    expect(computeStretch(100, NaN)).toBe(1);
    expect(computeStretch(0, 80)).toBe(1);
  });
});

describe("buildTextLayer", () => {
  let layer: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    layer = document.createElement("div");
    document.body.appendChild(layer);
  });

  const noMeasure = () => 0;

  it("每个文字项一个 span，样式用 px", () => {
    buildTextLayer(layer, layoutTextItems([item()], SCALE2), noMeasure);

    const spans = layer.querySelectorAll("span");
    expect(spans).toHaveLength(1);
    expect(spans[0].textContent).toBe("文字");
    expect(spans[0].style.left).toBe("20px");
    expect(spans[0].style.top).toBe(`${40 - DEFAULT_ASCENT * 2}px`);
    expect(spans[0].style.fontSize).toBe("2px");
  });

  it("水平且不需要拉伸时不写 transform", () => {
    buildTextLayer(layer, [layoutTextItem(item(), SCALE2)!], noMeasure);
    expect(layer.querySelector("span")!.style.transform).toBe("");
  });

  it("需要拉伸时写 scaleX", () => {
    buildTextLayer(layer, [layoutTextItem(item(), SCALE2)!], () => 80);
    expect(layer.querySelector("span")!.style.transform).toContain("scaleX(1.25)");
  });

  it("旋转项带上 rotate，且与 scaleX 同时存在", () => {
    const piece = layoutTextItem({ str: "x", width: 10, transform: [0, 1, -1, 0, 0, 0] }, IDENTITY)!;
    buildTextLayer(layer, [piece], () => 5);

    const transform = layer.querySelector("span")!.style.transform;
    expect(transform).toContain("rotate(");
    expect(transform).toContain("scaleX(");
  });

  it("重复构建时替换而不是追加（切页复用同一个容器）", () => {
    buildTextLayer(layer, layoutTextItems([item()], SCALE2), noMeasure);
    buildTextLayer(layer, layoutTextItems([item({ str: "新页" })], SCALE2), noMeasure);

    expect(layer.querySelectorAll("span")).toHaveLength(1);
    expect(layer.querySelector("span")!.textContent).toBe("新页");
  });

  it("空列表清空容器", () => {
    buildTextLayer(layer, layoutTextItems([item()], SCALE2), noMeasure);
    buildTextLayer(layer, [], noMeasure);
    expect(layer.querySelectorAll("span")).toHaveLength(0);
  });
});
