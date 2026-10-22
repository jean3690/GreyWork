import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { workerPrelude, isPatch } from "@/plugins/code-runtime";
import { validateRenderCommands } from "@/plugins/render-commands";

/**
 * demo.wallpaper worker 单测：直接加载仓库里的真实插件代码（不复制一份），
 * 用真实 prelude 跑在模拟 worker 作用域里，帧过宿主白名单校验。
 *
 * 覆盖：四套主题都能出合法帧、暂停冻结相位、播放随时间推进、
 * 主题循环（含回绕）、暂停/继续的相位连续性、指针点击切主题。
 */

const WALLPAPER_CODE = readFileSync(
  fileURLToPath(new URL("../../../../../plugin-market/packages/demo.wallpaper.js", import.meta.url)),
  "utf8",
);

const THEMES = ["starfield", "aurora", "sunset", "rain"];
// 用本地时间构造：插件里的时钟按 getHours()/getMinutes() 渲染，这样断言在任何时区都是 09:30。
const BASE_NOW = new Date(2026, 9, 22, 9, 30, 0).getTime();

interface WallpaperState {
  theme: string;
  speed: number;
  paused: boolean;
  phase: number;
  phase_at: number;
  note: string;
}

function defaultState(now: number, patch: Partial<WallpaperState> = {}): WallpaperState {
  return { theme: "starfield", speed: 1, paused: false, phase: 0, phase_at: now, note: "", ...patch };
}

function createWallpaperWorker() {
  const listeners: Array<(event: { data: unknown }) => void> = [];
  let injectedNow = BASE_NOW;

  const scope: Record<string, unknown> = {
    // 时间注入：插件里的 Date.now() / new Date(now) 都取这个值。
    Date: class FakeDate extends Date {
      constructor(...args: unknown[]) {
        super(typeof args[0] === "number" ? args[0] : injectedNow);
      }
      static now(): number {
        return injectedNow;
      }
    },
    postMessage: (message: unknown) => {
      const data = message as { type?: string };
      if (data?.type === "result") for (const listener of [...listeners]) listener({ data: message });
    },
    addEventListener: (_type: string, listener: (event: { data: unknown }) => void) => listeners.push(listener),
  };

  const factory = new Function(
    "scope",
    [
      "const factoryInner = (function () {",
      "  return function (self, globalThis) {",
      "    with (self) {",
      workerPrelude,
      WALLPAPER_CODE,
      "    }",
      "  };",
      "})();",
      "return factoryInner;",
    ].join("\n"),
  );
  // factory(scope) 只返回内层函数，必须再调一次才会执行 prelude + 插件代码。
  (factory as (scope: Record<string, unknown>) => (self: Record<string, unknown>, g: Record<string, unknown>) => void)(scope)(scope, scope);

  function send(request: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown> | undefined>();
    const waitForResult = (event: { data: unknown }): void => {
      const data = event.data as { type?: string; patch?: unknown; error?: unknown };
      if (data?.type !== "result") return;
      const index = listeners.indexOf(waitForResult);
      if (index >= 0) listeners.splice(index, 1);
      if (data.error !== undefined) reject(new Error(String(data.error)));
      else resolve(data.patch as Record<string, unknown> | undefined);
    };
    listeners.push(waitForResult);
    for (const listener of [...listeners]) {
      if (listener !== waitForResult) listener({ data: { type: request.type, requestId: -1, ...request } });
    }
    return promise;
  }

  return {
    draw: (state: WallpaperState) => send({ type: "invoke", handler: "draw", state }),
    action: (handler: string, state: WallpaperState) => send({ type: "invoke", handler, state }),
    pointer: (event: Record<string, unknown>, state: WallpaperState) => send({ type: "pointer", event, state }),
    setNow: (now: number) => {
      injectedNow = now;
    },
  };
}

