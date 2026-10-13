import { beforeEach, afterEach, describe, expect, it } from "vitest";
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
 * fs.scoped 能力单测（node 环境，注入宿主伪传输）：
 *  - 五个 op 的返回值契约与 transport 收到的请求（pluginId / op / path / data）
 *  - 参数校验（非法 op、read 空路径、非 write 携带 data、data 非字符串、path 超长）
 *  - 无宿主 transport 时调用直接失败并留 denied 审计
 *  - 宿主抛错 → error 审计 + 错误上抛
 *  - 门禁（未激活 / revoke 即时拒绝）
 *  - 每插件隔离（transport 收到各自 pluginId）
 */

const storageHolder = globalThis as { localStorage?: Storage };

function injectStorage(): void {
  const backing: Record<string, string> = {};
  storageHolder.localStorage = {
    getItem: (key: string) => backing[key] ?? null,
    setItem: (key: string, value: string) => {
      backing[key] = value;
    },
    removeItem: (key: string) => {
      delete backing[key];
    },
    clear: () => {
      for (const key of Object.keys(backing)) delete backing[key];
    },
    key: (index: number) => Object.keys(backing)[index] ?? null,
    get length() {
      return Object.keys(backing).length;
    },
  } as Storage;
}

interface FsCall {
  pluginId: string;
  op: string;
  path: string;
  data?: string;
}

/** 内存宿主：还原 Rust plugin_fs 的响应形态（简化实现，供契约断言）。 */
function memoryHost(): { transport: PluginFsTransport; calls: FsCall[]; store: Map<string, string> } {
  const calls: FsCall[] = [];
  const store = new Map<string, string>();
  const transport: PluginFsTransport = async (request) => {
    calls.push({ pluginId: request.pluginId, op: request.op, path: request.path, data: request.data });
    const base = { bytes: 0, totalBytes: store.size } as PluginFsHostResponse;
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
      case "stat": {
        const data = store.get(request.path);
        return data === undefined ? { ...base, exists: false } : { ...base, exists: true, bytes: data.length };
      }
    }
  };
  return { transport, calls, store };
}

let loader: CapabilityLoader;
let host: ReturnType<typeof memoryHost>;

function fsManifest(id = "demo.fs"): PluginManifest {
  return { id, name: "文件插件", version: "1.0.0", requires: ["fs.scoped"] };
}

async function setupGranted(id = "demo.fs"): Promise<void> {
  loader.register(fsManifest(id));
  loader.grantCapability(id, "fs.scoped");
  await loader.activate(id);
}

beforeEach(async () => {
  injectStorage();
  resetCapabilityAuditForTest();
  host = memoryHost();
  setPluginFsTransportForHost(host.transport);
  loader = createCapabilityLoader();
  await setupGranted();
});

afterEach(() => {
  setPluginFsTransportForHost(null);
  resetCapabilityAuditForTest();
  delete storageHolder.localStorage;
});

describe("fs.scoped 基本契约", () => {
  it("write → read 读回；stat/list/remove 依次生效", async () => {
    await loader.callCapability("demo.fs", "fs.scoped", {
      op: "write",
      path: "notes/hello.txt",
      data: "hi",
    });

    const read = (await loader.callCapability("demo.fs", "fs.scoped", { op: "read", path: "notes/hello.txt" })) as {
      exists: boolean;
      data: string | null;
    };
    expect(read.exists).toBe(true);
    expect(read.data).toBe("hi");

    const stat = (await loader.callCapability("demo.fs", "fs.scoped", { op: "stat", path: "notes/hello.txt" })) as {
      exists: boolean;
      bytes: number;
    };
    expect(stat).toEqual({ exists: true, bytes: 2 });

    const list = (await loader.callCapability("demo.fs", "fs.scoped", { op: "list" })) as {
      exists: boolean;
      entries: { name: string }[];
    };
    expect(list.entries.map((entry) => entry.name)).toEqual(["notes/hello.txt"]);

    const removed = (await loader.callCapability("demo.fs", "fs.scoped", { op: "remove", path: "notes/hello.txt" })) as {
      removed: boolean;
    };
    expect(removed.removed).toBe(true);

    const gone = (await loader.callCapability("demo.fs", "fs.scoped", { op: "read", path: "notes/hello.txt" })) as {
      exists: boolean;
    };
    expect(gone.exists).toBe(false);
  });

  it("transport 收到调用方插件 id（每插件隔离）与 op/path/data", async () => {
    const loaderAB = createCapabilityLoader();
    loaderAB.register(fsManifest("demo.fs.a"));
    loaderAB.register(fsManifest("demo.fs.b"));
    loaderAB.grantCapability("demo.fs.a", "fs.scoped");
    loaderAB.grantCapability("demo.fs.b", "fs.scoped");
    await loaderAB.activate("demo.fs.a");
    await loaderAB.activate("demo.fs.b");
    setPluginFsTransportForHost(host.transport);

    await loaderAB.callCapability("demo.fs.a", "fs.scoped", { op: "write", path: "a.txt", data: "A" });
    await loaderAB.callCapability("demo.fs.b", "fs.scoped", { op: "write", path: "a.txt", data: "B" });

    expect(host.calls.map((call) => [call.pluginId, call.path, call.data])).toEqual([
      ["demo.fs.a", "a.txt", "A"],
      ["demo.fs.b", "a.txt", "B"],
    ]);
  });
});

