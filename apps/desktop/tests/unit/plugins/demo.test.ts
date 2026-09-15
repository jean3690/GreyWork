/**
 * 宿主侧第三方插件清单的契约形状：只经工作台公开接口注册，能力与视图声明齐全。
 * （清单本身是纯对象，node 环境即可校验；组件经 defineAsyncComponent 惰性加载。）
 */
import { describe, expect, it } from "vitest";
import { DEMO_PLUGIN } from "../../../src/plugins/demo";

describe("DEMO_PLUGIN", () => {
  it("声明了唯一模式 Demo 与对应能力", () => {
    expect(DEMO_PLUGIN.id).toBe("demo.counter");
    expect(DEMO_PLUGIN.name).toBe("Demo 计数器");
    expect(DEMO_PLUGIN.requires).toEqual(["demo:run"]);

    const contributes = DEMO_PLUGIN.contributes;
    expect(contributes).toBeDefined();
    const modes = contributes?.modes ?? [];
    const mode = modes[0];
    expect(mode).toBeDefined();
    expect(mode?.id).toBe("demo-counter");
    expect(mode?.title).toBe("Demo");
    expect(mode?.component).toBeDefined();

    expect(contributes?.capabilities).toContain("demo-counter:view");
  });
});
