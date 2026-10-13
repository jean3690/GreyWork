import { describe, expect, it } from "vitest";
import { workerPrelude } from "@/plugins/code-runtime";
import { createCapabilityLoader, type CapabilityLoader } from "@/plugins/loader";
import {
  capabilityAuditLog,
  resetCapabilityAuditForTest,
  resetNotifyRateLimitForTest,
  setPluginNotifyTransportForHost,
} from "@/plugins/capabilities";

/**
 * notify 能力调用全链路集成测试（与 capability-e2e / fs-scoped-e2e 同构）：
 *
 *   插件代码（真实 prelude + 模拟 worker 作用域）
 *     → greywork.call("notify", { title, body })
 *     → postMessage("host-call")
 *     → attachHostDispatch（承担 code-runtime 的路由职责）
 *     → loader.callCapability（声明 + 授权 + 注册表三重校验）
 *     → capabilities.ts notify broker（参数校验 + 限速 + 审计）
 *     → 注入的宿主传输（桌面态为 Rust `plugin_notify` 命令 → 系统通知）
 *     → host-result 回传 → 插件 handler 拿到结果 → 返回 state patch
 *
 * 这条链上每一环都是真实代码（除 worker 运输层与系统通知用模拟代替）。归属前缀
 * （`[demo.notify] …`）由 Rust 侧合成，这里由注入传输模拟同样的行为。
 */

/** 模拟 worker 作用域：prelude 把 greywork 挂在 scope（with 的全局语义）。 */
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
    `const factoryInner = (function () {
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

async function pump(times = 6): Promise<void> {
  for (let index = 0; index < times; index++) await Promise.resolve();
}

/** 演示插件：点一下弹一条系统通知。 */
const notifyPluginCode = `
greywork.registerAction("ping", async (state) => {
  try {
    const title = typeof state.title === "string" ? state.title : "构建完成";
    const body = typeof state.body === "string" ? state.body : "所有测试通过";
    await greywork.call("notify", { title, body });
    return { status: "已请求系统通知" };
  } catch (error) {
    return { status: \`通知被拒：\${error.message}\` };
  }
});
`;

describe("notify 能力调用全链路", () => {
  it("授权后：worker 经 greywork.call 发出通知，宿主收到归属后的请求，审计留痕", async () => {
    resetCapabilityAuditForTest();
    resetNotifyRateLimitForTest();
    let lastRequest: { pluginId: string; title: string; body: string } | null = null;
    setPluginNotifyTransportForHost(async (request) => {
      lastRequest = request;
      return { title: `[${request.pluginId}] ${request.title}`, body: request.body };
    });

    const loader = createCapabilityLoader();
    loader.register({ id: "demo.notify", name: "通知演示", version: "1.0.0", requires: ["notify"] });
    loader.grantCapability("demo.notify", "notify");
    await loader.activate("demo.notify");

    const worker = createSimulatedWorker(notifyPluginCode);
    const dispatchHostCalls = attachHostDispatch(worker, loader, "demo.notify");

    const pingPromise = worker.invoke("ping", { title: "构建完成", body: "所有测试通过", status: "" });
    await pump();
    dispatchHostCalls();
    await pump();
    const patch = (await pingPromise) as Record<string, unknown>;
    expect(patch.status).toBe("已请求系统通知");

    // 宿主收到 request：pluginId + title/body（归属前缀由宿主席位合成）。
    expect(lastRequest).toEqual({ pluginId: "demo.notify", title: "构建完成", body: "所有测试通过" });

    // 审计留痕：ok + 归属后的标题。
    expect(
      capabilityAuditLog().some(
        (entry) =>
          entry.plugin === "demo.notify" &&
          entry.capability === "notify" &&
          entry.outcome === "ok" &&
          entry.detail === "[demo.notify] 构建完成",
      ),
    ).toBe(true);

    resetNotifyRateLimitForTest();
    resetCapabilityAuditForTest();
  });

  it("revoke 后：worker 的 notify 调用即时被拒，错误回到插件 handler", async () => {
    resetCapabilityAuditForTest();
    resetNotifyRateLimitForTest();
    let notifications = 0;
    setPluginNotifyTransportForHost(async (request) => {
      notifications++;
      return { title: `[${request.pluginId}] ${request.title}`, body: request.body };
    });

    const loader = createCapabilityLoader();
    loader.register({ id: "demo.notify", name: "通知演示", version: "1.0.0", requires: ["notify"] });
    loader.grantCapability("demo.notify", "notify");
    await loader.activate("demo.notify");

    const worker = createSimulatedWorker(notifyPluginCode);
    const dispatchHostCalls = attachHostDispatch(worker, loader, "demo.notify");

    loader.revokeCapability("demo.notify", "notify");
    const pingPromise = worker.invoke("ping", { title: "t", body: "b", status: "" });
    await pump();
    dispatchHostCalls();
    await pump();
    const patch = (await pingPromise) as Record<string, unknown>;
    expect(String(patch.status)).toMatch(/revoked|denied/);
    // 被拒调用不触达宿主。
    expect(notifications).toBe(0);

    resetNotifyRateLimitForTest();
    resetCapabilityAuditForTest();
  });
});
