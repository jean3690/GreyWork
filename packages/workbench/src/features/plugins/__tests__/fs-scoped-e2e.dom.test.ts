import { describe, expect, it } from "vitest";
import { workerPrelude } from "@/plugins/code-runtime";
import { createCapabilityLoader, type CapabilityLoader } from "@/plugins/loader";
import {
  capabilityAuditLog,
  resetCapabilityAuditForTest,
  setPluginFsTransportForHost,
  type PluginFsHostResponse,
  type PluginFsTransport,
} from "@/plugins/capabilities";
import type { PluginManifest } from "@/plugins/types";

/**
 * fs.scoped 能力调用全链路集成测试（样板范式，与 capability-e2e / storage-kv-e2e 同构）：
 *
 *   插件代码（真实 prelude + 模拟 worker 作用域）
 *     → greywork.call("fs.scoped", {...})
 *     → postMessage("host-call")
 *     → 宿主 code-runtime 路由（此处 attachHostDispatch 承担）
 *     → loader.callCapability（声明 + 授权 + 注册表三重校验）
 *     → capabilities.ts fs.scoped broker（参数校验 + 审计）
 *     → 注入的宿主传输（此处为内存宿主；桌面态为 Rust plugin_fs 命令）
 *     → host-result 回传 → 插件 handler 拿到结果 → 返回 state patch
 *
 * 这条链上每一环都是真实代码（除 worker 运输层与宿主文件系统用模拟代替）。
 */

/** 内存宿主：还原 Rust plugin_fs 的响应形态。 */
function memoryHostTransport(): {
  transport: PluginFsTransport;
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  return {
    store,
    transport: async (request): Promise<PluginFsHostResponse> => {
      const base = { bytes: 0, totalBytes: store.size };
      switch (request.op) {
        case "write": {
          const data = request.data ?? "";
          store.set(request.path, data);
          return { ...base, bytes: data.length, totalBytes: store.size };
        }
        case "read": {
          const data = store.get(request.path);
          return data === undefined ? { ...base, exists: false } : { ...base, exists: true, data, bytes: data.length };
        }
        case "remove": {
          const removed = store.delete(request.path);
          return { ...base, removed, totalBytes: store.size };
        }
        case "list": {
          return {
            ...base,
            exists: true,
            entries: [...store.keys()].map((name) => ({ name, dir: false, bytes: store.get(name)!.length })),
          };
        }
        default: {
          const data = store.get(request.path);
          return data === undefined ? { ...base, exists: false } : { ...base, exists: true, bytes: data.length };
        }
      }
    },
  };
}

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

async function pump(times = 6): Promise<void> {
  for (let index = 0; index < times; index++) await Promise.resolve();
}

/** 演示插件：把备注写进沙箱文件（fs.scoped），再读回 patch 进页面字段。 */
const fsPluginCode = `
greywork.registerAction("save-file", async (state) => {
  try {
    const note = typeof state.note === "string" ? state.note : "";
    await greywork.call("fs.scoped", { op: "write", path: "notes/hello.txt", data: note });
    return { status: "已写入沙箱文件" };
  } catch (error) {
    return { status: \`写入被拒：\${error.message}\` };
  }
});

greywork.registerAction("load-file", async () => {
  try {
    const { exists, data } = await greywork.call("fs.scoped", { op: "read", path: "notes/hello.txt" });
    return { note: exists ? data : "（尚无文件）", status: exists ? "已从沙箱读回" : "文件不存在" };
  } catch (error) {
    return { status: \`读取被拒：\${error.message}\` };
  }
});
`;

describe("fs.scoped 能力调用全链路", () => {
  it("授权后：worker 经 greywork.call 完成 write/read，结果 patch 回页面，审计留痕", async () => {
    resetCapabilityAuditForTest();
    const host = memoryHostTransport();
    setPluginFsTransportForHost(host.transport);

    const loader = createCapabilityLoader();
    const manifest: PluginManifest = { id: "demo.fs", name: "文件便签", version: "1.0.0", requires: ["fs.scoped"] };
    loader.register(manifest);
    loader.grantCapability("demo.fs", "fs.scoped");
    await loader.activate("demo.fs");

    const worker = createSimulatedWorker(fsPluginCode);
    const dispatchHostCalls = attachHostDispatch(worker, loader, "demo.fs");

    // save：worker → host-call(write) → 宿主内存盘 → patch 回页面
    const savePromise = worker.invoke("save-file", { note: "第一条笔记", status: "" });
    await pump();
    dispatchHostCalls();
    await pump();
    const savePatch = (await savePromise) as Record<string, unknown>;
    expect(savePatch.status).toBe("已写入沙箱文件");

    // 落盘断言：宿主 store 里有该文件。
    expect(host.store.get("notes/hello.txt")).toBe("第一条笔记");

    // load：host-call(read) → 读回 → patch note 字段
    const loadPromise = worker.invoke("load-file", { note: "", status: "" });
    await pump();
    dispatchHostCalls();
    await pump();
    const loadPatch = (await loadPromise) as Record<string, unknown>;
    expect(loadPatch.note).toBe("第一条笔记");

    // 审计留痕：ok + write / read。
    const fsAudits = capabilityAuditLog().filter((entry) => entry.plugin === "demo.fs" && entry.capability === "fs.scoped");
    expect(fsAudits.some((entry) => entry.outcome === "ok" && entry.detail === "write notes/hello.txt")).toBe(true);
    expect(fsAudits.some((entry) => entry.outcome === "ok" && entry.detail === "read notes/hello.txt")).toBe(true);

    setPluginFsTransportForHost(null);
    resetCapabilityAuditForTest();
  });

  it("revoke 后：worker 的 fs.scoped 调用即时被拒，错误回到插件 handler", async () => {
    resetCapabilityAuditForTest();
    const host = memoryHostTransport();
    setPluginFsTransportForHost(host.transport);

    const loader = createCapabilityLoader();
    loader.register({ id: "demo.fs", name: "文件便签", version: "1.0.0", requires: ["fs.scoped"] });
    loader.grantCapability("demo.fs", "fs.scoped");
    await loader.activate("demo.fs");

    const worker = createSimulatedWorker(fsPluginCode);
    const dispatchHostCalls = attachHostDispatch(worker, loader, "demo.fs");

    loader.revokeCapability("demo.fs", "fs.scoped");
    const loadPromise = worker.invoke("load-file", { note: "旧值", status: "" });
    await pump();
    dispatchHostCalls();
    await pump();
    const patch = (await loadPromise) as Record<string, unknown>;
    expect(String(patch.status)).toMatch(/revoked|denied/);
    // 被拒调用不触达宿主。
    expect(host.store.size).toBe(0);

    setPluginFsTransportForHost(null);
    resetCapabilityAuditForTest();
  });
});
