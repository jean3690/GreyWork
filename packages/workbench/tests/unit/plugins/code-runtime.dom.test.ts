import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkerCodePluginRuntime } from "@/plugins/code-runtime";
import type { InstalledPluginPackage } from "@/plugins/market-types";

interface WorkerHarness {
  worker: FakeWorker | null;
  url: string | null;
  revoked: string[];
}

const harness: WorkerHarness = { worker: null, url: null, revoked: [] };

class FakeWorker extends EventTarget {
  readonly posted: unknown[] = [];
  terminated = false;

  constructor(_url: string, _options: WorkerOptions) {
    super();
    harness.worker = this;
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

const pluginPackage: InstalledPluginPackage = {
  schemaVersion: 1,
  code: 'greywork.registerAction("advance", state => ({ count: state.count + 1 }));',
  manifest: {
    id: "test.worker",
    name: "Worker",
    version: "1.0.0",
    kind: "worker",
    runtime: { type: "worker", entry: "https://raw.githubusercontent.com/acme/demo/main/index.js", sha256: "a".repeat(64) },
    requires: [],
    contributes: { modes: [] },
  },
};

beforeEach(() => {
  harness.worker = null;
  harness.url = null;
  harness.revoked = [];
  vi.stubGlobal("Worker", FakeWorker);
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
    harness.url = "blob:test-worker";
    return harness.url;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => harness.revoked.push(String(url)));
});

afterEach(() => vi.restoreAllMocks());

describe("createWorkerCodePluginRuntime", () => {
  it("uses a module worker and resolves validated state patches", async () => {
    const runtime = createWorkerCodePluginRuntime(pluginPackage, hostCallNoop);
    const promise = runtime.invoke("advance", { count: 1 });
    const request = harness.worker?.posted[0] as { requestId: number };
    harness.worker?.respond({ type: "result", requestId: request.requestId, patch: { count: 2 } });

    await expect(promise).resolves.toEqual({ count: 2 });
    expect(harness.url).toBe("blob:test-worker");
  });

  it("rejects non-primitive patches and disposes the worker", async () => {
    const runtime = createWorkerCodePluginRuntime(pluginPackage, hostCallNoop);
    const promise = runtime.invoke("advance", { count: 1 });
    const request = harness.worker?.posted[0] as { requestId: number };
    harness.worker?.respond({ type: "result", requestId: request.requestId, patch: { nested: { value: 2 } } });

    await expect(promise).rejects.toThrow("invalid state patch");
    runtime.dispose();
    expect(harness.worker?.terminated).toBe(true);
    expect(harness.revoked).toEqual(["blob:test-worker"]);
    await expect(runtime.invoke("advance", {})).rejects.toThrow("disposed");
  });

  it("routes worker host-calls through the injected capability broker", async () => {
    const calls: Array<{ capability: string; args: unknown }> = [];
    const runtime = createWorkerCodePluginRuntime(pluginPackage, async (capability, args) => {
      calls.push({ capability, args });
      if (capability === "net.fetch") return { status: 200, ok: true };
      throw new Error("capability denied");
    });
    const promise = runtime.invoke("advance", { count: 1 });
    const request = harness.worker?.posted[0] as { requestId: number };
    // worker 内 greywork.call 发出的 host-call。
    harness.worker?.respond({ type: "host-call", requestId: 500, capability: "net.fetch", args: { url: "https://api.github.com/" } });
    await Promise.resolve(); // 让宿主 broker 的 then 回调运行
    const hostResult = harness.worker?.posted.find((m) => (m as { type: string }).type === "host-result") as {
      requestId: number;
      result?: unknown;
    };
    expect(hostResult).toMatchObject({ requestId: 500, result: { status: 200, ok: true } });
    // 鉴权拒绝路径：宿主抛错 → 回发 error 字段。
    harness.worker?.respond({ type: "host-call", requestId: 501, capability: "fs.read", args: {} });
    await Promise.resolve();
    // host-call 不干扰原 invoke 的完成。
    harness.worker?.respond({ type: "result", requestId: request.requestId, patch: { count: 2 } });
    await expect(promise).resolves.toEqual({ count: 2 });
    expect(calls.map((call) => call.capability)).toEqual(["net.fetch", "fs.read"]);
  });
});

const hostCallNoop = (_capability: string, _args: unknown): Promise<unknown> => Promise.resolve(undefined);
