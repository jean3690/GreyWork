import { describe, expect, it } from "vitest";

import { placeWindow, type WorkArea } from "../src/shared/window-placement";

const PRIMARY: WorkArea = { x: 0, y: 0, width: 1920, height: 1080 };
const SECONDARY: WorkArea = { x: 1920, y: 0, width: 1280, height: 1024 };

describe("窗口位置恢复", () => {
  it("没有保存坐标时保持居中语义", () => {
    expect(placeWindow({ width: 1280, height: 820, maximized: false }, [PRIMARY])).toEqual({
      width: 1280,
      height: 820,
      maximized: false,
    });
  });

  it("仍在工作区内时原样使用", () => {
    expect(placeWindow({ x: 100, y: 80, width: 1280, height: 820, maximized: false }, [PRIMARY])).toEqual({
      x: 100,
      y: 80,
      width: 1280,
      height: 820,
      maximized: false,
    });
  });

  it("落在副屏时也保留（只要与任一工作区重叠）", () => {
    const state = { x: 2000, y: 100, width: 1000, height: 700, maximized: false };
    expect(placeWindow(state, [PRIMARY, SECONDARY])).toEqual(state);
  });

  it("拔掉副屏后坐标越界 → 丢掉 x/y 交给主屏居中", () => {
    const placed = placeWindow({ x: 2200, y: 100, width: 1000, height: 700, maximized: true }, [PRIMARY]);
    expect(placed.x).toBeUndefined();
    expect(placed.y).toBeUndefined();
    expect(placed).toMatchObject({ width: 1000, height: 700, maximized: true });
  });

  it("只露出标题栏一部分仍算可见（用户可能故意贴边）", () => {
    // 窗口左侧在屏幕外，但右侧还有 200px、顶部露出 100px。
    const placed = placeWindow({ x: -1080, y: 20, width: 1280, height: 820, maximized: false }, [PRIMARY]);
    expect(placed.x).toBe(-1080);
    expect(placed.y).toBe(20);
  });

  it("宽高夹到最大工作区尺寸", () => {
    const placed = placeWindow({ x: 0, y: 0, width: 5000, height: 4000, maximized: false }, [PRIMARY, SECONDARY]);
    expect(placed.width).toBe(1920);
    expect(placed.height).toBe(1080);
  });

  it("拿不到工作区信息时原样返回", () => {
    const state = { x: -999, y: -999, width: 1280, height: 820, maximized: false };
    expect(placeWindow(state, [])).toEqual(state);
  });
});
