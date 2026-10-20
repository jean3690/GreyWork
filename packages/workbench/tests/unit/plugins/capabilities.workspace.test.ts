import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCapabilityLoader, type CapabilityLoader } from "@/plugins/loader";
import {
  capabilityAuditLog,
  resetCapabilityAuditForTest,
  setPluginWorkspaceTransportForHost,
  type PluginWorkspaceTransport,
} from "@/plugins/capabilities";
import type { PluginManifest } from "@/plugins/types";

/**
 * workspace.read 能力单测（node 环境，注入宿主伪传输）：
 *  - roots / read 的返回契约与 transport 收到的请求（pluginId / op / path）
 *  - 参数校验（未知 op、read 空路径、roots 携带 path）
 *  - 无宿主 transport → denied 审计；宿主抛错 → error 审计 + 上抛
 *  - 门禁（未激活 / revoke 即时拒绝，且不触达宿主）
 *
 * Rust 侧的授权根解析 / 256 KiB 截断 / 二进制拒绝见
 * `plugin_market::plugin_workspace` 的单测。
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

interface WorkspaceCall {
  pluginId: string;
  op: string;
  path?: string;
}

/** 内存宿主：还原 Rust plugin_workspace 的响应形态。 */
function memoryHost(): { transport: PluginWorkspaceTransport; calls: WorkspaceCall[] } {
  const calls: WorkspaceCall[] = [];
  const transport: PluginWorkspaceTransport = async (request) => {
    calls.push({ pluginId: request.pluginId, op: request.op, path: request.path });
    if (request.op === "roots") {
      return { roots: [{ path: "/ws/proj", name: "proj" }] };
    }
    if (request.path === "/ws/missing.md") {
      throw new Error("workspace.read path is not an authorized existing path");
    }
    return {
      exists: true,
      path: request.path,
      name: "README.md",
      data: "# hi",
      bytes: 4,
      truncated: false,
    };
  };
  return { transport, calls };
}

let loader: CapabilityLoader;
let host: ReturnType<typeof memoryHost>;

function workspaceManifest(id = "demo.workspace"): PluginManifest {
  return { id, name: "工作区插件", version: "1.0.0", requires: ["workspace.read"] };
}

async function setupGranted(id = "demo.workspace"): Promise<void> {
  loader.register(workspaceManifest(id));
  loader.grantCapability(id, "workspace.read");
  await loader.activate(id);
}

beforeEach(async () => {
  injectStorage();
  resetCapabilityAuditForTest();
  host = memoryHost();
  setPluginWorkspaceTransportForHost(host.transport);
  loader = createCapabilityLoader();
  await setupGranted();
});

afterEach(() => {
  setPluginWorkspaceTransportForHost(null);
  resetCapabilityAuditForTest();
  delete storageHolder.localStorage;
});

describe("workspace.read 基本契约", () => {
  it("roots 列出授权根；read 返回文本与元数据", async () => {
    const roots = (await loader.callCapability("demo.workspace", "workspace.read", { op: "roots" })) as {
      roots: { path: string; name: string }[];
    };
    expect(roots.roots).toEqual([{ path: "/ws/proj", name: "proj" }]);

    const read = (await loader.callCapability("demo.workspace", "workspace.read", {
      op: "read",
      path: "/ws/proj/README.md",
    })) as { exists: boolean; path: string; name: string; data: string; bytes: number; truncated: boolean };
    expect(read).toEqual({
      exists: true,
      path: "/ws/proj/README.md",
      name: "README.md",
      data: "# hi",
      bytes: 4,
      truncated: false,
    });

    expect(host.calls).toEqual([
      { pluginId: "demo.workspace", op: "roots", path: undefined },
      { pluginId: "demo.workspace", op: "read", path: "/ws/proj/README.md" },
    ]);
  });

  it("审计记录 roots / read 的成功调用", async () => {
    await loader.callCapability("demo.workspace", "workspace.read", { op: "roots" });
    await loader.callCapability("demo.workspace", "workspace.read", { op: "read", path: "/ws/proj/README.md" });
    const details = capabilityAuditLog()
      .filter((entry) => entry.capability === "workspace.read" && entry.outcome === "ok")
      .map((entry) => entry.detail);
    expect(details).toContain("roots (1)");
    expect(details).toContain("read /ws/proj/README.md");
  });
});

describe("workspace.read 参数校验", () => {
  it("拒绝未知 op / read 空路径 / roots 携带 path，且不触达宿主", async () => {
    await expect(loader.callCapability("demo.workspace", "workspace.read", { op: "write", path: "/ws/a" })).rejects.toThrow(
      /workspace\.read requires/,
    );
    await expect(loader.callCapability("demo.workspace", "workspace.read", { op: "read", path: "  " })).rejects.toThrow(/requires/);
    await expect(loader.callCapability("demo.workspace", "workspace.read", { op: "roots", path: "/ws/a" })).rejects.toThrow(/requires/);
    expect(host.calls).toHaveLength(0);
  });
});

describe("workspace.read 宿主可用性与审计", () => {
  it("无宿主 transport 时调用失败并留 denied 审计", async () => {
    setPluginWorkspaceTransportForHost(null);
    await expect(loader.callCapability("demo.workspace", "workspace.read", { op: "roots" })).rejects.toThrow(/desktop or server host/);
    expect(
      capabilityAuditLog().some(
        (entry) => entry.plugin === "demo.workspace" && entry.capability === "workspace.read" && entry.outcome === "denied",
      ),
    ).toBe(true);
  });

  it("宿主拒绝（路径未授权）→ error 审计 + 错误上抛", async () => {
    await expect(loader.callCapability("demo.workspace", "workspace.read", { op: "read", path: "/ws/missing.md" })).rejects.toThrow(
      /not an authorized existing path/,
    );
    expect(
      capabilityAuditLog().some(
        (entry) => entry.plugin === "demo.workspace" && entry.capability === "workspace.read" && entry.outcome === "error",
      ),
    ).toBe(true);
  });
});

describe("workspace.read 门禁", () => {
  it("未激活调用被拒；revoke 后即时拒绝且不再触达宿主", async () => {
    const guarded = createCapabilityLoader();
    guarded.register(workspaceManifest("demo.workspace.quiet"));
    await expect(guarded.callCapability("demo.workspace.quiet", "workspace.read", { op: "roots" })).rejects.toThrow(/not active/);

    guarded.grantCapability("demo.workspace.quiet", "workspace.read");
    await guarded.activate("demo.workspace.quiet");
    await expect(guarded.callCapability("demo.workspace.quiet", "workspace.read", { op: "roots" })).resolves.toMatchObject({
      roots: [{ path: "/ws/proj" }],
    });

    guarded.revokeCapability("demo.workspace.quiet", "workspace.read");
    const before = host.calls.length;
    await expect(guarded.callCapability("demo.workspace.quiet", "workspace.read", { op: "roots" })).rejects.toThrow(/revoked/);
    expect(host.calls).toHaveLength(before);
  });
});
