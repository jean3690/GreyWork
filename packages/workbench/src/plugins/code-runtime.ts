import type { DeclarativeValue, InstalledPluginPackage } from "./market-types";

export type CodePluginState = Readonly<Record<string, DeclarativeValue>>;
export type CodePluginPatch = Record<string, DeclarativeValue>;

/**
 * 宿主能力代理：由 market.ts 注入（闭包持有 pluginId 与 loader）。
 * worker 内 `greywork.call(capability, args)` 的唯一出口 —— 鉴权、限域、审计全部在宿主侧。
 */
export type HostCapabilityCall = (capability: string, args: unknown) => Promise<unknown>;

interface WorkerInvokeRequest {
  type: "invoke";
  requestId: number;
  handler: string;
  state: CodePluginState;
}

interface WorkerHostCall {
  type: "host-call";
  requestId: number;
  capability: string;
  args: unknown;
}

interface WorkerResponse {
  type: "result";
  requestId: number;
  patch?: unknown;
  error?: unknown;
}

interface PendingInvocation {
  resolve: (patch: unknown) => void;
  reject: (error: Error) => void;
  timeout: number;
  /** 结果校验（动作走 isPatch；渲染调用无校验，指令集在消费方验）。 */
  validate?: (value: unknown) => boolean;
}

export interface CodePluginRuntime {
  /** 动作调用：worker handler 返回状态补丁（isPatch 白名单校验）。 */
  invoke(handler: string, state: CodePluginState): Promise<CodePluginPatch | void>;
  /** 渲染调用：worker render handler 返回任意 JSON（指令集校验在消费方）。 */
  invokeRaw(handler: string, state: CodePluginState): Promise<unknown>;
  dispose(): void;
}

export type CodePluginRuntimeFactory = (pluginPackage: InstalledPluginPackage, callCapability: HostCapabilityCall) => CodePluginRuntime;

const INVOCATION_TIMEOUT_MS = 10_000;
const HOST_CALL_TIMEOUT_MS = 20_000;

/**
 * Worker prelude：插件代码的唯一宿主接口。
 * - registerAction：声明动作处理器（state → patch）。
 * - call：调用宿主能力。返回 Promise，结果/错误经 host-call requestId 关联。
 * 除此之外 worker 内无任何宿主引用；网络/文件访问只能经 call 走宿主 broker。
 */
export const workerPrelude = `
const handlers = Object.create(null);
const pendingHostCalls = Object.create(null);
let nextHostCallId = 1;
globalThis.greywork = Object.freeze({
  registerAction(name, handler) {
    if (!/^[a-z0-9][a-z0-9._:-]{0,95}$/.test(name) || typeof handler !== "function") {
      throw new TypeError("invalid GreyWork action handler");
    }
    handlers[name] = handler;
  },
  call(capability, args) {
    if (typeof capability !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,95}$/.test(capability)) {
      return Promise.reject(new TypeError("invalid GreyWork capability id"));
    }
    return new Promise((resolve, reject) => {
      const requestId = nextHostCallId++;
      pendingHostCalls[requestId] = { resolve, reject };
      self.postMessage({ type: "host-call", requestId, capability, args });
    });
  },
});
self.addEventListener("message", async (event) => {
  const message = event.data;
  if (!message || message.type !== "invoke") return;
  try {
    const handler = handlers[message.handler];
    if (!handler) throw new Error("unknown plugin action: " + message.handler);
    const patch = await handler(Object.freeze({ ...message.state }));
    self.postMessage({ type: "result", requestId: message.requestId, patch });
  } catch (error) {
    self.postMessage({ type: "result", requestId: message.requestId, error: error instanceof Error ? error.message : String(error) });
  }
});
self.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || message.type !== "host-result") return;
  const pending = pendingHostCalls[message.requestId];
  if (!pending) return;
  delete pendingHostCalls[message.requestId];
  if (message.error !== undefined) pending.reject(new Error(String(message.error)));
  else pending.resolve(message.result);
});
`;

export function isPatch(value: unknown): value is CodePluginPatch | undefined {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => ["string", "number", "boolean"].includes(typeof entry));
}

