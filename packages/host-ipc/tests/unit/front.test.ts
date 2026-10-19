/**
 * 前端身份的运行时判定。
 *
 * 重点锁三件事：
 * 1. 缺省是 `null` 而**不是**猜一个身份 —— 「未知」不等于「是某一端」；
 * 2. `window.__GREYWORK_FRONT__` 覆盖优先于 `declareFront()`，且判定是实时的；
 * 3. `frontContext()` 只是四个探针的原样快照，尤其 `hasHostCommands` 与 `isNativeShell`
 *    必须保持两个独立字段（22 条 desktop_only 的守卫只认后者，见 shell.ts）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const FRONT_KEY = "__GREYWORK_FRONT__";
const RUNTIME_KEY = "__GREYWORK_RUNTIME__";
const SHELL_KEY = "__GREYWORK_SHELL__";

/** 每个用例拿一份全新模块：声明落在 front.ts 的模块作用域，跨用例会串。 */
async function freshFront() {
  vi.resetModules();
  return import("../../src/front");
}

/** 装一个最小 window；覆盖键直接铺上去（键名与实现里一致，见 runtime.test.ts 同款做法）。 */
function stubWindow(overrides: Record<string, unknown> = {}): void {
  vi.stubGlobal("window", { ...overrides });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("frontId", () => {
  it("未声明且无覆盖时为 null —— 不替调用方猜一个身份", async () => {
    stubWindow();
    const { frontId } = await freshFront();
    expect(frontId()).toBeNull();
  });

  it("declareFront 后回报该身份", async () => {
    stubWindow();
    const { declareFront, frontId } = await freshFront();
    declareFront("web");
    expect(frontId()).toBe("web");
  });

  it("判定实时：重新声明立刻生效（不缓存）", async () => {
    stubWindow();
    const { declareFront, frontId } = await freshFront();
    declareFront("desktop");
    expect(frontId()).toBe("desktop");
    declareFront("mobile");
    expect(frontId()).toBe("mobile");
  });

  it("显式覆盖优先于声明，且在声明前后都成立", async () => {
    stubWindow({ [FRONT_KEY]: "cli" });
    const { declareFront, frontId } = await freshFront();
    expect(frontId()).toBe("cli");
    declareFront("desktop");
    expect(frontId()).toBe("cli");
  });

  it("非法覆盖值被忽略，落回声明", async () => {
    stubWindow({ [FRONT_KEY]: "nonsense" });
    const { declareFront, frontId } = await freshFront();
    expect(frontId()).toBeNull();
    declareFront("mobile");
    expect(frontId()).toBe("mobile");
  });

  it("没有 window（非浏览器环境）落回声明", async () => {
    const { declareFront, frontId } = await freshFront();
    expect(frontId()).toBeNull();
    declareFront("cli");
    expect(frontId()).toBe("cli");
  });
});

describe("frontContext", () => {
  it("无宿主 + 未声明：原样回报四个探针", async () => {
    stubWindow();
    const { frontContext } = await freshFront();
    expect(frontContext()).toEqual({
      frontId: null,
      runtimeMode: "browser-preview",
      isNativeShell: false,
      hasHostCommands: false,
    });
  });

  it("Electron 壳：有原生壳，命令面也可达", async () => {
    stubWindow({ [RUNTIME_KEY]: "server", [SHELL_KEY]: { window: { label: "main" } } });
    const { declareFront, frontContext } = await freshFront();
    declareFront("desktop");
    expect(frontContext()).toEqual({
      frontId: "desktop",
      runtimeMode: "server",
      isNativeShell: true,
      hasHostCommands: true,
    });
  });

  it("自托管服务端托管 Web 端：命令面可达但**没有**原生壳（两个字段不能合并）", async () => {
    stubWindow({ [FRONT_KEY]: "web", [RUNTIME_KEY]: "server" });
    const { frontContext } = await freshFront();
    expect(frontContext()).toEqual({
      frontId: "web",
      runtimeMode: "server",
      isNativeShell: false,
      hasHostCommands: true,
    });
  });
});
