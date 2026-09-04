import { describe, expect, it } from "vitest";
import { ICONS, getIconShapes, iconNames } from "@/lib/icons";

describe("GreyWork 图标形状表", () => {
  it("登记所有外壳引用到的图标名", () => {
    expect(ICONS).toMatchObject({
      plus: expect.anything(),
      search: expect.anything(),
      sidebar: expect.anything(),
      robot: expect.anything(),
      "alarm-clock": expect.anything(),
      setting: expect.anything(),
      sun: expect.anything(),
      moon: expect.anything(),
      "send-one": expect.anything(),
      right: expect.anything(),
      "arrow-left": expect.anything(),
    });
  });

  it("每个图标至少有一个形状", () => {
    for (const name of iconNames()) {
      expect(ICONS[name].length).toBeGreaterThan(0);
    }
  });

  it("形状只允许 path/line/circle/rect 四种", () => {
    for (const shapes of Object.values(ICONS)) {
      for (const shape of shapes) {
        expect(["path", "line", "circle", "rect"]).toContain(shape.kind);
      }
    }
  });

  it("getIconShapes 对未知名回落到 more", () => {
    expect(getIconShapes("does-not-exist")).toEqual(ICONS.more);
    expect(getIconShapes("plus")).toBe(ICONS.plus);
  });

  it("窗口控制图标存在", () => {
    expect(ICONS.minimize).toBeDefined();
    expect(ICONS.maximize).toBeDefined();
    expect(ICONS.restore).toBeDefined();
    expect(ICONS.close).toBeDefined();
  });
});