describe("demo.wallpaper 渲染", () => {
  it("四套主题都产出白名单内的帧，且带右下角时钟", async () => {
    const worker = createWallpaperWorker();
    for (const theme of THEMES) {
      const frame = await worker.draw(defaultState(BASE_NOW, { theme }));
      expect(validateRenderCommands(frame), theme).not.toBeNull();
      const commands = frame as unknown as Array<{ kind: string; text?: string }>;
      expect(commands.length).toBeGreaterThan(5);
      expect(commands.at(-1)).toMatchObject({ kind: "text", text: "09:30" });
    }
  });

  it("未知主题回落到第一套（不会画空白帧）", async () => {
    const worker = createWallpaperWorker();
    const unknown = await worker.draw(defaultState(BASE_NOW, { theme: "no-such-theme" }));
    const starfield = await worker.draw(defaultState(BASE_NOW, { theme: "starfield" }));
    expect(JSON.stringify(unknown)).toBe(JSON.stringify(starfield));
  });

  it("暂停时相位冻结：同一分钟内两帧完全一致", async () => {
    const worker = createWallpaperWorker();
    const paused = defaultState(BASE_NOW, { theme: "rain", paused: true, phase: 12 });
    const first = await worker.draw(paused);
    worker.setNow(BASE_NOW + 20_000);
    const second = await worker.draw(paused);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("播放时相位随时间推进：两帧不同", async () => {
    const worker = createWallpaperWorker();
    const state = defaultState(BASE_NOW, { theme: "aurora" });
    const first = await worker.draw(state);
    worker.setNow(BASE_NOW + 2_000);
    const second = await worker.draw(state);
    expect(JSON.stringify(second)).not.toBe(JSON.stringify(first));
  });

  it("速度影响推进量：2 倍速两秒的相位等于 1 倍速四秒", async () => {
    const worker = createWallpaperWorker();
    const fast = defaultState(BASE_NOW, { theme: "starfield", speed: 2 });
    worker.setNow(BASE_NOW + 2_000);
    const fastFrame = await worker.draw(fast);

    const slow = defaultState(BASE_NOW, { theme: "starfield", speed: 1 });
    worker.setNow(BASE_NOW + 4_000);
    const slowFrame = await worker.draw(slow);

    // 同一分钟内的时钟文本一致，比较除时钟外的部分。
    expect(JSON.stringify(fastFrame)).toBe(JSON.stringify(slowFrame));
  });
});

describe("demo.wallpaper 动作", () => {
  it("cycle 按顺序循环四套主题并回绕，patch 形态合法", async () => {
    const worker = createWallpaperWorker();
    let state = defaultState(BASE_NOW);
    const seen: string[] = [state.theme];
    for (let index = 0; index < THEMES.length; index += 1) {
      const patch = await worker.action("cycle", state);
      expect(isPatch(patch)).toBe(true);
      state = { ...state, ...(patch as Partial<WallpaperState>) };
      seen.push(state.theme);
    }
    expect(seen).toEqual([...THEMES, THEMES[0]]);
    expect(state.note).toContain(THEMES[0]);
  });

  it("toggle：暂停冻结当前相位，继续从冻结处接着走", async () => {
    const worker = createWallpaperWorker();
    const running = defaultState(BASE_NOW);
    worker.setNow(BASE_NOW + 10_000);

    const paused = (await worker.action("toggle", running)) as Partial<WallpaperState>;
    expect(isPatch(paused)).toBe(true);
    expect(paused.paused).toBe(true);
    expect(paused.phase).toBeCloseTo(10, 5);
    expect(paused.phase_at).toBe(BASE_NOW + 10_000);

    worker.setNow(BASE_NOW + 40_000);
    const resumed = (await worker.action("toggle", { ...running, ...paused } as WallpaperState)) as Partial<WallpaperState>;
    expect(resumed.paused).toBe(false);
    expect(resumed.phase_at).toBe(BASE_NOW + 40_000);
  });
});

describe("demo.wallpaper 指针", () => {
  it("点击切下一套主题；move 不产生补丁", async () => {
    const worker = createWallpaperWorker();
    const state = defaultState(BASE_NOW);

    const clicked = (await worker.pointer(
      { type: "down", x: 10, y: 10, nx: 0.1, ny: 0.1, buttons: 1, pointerId: 1 },
      state,
    )) as Partial<WallpaperState>;
    expect(isPatch(clicked)).toBe(true);
    expect(clicked.theme).toBe(THEMES[1]);

    const moved = await worker.pointer({ type: "move", x: 20, y: 20, nx: 0.2, ny: 0.2, buttons: 0, pointerId: 1 }, state);
    expect(moved).toBeUndefined();
  });
});
