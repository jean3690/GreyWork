import { describe, expect, it } from "vitest";
import { workerPrelude } from "@/plugins/code-runtime";
import { createCapabilityLoader, type CapabilityLoader } from "@/plugins/loader";
import { setNetFetchTransportForHost, resetCapabilityAuditForTest, capabilityAuditLog } from "@/plugins/capabilities";
import type { PluginManifest } from "@/plugins/types";

/**
 * demo.worker「能力调用」全链路集成测试：
 *
 *   插件代码（真实 prelude + 真实插件 JS，eval 在模拟 worker 作用域中）
 *     → greywork.call("net.fetch", {...})
 *     → postMessage("host-call")
 *     → 宿主 code-runtime 路由
 *     → loader.callCapability（声明 + 授权 + 注册表三重校验）
 *     → capabilities.ts net.fetch broker（域名校权 + 限速 + 审计）
 *     → 注入的 IPC transport（此处 mock，桌面态为 plugin_net_fetch Rust 命令）
 *     → host-result 回传 → 插件 handler 拿到结果 → 返回 state patch
 *
 * 这条链上除了 transport 本身（Rust 进程边界），每一环都是真实代码。
 */

/**
 * 模拟 worker 作用域：prelude 把 greywork 挂在 globalThis（此处为 scope 对象），
 * 插件代码经 with(scope) 解析裸标识符 —— 与真实 worker 全局语义一致。
 */
function createSimulatedWorker(pluginCode: string): {
  posted: unknown[];
  respond: (message: unknown) => void;
  invoke: (handler: string, state: Record<string, unknown>) => Promise<unknown>;
} {
  const posted: unknown[] = [];
  const listeners: Array<(event: { data: unknown }) => void> = [];
  const scope: Record<string, unknown> = {
    // 出站消息同时回环给监听器：模拟「宿主 onmessage 收到 result」——
    // invoke() 的结果监听即挂在这条回环上（host-call 不回环，由 dispatchHostCalls 接走）。
    postMessage: (message: unknown) => {
      posted.push(message);
      const data = message as { type?: string };
      if (data?.type === "result") {
        for (const listener of [...listeners]) listener({ data: message });
      }
    },
    addEventListener: (_type: string, listener: (event: { data: unknown }) => void) => listeners.push(listener),
  };

  // with 语义需要对象；用严格模式外的 Function 体（默认非严格）。
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
  const bootstrap = factory();
  bootstrap(scope, scope);

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
    // invoke 请求由「宿主」发出 —— 触发除结果监听外的所有 message 监听。
    for (const listener of [...listeners]) {
      if (listener !== waitForResult) listener({ data: { type: "invoke", requestId: -1, handler, state } });
    }
    return promise;
  };

  return { posted, respond, invoke };
}

const demoWorkerPluginCode = `
greywork.registerAction("fetch-ip", async () => {
  try {
    const response = await greywork.call("net.fetch", { url: "https://api.github.com/meta" });
    return { status: \`HTTP \${response.status} · 能力调用成功\`, count: 100 };
  } catch (error) {
    return { status: \`能力调用被拒：\${error.message}\` };
  }
});
`;

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
async function pump(times = 4): Promise<void> {
  for (let index = 0; index < times; index++) await Promise.resolve();
}

describe("demo.worker 能力调用全链路", () => {
  it("授权后 host-call 经 broker 全链路返回结果并留审计；revoke 后即时被拒", async () => {
    resetCapabilityAuditForTest();
    const transports: unknown[] = [];
    setNetFetchTransportForHost(async (request) => {
      transports.push(request);
      return { status: 200, ok: true, headers: { "content-type": "application/json" }, body: "{}" };
    });

    const loader = createCapabilityLoader();
    const manifest: PluginManifest = {
      id: "demo.worker",
      name: "Worker 代码插件",
      version: "1.1.0",
      requires: [{ capability: "net.fetch", hosts: ["api.github.com"] }],
    };
    loader.register(manifest);
    loader.grantCapability("net.fetch");
    await loader.activate("demo.worker");

    const worker = createSimulatedWorker(demoWorkerPluginCode);
    const dispatchHostCalls = attachHostDispatch(worker, loader, "demo.worker");

    const patchPromise = worker.invoke("fetch-ip", { count: 0, status: "等待执行" });
    await pump();
    dispatchHostCalls();
    await pump();

    const patch = (await patchPromise) as Record<string, unknown>;
    expect(patch.status).toBe("HTTP 200 · 能力调用成功");
    expect(patch.count).toBe(100);

    // transport 收到的请求带域名白名单（Rust 侧二次校验的输入）。
    expect(transports).toHaveLength(1);
    expect(transports[0]).toMatchObject({ url: "https://api.github.com/meta", allowedHosts: ["api.github.com"] });
    // 审计留痕。
    expect(
      capabilityAuditLog().some((entry) => entry.plugin === "demo.worker" && entry.capability === "net.fetch" && entry.outcome === "ok"),
    ).toBe(true);

    // revoke 即时生效：下一次调用被拒，错误信息回到插件 handler。
    loader.revokeCapability("net.fetch");
    const deniedPromise = worker.invoke("fetch-ip", { count: 0, status: "等待执行" });
    await pump();
    dispatchHostCalls();
    await pump();
    const deniedPatch = (await deniedPromise) as Record<string, unknown>;
    expect(String(deniedPatch.status)).toMatch(/revoked/);

    setNetFetchTransportForHost(null);
    resetCapabilityAuditForTest();
  });

  it("白名单外域名：broker 在校权层直接拒绝（不触达 transport）", async () => {
    resetCapabilityAuditForTest();
    let transportCalls = 0;
    setNetFetchTransportForHost(async () => {
      transportCalls += 1;
      return { status: 200, ok: true, headers: {}, body: "{}" };
    });

    const loader = createCapabilityLoader();
    loader.register({
      id: "demo.worker",
      name: "Worker 代码插件",
      version: "1.1.0",
      requires: [{ capability: "net.fetch", hosts: ["api.github.com"] }],
    });
    loader.grantCapability("net.fetch");
    await loader.activate("demo.worker");

    const worker = createSimulatedWorker(demoWorkerPluginCode.replace("api.github.com/meta", "evil.com/steal"));
    const dispatchHostCalls = attachHostDispatch(worker, loader, "demo.worker");

    const patchPromise = worker.invoke("fetch-ip", { count: 0, status: "等待执行" });
    await pump();
    dispatchHostCalls();
    await pump();

    const patch = (await patchPromise) as Record<string, unknown>;
    expect(String(patch.status)).toMatch(/allowlist/);
    expect(transportCalls).toBe(0);

    setNetFetchTransportForHost(null);
    resetCapabilityAuditForTest();
  });
});
