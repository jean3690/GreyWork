import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCapabilityLoader, type CapabilityLoader } from "@/plugins/loader";
import {
  capabilityAuditLog,
  resetCapabilityAuditForTest,
  resetMcpRateLimitForTest,
  setPluginMcpTransportForHost,
  type PluginMcpCallRequest,
  type PluginMcpTransport,
} from "@/plugins/capabilities";
import type { PluginManifest } from "@/plugins/types";

/**
 * mcp.connect 能力单测（node 环境，注入宿主伪传输）：
 *  - 按 manifest 里的服务器名 + 工具白名单放行；两者都必须显式声明
 *  - 参数校验（空 server / 空 tool / arguments 非对象 / 超长）不触达宿主
 *  - 白名单外的服务器或工具直接拒绝（不触达宿主，留 denied 审计）
 *  - 无宿主 transport → denied 审计；宿主抛错 → error 审计 + 上抛
 *  - 滑动窗口限速（30 次 / 1 分钟，按插件隔离）
 *
 * 宿主侧的连接参数（url / command / env / headers）来自用户设置，由 market.ts 的
 * 传输层解析；插件只传服务器名与工具名，永远看不到凭据。
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

/** 内存宿主：还原 plugin_mcp_call 的返回形态（只给正文）。 */
function memoryHost(): { transport: PluginMcpTransport; calls: PluginMcpCallRequest[] } {
  const calls: PluginMcpCallRequest[] = [];
  const transport: PluginMcpTransport = async (request) => {
    calls.push(request);
    if (request.arguments?.fail === true) throw new Error("mcp stdio call timed out");
    return { transport: "http", isError: false, text: `echo:${request.tool}`, durationMs: 3 };
  };
  return { transport, calls };
}

let loader: CapabilityLoader;
let host: ReturnType<typeof memoryHost>;

function mcpManifest(
  id = "demo.mcp",
  servers: Array<{ name: string; tools: string[] }> = [{ name: "fs", tools: ["read_file", "list_dir"] }],
): PluginManifest {
  return { id, name: "MCP 插件", version: "1.0.0", requires: [{ capability: "mcp.connect", servers }] };
}

async function setupGranted(id = "demo.mcp", servers?: Array<{ name: string; tools: string[] }>): Promise<void> {
  loader.register(mcpManifest(id, servers));
  loader.grantCapability(id, "mcp.connect");
  await loader.activate(id);
}

beforeEach(async () => {
  injectStorage();
  resetCapabilityAuditForTest();
  resetMcpRateLimitForTest();
  host = memoryHost();
  setPluginMcpTransportForHost(host.transport);
  loader = createCapabilityLoader();
  await setupGranted();
});

afterEach(() => {
  setPluginMcpTransportForHost(null);
  resetCapabilityAuditForTest();
  resetMcpRateLimitForTest();
  delete storageHolder.localStorage;
});

describe("mcp.connect 基本契约", () => {
  it("按服务器名 + 工具名放行，并把白名单一并交给宿主复核", async () => {
    const result = (await loader.callCapability("demo.mcp", "mcp.connect", {
      server: "fs",
      tool: "read_file",
      arguments: { path: "README.md" },
    })) as { isError: boolean; text: string };

    expect(result).toEqual({ transport: "http", isError: false, text: "echo:read_file" });
    expect(host.calls).toEqual([
      {
        pluginId: "demo.mcp",
        server: "fs",
        tool: "read_file",
        arguments: { path: "README.md" },
        allowedTools: ["read_file", "list_dir"],
      },
    ]);
  });

  it("审计记录成功调用（服务器/工具 + 正文字数）", async () => {
    await loader.callCapability("demo.mcp", "mcp.connect", { server: "fs", tool: "list_dir" });
    const entry = capabilityAuditLog().find((item) => item.capability === "mcp.connect" && item.outcome === "ok");
    expect(entry?.detail).toBe("fs/list_dir · 13 chars");
  });
});