export function createWorkerCodePluginRuntime(
  pluginPackage: InstalledPluginPackage,
  callCapability: HostCapabilityCall,
): CodePluginRuntime {
  if (pluginPackage.manifest.kind !== "worker" || !pluginPackage.code) {
    throw new Error(`plugin ${pluginPackage.manifest.id} has no installed worker code`);
  }
  const url = URL.createObjectURL(new Blob([workerPrelude, "\n", pluginPackage.code], { type: "text/javascript" }));
  const worker = new Worker(url, { type: "module", name: `greywork:${pluginPackage.manifest.id}` });
  const pending = new Map<number, PendingInvocation>();
  const pendingHostCalls = new Map<number, PendingInvocation>();
  let nextRequestId = 1;
  let disposed = false;

  function rejectAll(error: Error): void {
    for (const invocation of pending.values()) {
      clearTimeout(invocation.timeout);
      invocation.reject(error);
    }
    pending.clear();
    for (const invocation of pendingHostCalls.values()) {
      clearTimeout(invocation.timeout);
      invocation.reject(error);
    }
    pendingHostCalls.clear();
  }

  worker.addEventListener("message", (event: MessageEvent<WorkerResponse | WorkerHostCall>) => {
    const message = event.data;
    if (!message) return;
    // 宿主能力调用：worker 内 greywork.call 的请求。宿主侧收口鉴权后回发结果；
    // 超时兜底防 worker 侧 Promise 泄漏。
    if (message.type === "host-call") {
      const timeout = window.setTimeout(() => {
        pendingHostCalls.delete(message.requestId);
        if (!disposed) {
          worker.postMessage({
            type: "host-result",
            requestId: message.requestId,
            error: `host capability timed out after ${HOST_CALL_TIMEOUT_MS}ms`,
          });
        }
      }, HOST_CALL_TIMEOUT_MS);
      pendingHostCalls.set(message.requestId, {
        resolve: () => undefined,
        reject: () => undefined,
        timeout,
      });
      void callCapability(message.capability, message.args).then(
        (result) => {
          const entry = pendingHostCalls.get(message.requestId);
          pendingHostCalls.delete(message.requestId);
          if (entry) clearTimeout(entry.timeout);
          if (!disposed) worker.postMessage({ type: "host-result", requestId: message.requestId, result });
        },
        (error) => {
          const entry = pendingHostCalls.get(message.requestId);
          pendingHostCalls.delete(message.requestId);
          if (entry) clearTimeout(entry.timeout);
          if (!disposed) {
            worker.postMessage({
              type: "host-result",
              requestId: message.requestId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      );
      return;
    }
    if (message.type !== "result") return;
    const invocation = pending.get(message.requestId);
    if (!invocation) return;
    pending.delete(message.requestId);
    clearTimeout(invocation.timeout);
    if (message.error !== undefined) {
      invocation.reject(new Error(String(message.error)));
    } else if (invocation.validate && !invocation.validate(message.patch)) {
      invocation.reject(new Error("plugin action returned an invalid state patch"));
    } else {
      invocation.resolve(message.patch);
    }
  });
  worker.addEventListener("error", (event) => rejectAll(new Error(event.message || "plugin worker crashed")));

  return {
    invoke(handler, state) {
      if (disposed) return Promise.reject(new Error("plugin worker is disposed"));
      const requestId = nextRequestId++;
      const { promise, resolve, reject } = Promise.withResolvers<CodePluginPatch | void>();
      const timeout = window.setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`plugin action timed out after ${INVOCATION_TIMEOUT_MS}ms`));
      }, INVOCATION_TIMEOUT_MS);
      pending.set(requestId, {
        resolve: resolve as (patch: unknown) => void,
        reject,
        timeout,
        validate: (value: unknown) => isPatch(value),
      });
      worker.postMessage({ type: "invoke", requestId, handler, state } satisfies WorkerInvokeRequest);
      return promise;
    },
    invokeRaw(handler, state) {
      if (disposed) return Promise.reject(new Error("plugin worker is disposed"));
      const requestId = nextRequestId++;
      const { promise, resolve, reject } = Promise.withResolvers<unknown>();
      const timeout = window.setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`plugin render timed out after ${INVOCATION_TIMEOUT_MS}ms`));
      }, INVOCATION_TIMEOUT_MS);
      pending.set(requestId, { resolve, reject, timeout });
      worker.postMessage({ type: "invoke", requestId, handler, state } satisfies WorkerInvokeRequest);
      return promise;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      worker.terminate();
      URL.revokeObjectURL(url);
      rejectAll(new Error("plugin worker was disposed"));
    },
  };
}
