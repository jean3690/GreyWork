// 弹出面板方向决策契约：下方装不下且上方更宽裕才向上弹；两侧都不够时取更宽的一侧。
import { describe, expect, it } from "vitest";
import { shouldAlignLeft, shouldOpenUp } from "@/lib/panel-placement";

/** 720 高视口 + 24 高胶囊；anchorTop 决定胶囊在视口里的纵向位置。 */
function space(anchorTop: number, panelHeight: number) {
  return { anchorTop, anchorBottom: anchorTop + 24, viewportHeight: 720, panelHeight };
}

describe("shouldOpenUp", () => {
  it("下方净空够装 → 保持向下", () => {
    expect(shouldOpenUp(space(80, 150))).toBe(false);
  });

  it("贴底（输入卡底栏）→ 向上弹", () => {
    expect(shouldOpenUp(space(660, 150))).toBe(true);
  });

  it("贴顶且下方不够 → 仍向下（上方比下方更窄）", () => {
    expect(shouldOpenUp(space(0, 900))).toBe(false);
  });

  it("上下都装不下 → 取更宽的一侧", () => {
    // 胶囊略偏下：below=304 < 400，above=368 更宽 → 翻转
    expect(shouldOpenUp(space(380, 400))).toBe(true);
    // 胶囊略偏上：below=384 更宽 → 不翻转
    expect(shouldOpenUp(space(300, 400))).toBe(false);
  });

  it("面板越高越容易翻转（同一位置按估算高决策）", () => {
    expect(shouldOpenUp(space(400, 120))).toBe(false); // below=284 装得下 120
    expect(shouldOpenUp(space(400, 320))).toBe(true); // 同位置 320 装不下 → 翻转
  });
});

describe("shouldAlignLeft", () => {
  it("右对齐会越过主区左边界时改为左对齐", () => {
    expect(shouldAlignLeft(340, 200, 248)).toBe(true);
  });

  it("右对齐仍在主区内时保持右对齐", () => {
    expect(shouldAlignLeft(700, 340, 248)).toBe(false);
  });
});