describe("mcp.connect 参数校验", () => {
  it("拒绝缺 server / 缺 tool / arguments 非对象 / 超长，且不触达宿主", async () => {
    await expect(loader.callCapability("demo.mcp", "mcp.connect", { tool: "read_file" })).rejects.toThrow(/requires/);
    await expect(loader.callCapability("demo.mcp", "mcp.connect", { server: "fs" })).rejects.toThrow(/requires/);
    await expect(loader.callCapability("demo.mcp", "mcp.connect", { server: " ", tool: "read_file" })).rejects.toThrow(/requires/);
    await expect(
      loader.callCapability("demo.mcp", "mcp.connect", { server: "fs", tool: "read_file", arguments: ["nope"] }),
    ).rejects.toThrow(/requires/);
    await expect(
      loader.callCapability("demo.mcp", "mcp.connect", {
        server: "fs",
        tool: "read_file",
        arguments: { blob: "x".repeat(17 * 1024) },
      }),
    ).rejects.toThrow(/requires/);
    expect(host.calls).toHaveLength(0);
  });

  it("白名单外的服务器 / 工具直接拒绝（不触达宿主，留 denied 审计）", async () => {
    await expect(loader.callCapability("demo.mcp", "mcp.connect", { server: "db", tool: "read_file" })).rejects.toThrow(
      /server not allowed/,
    );
    await expect(loader.callCapability("demo.mcp", "mcp.connect", { server: "fs", tool: "delete_file" })).rejects.toThrow(
      /tool not allowed/,
    );
    expect(host.calls).toHaveLength(0);
    expect(capabilityAuditLog().filter((entry) => entry.outcome === "denied")).toHaveLength(2);
  });

  it("manifest 只声明字符串形态（无 servers）→ 拒绝，不回落全部服务器", async () => {
    const loose = createCapabilityLoader();
    loose.register({ id: "demo.mcp.loose", name: "宽松", version: "1.0.0", requires: ["mcp.connect"] });
    loose.grantCapability("demo.mcp.loose", "mcp.connect");
    await loose.activate("demo.mcp.loose");
    await expect(loose.callCapability("demo.mcp.loose", "mcp.connect", { server: "fs", tool: "read_file" })).rejects.toThrow(
      /servers allowlist/,
    );
    expect(host.calls).toHaveLength(0);
  });
});

describe("mcp.connect 宿主可用性与审计", () => {
  it("无宿主 transport 时调用失败并留 denied 审计", async () => {
    setPluginMcpTransportForHost(null);
    await expect(loader.callCapability("demo.mcp", "mcp.connect", { server: "fs", tool: "read_file" })).rejects.toThrow(
      /desktop or server host/,
    );
    expect(
      capabilityAuditLog().some((entry) => entry.plugin === "demo.mcp" && entry.capability === "mcp.connect" && entry.outcome === "denied"),
    ).toBe(true);
  });

  it("宿主抛错 → error 审计 + 错误上抛", async () => {
    await expect(
      loader.callCapability("demo.mcp", "mcp.connect", { server: "fs", tool: "read_file", arguments: { fail: true } }),
    ).rejects.toThrow(/timed out/);
    expect(capabilityAuditLog().some((entry) => entry.capability === "mcp.connect" && entry.outcome === "error")).toBe(true);
  });
});

describe("mcp.connect 限速", () => {
  it("1 分钟窗口内第 31 次拒绝，且不触达宿主", async () => {
    const guarded = createCapabilityLoader();
    guarded.register(mcpManifest("demo.mcp.burst"));
    guarded.grantCapability("demo.mcp.burst", "mcp.connect");
    await guarded.activate("demo.mcp.burst");

    for (let index = 0; index < 30; index += 1) {
      await guarded.callCapability("demo.mcp.burst", "mcp.connect", { server: "fs", tool: "list_dir" });
    }
    const before = host.calls.length;
    await expect(guarded.callCapability("demo.mcp.burst", "mcp.connect", { server: "fs", tool: "list_dir" })).rejects.toThrow(/rate limit/);
    expect(host.calls).toHaveLength(before);
  });
});

describe("mcp.connect 门禁", () => {
  it("未激活调用被拒；revoke 后即时拒绝且不再触达宿主", async () => {
    const guarded = createCapabilityLoader();
    guarded.register(mcpManifest("demo.mcp.quiet"));
    await expect(guarded.callCapability("demo.mcp.quiet", "mcp.connect", { server: "fs", tool: "read_file" })).rejects.toThrow(
      /not active/,
    );

    guarded.grantCapability("demo.mcp.quiet", "mcp.connect");
    await guarded.activate("demo.mcp.quiet");
    await expect(guarded.callCapability("demo.mcp.quiet", "mcp.connect", { server: "fs", tool: "read_file" })).resolves.toMatchObject({
      text: "echo:read_file",
    });

    guarded.revokeCapability("demo.mcp.quiet", "mcp.connect");
    const before = host.calls.length;
    await expect(guarded.callCapability("demo.mcp.quiet", "mcp.connect", { server: "fs", tool: "read_file" })).rejects.toThrow(/revoked/);
    expect(host.calls).toHaveLength(before);
  });
});