describe("fs.scoped 参数校验", () => {
  it("拒绝非法 op / read 空路径 / 非 write 携带 data / data 非字符串", async () => {
    await expect(loader.callCapability("demo.fs", "fs.scoped", { op: "rename", path: "a.txt" })).rejects.toThrow(/fs\.scoped requires/);
    await expect(loader.callCapability("demo.fs", "fs.scoped", { op: "read", path: "  " })).rejects.toThrow(/requires/);
    await expect(loader.callCapability("demo.fs", "fs.scoped", { op: "read", path: "a.txt", data: "x" })).rejects.toThrow(/requires/);
    await expect(loader.callCapability("demo.fs", "fs.scoped", { op: "write", path: "a.txt", data: 42 })).rejects.toThrow(/requires/);
    await expect(loader.callCapability("demo.fs", "fs.scoped", { op: "write", path: `x`.repeat(1200), data: "" })).rejects.toThrow(
      /requires/,
    );
    // 非法请求不应触达宿主。
    expect(host.calls).toHaveLength(0);
  });

  it("list / stat 允许空路径（= 沙箱根）", async () => {
    await loader.callCapability("demo.fs", "fs.scoped", { op: "write", path: "sub/x.txt", data: "1" });
    const listed = (await loader.callCapability("demo.fs", "fs.scoped", { op: "list", path: "" })) as {
      entries: { name: string }[];
    };
    expect(listed.entries.map((entry) => entry.name)).toEqual(["sub/x.txt"]);
  });
});

describe("fs.scoped 宿主可用性与审计", () => {
  it("无宿主 transport 时调用直接失败并留 denied 审计", async () => {
    setPluginFsTransportForHost(null);
    await expect(loader.callCapability("demo.fs", "fs.scoped", { op: "read", path: "x.txt" })).rejects.toThrow(/desktop or server host/);
    expect(
      capabilityAuditLog().some((entry) => entry.plugin === "demo.fs" && entry.capability === "fs.scoped" && entry.outcome === "denied"),
    ).toBe(true);
  });

  it("宿主抛错 → error 审计 + 错误上抛", async () => {
    setPluginFsTransportForHost(async () => {
      throw new Error("quota exceeded");
    });
    await expect(loader.callCapability("demo.fs", "fs.scoped", { op: "write", path: "a.txt", data: "x" })).rejects.toThrow(
      /quota exceeded/,
    );
    expect(
      capabilityAuditLog().some((entry) => entry.plugin === "demo.fs" && entry.capability === "fs.scoped" && entry.outcome === "error"),
    ).toBe(true);
  });

  it("成功调用留 ok 审计", async () => {
    await loader.callCapability("demo.fs", "fs.scoped", { op: "write", path: "a.txt", data: "x" });
    expect(
      capabilityAuditLog().some(
        (entry) =>
          entry.plugin === "demo.fs" && entry.capability === "fs.scoped" && entry.outcome === "ok" && entry.detail === "write a.txt",
      ),
    ).toBe(true);
  });
});

describe("fs.scoped 门禁", () => {
  it("未声明 / 未激活调用被拒；revoke 后即时拒绝", async () => {
    const loaderDeny = createCapabilityLoader();
    loaderDeny.register(fsManifest("demo.fs.quiet"));
    await expect(loaderDeny.callCapability("demo.fs.quiet", "fs.scoped", { op: "list" })).rejects.toThrow(/not active/);

    loaderDeny.grantCapability("demo.fs.quiet", "fs.scoped");
    await loaderDeny.activate("demo.fs.quiet");
    await expect(loaderDeny.callCapability("demo.fs.quiet", "fs.scoped", { op: "list" })).resolves.toMatchObject({ exists: true });

    loaderDeny.revokeCapability("demo.fs.quiet", "fs.scoped");
    const callsBeforeRevoke = host.calls.length;
    await expect(loaderDeny.callCapability("demo.fs.quiet", "fs.scoped", { op: "list" })).rejects.toThrow(/revoked/);
    // revoke 后的调用不再触达宿主。
    expect(host.calls).toHaveLength(callsBeforeRevoke);
  });
});
