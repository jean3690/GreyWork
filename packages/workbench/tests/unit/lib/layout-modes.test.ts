/**
 * 布局模式的纯逻辑：四组合的命名与快捷键映射。
 *
 * 「每种组合都有名字」这条要守住 —— 模式是用来拨面板的，漏掉一个组合就会出现
 * 按了快捷键却只拨动一半（左栏收起了、右栏没动）的情况。
 */
import { describe, expect, it } from "vitest";
import { LAYOUT_MODES, modeOfShortcut, visibilityOf, type PanelVisibility } from "@/lib/layout-modes";

describe("visibilityOf", () => {
  it.each([
    ["split", true, true],
    ["chat", true, false],
    ["document", false, true],
    ["focus", false, false],
  ] as const)("%s → 左栏 %s / 右栏 %s", (mode, sidebar, preview) => {
    expect(visibilityOf(mode)).toEqual({ sidebar, preview });
  });

  it("四种组合互不相同（否则某个快捷键等于白按）", () => {
    const seen = new Set(LAYOUT_MODES.map((mode) => JSON.stringify(visibilityOf(mode))));
    expect(seen.size).toBe(LAYOUT_MODES.length);
    expect(LAYOUT_MODES.length).toBe(4);
  });
});

describe("modeOfShortcut", () => {
  it.each([
    ["Digit1", "split"],
    ["Digit2", "chat"],
    ["Digit3", "document"],
    ["Digit4", "focus"],
  ] as const)("%s → %s", (code, mode) => {
    expect(modeOfShortcut(code)).toBe(mode);
  });

  it("按物理键位匹配，所以 AZERTY 上按数字行也能命中", () => {
    // 那些布局下 event.key 会是 '&' 之类的符号，但 code 仍是 Digit1
    expect(modeOfShortcut("Digit1")).toBe("split");
  });

  it("超出范围或无关的键位返回 null", () => {
    expect(modeOfShortcut("Digit5")).toBeNull();
    expect(modeOfShortcut("Digit0")).toBeNull();
    expect(modeOfShortcut("KeyB")).toBeNull();
    expect(modeOfShortcut("")).toBeNull();
  });

  it("每个模式都能被某个快捷键命中（表与模式的完整性）", () => {
    const reachable = new Set(["Digit1", "Digit2", "Digit3", "Digit4"].map((code) => modeOfShortcut(code)));
    expect(reachable.size).toBe(LAYOUT_MODES.length);
    for (const mode of LAYOUT_MODES) expect(reachable.has(mode)).toBe(true);
  });
});

describe("PanelVisibility 的可读性", () => {
  it("focus 是两个都收起（专注），split 是两个都在（三栏）", () => {
    const focus: PanelVisibility = visibilityOf("focus");
    const split: PanelVisibility = visibilityOf("split");
    expect(focus).toEqual({ sidebar: false, preview: false });
    expect(split).toEqual({ sidebar: true, preview: true });
  });
});
