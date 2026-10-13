import { describe, expect, it } from "vitest";
import { workerPrelude } from "@/plugins/code-runtime";
import { createCapabilityLoader, type CapabilityLoader } from "@/plugins/loader";
import { capabilityAuditLog, resetCapabilityAuditForTest, resetStorageKvForTest } from "@/plugins/capabilities";
import type { PluginManifest } from "@/plugins/types";

/**
 * storage.kv 能力调用全链路集成测试（样板范式，与 capability-e2e 同构）：
 *
 *   插件代码（真实 prelude + 模拟 worker 作用域）
 *     → greywork.call("storage.kv", {...})
 *     → postMessage("host-call")
 *     → 宿主 code-runtime 路由（此处 attachHostDispatch 承担）
 *     → loader.callCapability（声明 + 授权 + 注册表三重校验）
 *     → capabilities.ts storage.kv broker（键/值/配额校验 + 审计）
 *     → host-result 回传 → 插件 handler 拿到结果 → 返回 state patch
 *
 * 这条链上每一环都是真实代码（除 worker 运输层用模拟作用域代替真实 Web Worker）。
 */

/** 模拟 worker 作用域：prelude 把 greywork 挂在 scope（带 with 的全局语义）。 */
function createSimulatedWorker(pluginCode: string): {
  posted: unknown[];
  respond: (message: unknown) => void;
  invoke: (handler: string, state: Record<string, unknown>) => Promise<unknown>;
} {
  const posted: unknown[] = [];
  const listeners: Array<(event: { data: unknown }) => void> = [];
  const scope: Record<string, unknown> = {
    postMessage: (message: unknown) => {
      posted.push(message);
      const data = message as { type?: string };
      if (data?.type === "result") {
        for (const listener of [...listeners]) listener({ data: message });
      }
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

  const respond = (message: unknown): void => {
    for (const listener of [...listeners]) listener({ data: message });
  };

  const invoke = (handler: string, state: Record<string, unknown>): Promise<unknown> => {
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const waitForResult = (event: { data: unknown }): void => {
      const data = event.data as { type?: string; requestId?: number; patch?: unknown; error?: unknown };
      if (data?.type === "result") {
        const index = listeners.indexOf(waitForResult);
        if (index >= 0) listeners.splice(index, 1);
        if (data.error !== undefined) reject(new Error(String(data.error)));
        else resolve(data.patch);
      }
    };
    listeners.push(waitForResult);
    for (const listener of [...listeners]) {
      if (listener !== waitForResult) listener({ data: { type: "invoke", requestId: -1, handler, state } });
    }
    return promise;
  };

  return { posted, respond, invoke };
}

/** 把 worker 出站 host-call 消息接到宿主 loader（模拟 code-runtime 的路由职责）。 */
function attachHostDispatch(
  worker: { posted: unknown[]; respond: (message: unknown) => void },
  loader: CapabilityLoader,
  pluginId: string,
): () => void {
  const seen = new Set<unknown>();
  return () => {
    for (const message of worker.posted) {
      if (seen.has(message)) continue;
      seen.add(message);
      const data = message as { type?: string; requestId?: number; capability?: string; args?: unknown };
      if (data?.type !== "host-call") continue;
      void loader.callCapability(pluginId, data.capability!, data.args).then(
        (result) => worker.respond({ type: "host-result", requestId: data.requestId, result }),
        (error) =>
          worker.respond({
            type: "host-result",
            requestId: data.requestId,
            error: error instanceof Error ? error.message : String(error),
          }),
      );
    }
  };
}

/** 泵微任务队列：prelude 的 async message handler 在 promise 链中发出 host-call。 */
async function pump(times = 6): Promise<void> {
  for (let index = 0; index < times; index++) await Promise.resolve();
}

/** 演示插件：把 note 存进 storage.kv，再读回 patch 进页面字段。 */
const kvPluginCode = `
greywork.registerAction("save-note", async (state) => {
  try {
    const note = typeof state.note === "string" ? state.note : "";
    await greywork.call("storage.kv", { op: "set", key: "note", value: { text: note, savedAt: 123456 } });
    return { saved: "已保存到插件存储" };
  } catch (error) {
    return { saved: \`存储写入被拒：\${error.message}\` };
  }
});

greywork.registerAction("load-note", async () => {
  try {
    const { value } = await greywork.call("storage.kv", { op: "get", key: "note" });
    const text = value && typeof value.text === "string" ? value.text : "（存储为空）";
    return { note: text, saved: \`读回：\${JSON.stringify(value)}\` };
  } catch (error) {
    return { saved: \`存储读取被拒：\${error.message}\` };
  }
});
`;

describe("storage.kv 能力调用全链路", () => {
  it("授权后：worker 经 greywork.call 完成 set/get，结果 patch 回页面，审计留痕", async () => {
    resetStorageKvForTest();
    resetCapabilityAuditForTest();

    const loader = createCapabilityLoader();
    const manifest: PluginManifest = { id: "demo.kv", name: "KV 便签", version: "1.0.0", requires: ["storage.kv"] };
    loader.register(manifest);
    loader.grantCapability("demo.kv", "storage.kv");
    await loader.activate("demo.kv");

    const worker = createSimulatedWorker(kvPluginCode);
    const dispatchHostCalls = attachHostDispatch(worker, loader, "demo.kv");

    // save：worker → host-call(set) → 宿主写盘 → patch 回页面
    // 注意：先取 promise 再 pump/dispatch（invoke 内同步发出 host-call，
    // 卡在 await 上会导致后续 dispatch 永不执行 —— 与 capability-e2e 同款顺序契约）。
    const savePromise = worker.invoke("save-note", { note: "第一条便签", saved: "" });
    await pump();
    dispatchHostCalls();
    await pump();
    const savePatch = (await savePromise) as Record<string, unknown>;
    expect(savePatch.saved).toBe("已保存到插件存储");

    // 落盘断言：localStorage 里有插件命名空间。
    const raw = localStorage.getItem("greywork.plugins.storageKv");
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string)).toEqual({ "demo.kv": { note: { text: "第一条便签", savedAt: 123456 } } });

    // load：host-call(get) → 读回 → patch note 字段
    const loadPromise = worker.invoke("load-note", { note: "", saved: "" });
    await pump();
    dispatchHostCalls();
    await pump();
    const loadPatch = (await loadPromise) as Record<string, unknown>;
    expect(loadPatch.note).toBe("第一条便签");

    // 审计留痕：ok + set note / get note。
    const kvAudits = capabilityAuditLog().filter((entry) => entry.plugin === "demo.kv" && entry.capability === "storage.kv");
    expect(kvAudits.some((entry) => entry.outcome === "ok" && entry.detail === "set note")).toBe(true);
    expect(kvAudits.some((entry) => entry.outcome === "ok" && entry.detail === "get note")).toBe(true);

    resetStorageKvForTest();
    resetCapabilityAuditForTest();
  });

  it("revoke 后：worker 的 storage.kv 调用即时被拒，错误回到插件 handler", async () => {
    resetStorageKvForTest();
    resetCapabilityAuditForTest();

    const loader = createCapabilityLoader();
    loader.register({ id: "demo.kv", name: "KV 便签", version: "1.0.0", requires: ["storage.kv"] });
    loader.grantCapability("demo.kv", "storage.kv");
    await loader.activate("demo.kv");

    const worker = createSimulatedWorker(kvPluginCode);
    const dispatchHostCalls = attachHostDispatch(worker, loader, "demo.kv");

    loader.revokeCapability("demo.kv", "storage.kv");
    const loadPromise = worker.invoke("load-note", { note: "旧值", saved: "" });
    await pump();
    dispatchHostCalls();
    await pump();
    const patch = (await loadPromise) as Record<string, unknown>;
    expect(String(patch.saved)).toMatch(/revoked|denied/);

    resetStorageKvForTest();
    resetCapabilityAuditForTest();
  });
});
