import { describe, expect, it } from "vitest";
import { workerPrelude, isPatch, type PluginPointerEvent } from "@/plugins/code-runtime";

/**
 * worker prelude 的指针处理器单测：真实 prelude 跑在模拟 worker 作用域里，
 * 覆盖 registerPointer 的注册/保留名规则，以及 pointer 消息 → handler(event, state)
 * → result patch 的派发路径。宿主侧消息路由在 code-runtime.dom.test.ts 覆盖。
 */
function createSimulatedWorker(pluginCode: string): {
  invoke: (handler: string, state: Record<string, unknown>) => Promise<unknown>;
  pointer: (event: PluginPointerEvent, state: Record<string, unknown>) => Promise<unknown>;
} {
  const listeners: Array<(event: { data: unknown }) => void> = [];
  const scope: Record<string, unknown> = {
    postMessage: (message: unknown) => {
      const data = message as { type?: string };
      if (data?.type === "result") for (const listener of [...listeners]) listener({ data: message });
    },
    addEventListener: (_type: string, listener: (event: { data: unknown }) => void) => listeners.push(listener),
  };

  const factory = new Function(
    "scope",
    `
     const factoryInner = (function () {
       return function (self, globalThis) {
         with (self) {
${workerPrelude}
${pluginCode}
         }
       };
     })();
     return factoryInner;`,
  );
  factory()(scope, scope);

  const request = (message: Record<string, unknown>): Promise<unknown> => {
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const wait = (event: { data: unknown }): void => {
      const data = event.data as { type?: string; patch?: unknown; error?: unknown };
      if (data?.type !== "result") return;
      const index = listeners.indexOf(wait);
      if (index >= 0) listeners.splice(index, 1);
      if (data.error !== undefined) reject(new Error(String(data.error)));
      else resolve(data.patch);
    };
    listeners.push(wait);
    for (const listener of [...listeners]) listener({ data: message });
    return promise;
  };

  return {
    invoke: (handler, state) => request({ type: "invoke", requestId: -1, handler, state }),
    pointer: (event, state) => request({ type: "pointer", requestId: -2, event, state }),
  };
}

const downEvent: PluginPointerEvent = { type: "down", x: 42, y: 7, nx: 0.1, ny: 0.2, buttons: 1, pointerId: 3 };

describe("worker prelude registerPointer", () => {
  it("passes the normalized event and state to the handler and returns its patch", async () => {
    const worker = createSimulatedWorker(
      `greywork.registerPointer((event, state) => ({
         x: event.x,
         lastEvent: event.type,
         clicks: (typeof state.clicks === "number" ? state.clicks : 0) + (event.type === "down" ? 1 : 0),
       }));`,
    );

    const patch = await worker.pointer(downEvent, { clicks: 4 });
    expect(isPatch(patch)).toBe(true);
    expect(patch).toEqual({ x: 42, lastEvent: "down", clicks: 5 });
  });

  it('reserves the "pointer" action name and rejects duplicate pointer handlers', () => {
    expect(() => createSimulatedWorker(`greywork.registerAction("pointer", () => ({}));`)).toThrow(/reserved/);
    expect(() => createSimulatedWorker(`greywork.registerPointer(() => ({})); greywork.registerPointer(() => ({}));`)).toThrow(
      /already registered/,
    );
  });

  it("rejects pointer events when no handler was registered", async () => {
    const worker = createSimulatedWorker(`greywork.registerAction("noop", () => ({}));`);
    await expect(worker.pointer(downEvent, {})).rejects.toThrow(/did not register a pointer handler/);
  });
});
