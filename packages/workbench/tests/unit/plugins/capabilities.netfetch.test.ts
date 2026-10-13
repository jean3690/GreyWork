import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCapabilityLoader, type CapabilityLoader } from "@/plugins/loader";
import {
  CAPABILITY_REGISTRY,
  capabilityAuditLog,
  normalizeGrantSpec,
  resetCapabilityAuditForTest,
  setNetFetchTransportForHost,
  type NetFetchTransport,
} from "@/plugins/capabilities";

/**
 * net.fetch v2 能力 broker 契约单测：
 *  - methods / paths / maxBytes 声明归一化；
 *  - 方法子集门禁（默认 GET/HEAD；未声明 POST 即拒）；
 *  - POST 路径模板门禁（`*` 段内、`**` 跨段）；
 *  - body 仅 POST、受 maxBytes 约束；
 *  - 声明参数透传到宿主传输层（Rust 二次校验的输入）。
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

type NetFetchRequirement = {
  capability: "net.fetch";
  hosts: string[];
  methods?: string[];
  paths?: string[];
  maxBytes?: number;
};

const calls: Array<Parameters<NetFetchTransport>[0]> = [];

function installTransport(): void {
  calls.length = 0;
  setNetFetchTransportForHost(async (request) => {
    calls.push(request);
    return { status: 200, ok: true, headers: { "content-type": "application/json" }, body: "{}" };
  });
}

async function activateNetFetch(loader: CapabilityLoader, requirement: NetFetchRequirement, id = "demo.net"): Promise<void> {
  loader.register({
    id,
    name: "网络插件",
    version: "1.0.0",
    requires: [requirement],
  });
  loader.grantCapability(id, "net.fetch");
  await loader.activate(id);
}

let loader: CapabilityLoader;

beforeEach(() => {
  injectStorage();
  resetCapabilityAuditForTest();
  installTransport();
  loader = createCapabilityLoader();
});

afterEach(() => {
  setNetFetchTransportForHost(null);
  resetCapabilityAuditForTest();
  delete storageHolder.localStorage;
});

describe("net.fetch v2 声明归一化", () => {
  it("normalizeGrantSpec 保留 methods / paths / maxBytes", () => {
    expect(
      normalizeGrantSpec({
        capability: "net.fetch",
        hosts: ["api.github.com"],
        methods: ["GET", "POST"],
        paths: ["/graphql"],
        maxBytes: 2048,
      }),
    ).toEqual({
      capability: "net.fetch",
      hosts: ["api.github.com"],
      methods: ["GET", "POST"],
      paths: ["/graphql"],
      maxBytes: 2048,
    });
    // 旧形态仍归一出 undefined 字段（向后兼容）。
    expect(normalizeGrantSpec({ capability: "net.fetch", hosts: ["a.com"] })).toEqual({
      capability: "net.fetch",
      hosts: ["a.com"],
      methods: undefined,
      paths: undefined,
      maxBytes: undefined,
      schedule: undefined,
    });
  });

  it("注册表暴露 net.fetch（供插件中心展示）", () => {
    expect(CAPABILITY_REGISTRY["net.fetch"].danger).toBe("medium");
  });
});

describe("net.fetch v2 方法门禁", () => {
  it("未声明 methods 时仅 GET/HEAD；POST 被拒", async () => {
    await activateNetFetch(loader, { capability: "net.fetch", hosts: ["api.github.com"] });
    await expect(
      loader.callCapability("demo.net", "net.fetch", {
        url: "https://api.github.com/meta",
        method: "POST",
      }),
    ).rejects.toThrow(/method is not declared/);
    expect(calls).toHaveLength(0);
    expect(capabilityAuditLog().some((entry) => entry.capability === "net.fetch" && entry.outcome === "denied")).toBe(true);
  });

  it("声明 POST 后放行，并把 methods/paths/maxBytes 透传宿主", async () => {
    await activateNetFetch(loader, {
      capability: "net.fetch",
      hosts: ["api.github.com"],
      methods: ["GET", "POST"],
      paths: ["/repos/*/issues"],
      maxBytes: 4096,
    });
    const result = await loader.callCapability("demo.net", "net.fetch", {
      url: "https://api.github.com/repos/octocat/issues",
      method: "POST",
      body: "{}",
    });
    expect(result).toMatchObject({ status: 200 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      body: "{}",
      allowedHosts: ["api.github.com"],
      methods: ["GET", "POST"],
      paths: ["/repos/*/issues"],
      maxBytes: 4096,
    });
  });

  it("缺省声明的传输参数为 GET/HEAD + 1 MiB", async () => {
    await activateNetFetch(loader, { capability: "net.fetch", hosts: ["api.github.com"] });
    await loader.callCapability("demo.net", "net.fetch", { url: "https://api.github.com/meta" });
    expect(calls[0]).toMatchObject({ methods: ["GET", "HEAD"], paths: [], maxBytes: 1024 * 1024 });
  });
});

describe("net.fetch v2 POST 路径模板门禁", () => {
  it("路径不在模板内即拒（不触达传输）", async () => {
    await activateNetFetch(loader, {
      capability: "net.fetch",
      hosts: ["api.github.com"],
      methods: ["GET", "POST"],
      paths: ["/repos/*/issues"],
    });
    await expect(
      loader.callCapability("demo.net", "net.fetch", {
        url: "https://api.github.com/repos/octocat/pulls",
        method: "POST",
      }),
    ).rejects.toThrow(/path is not in the plugin allowlist/);
    expect(calls).toHaveLength(0);
  });

  it("`**` 模板跨段匹配", async () => {
    await activateNetFetch(loader, {
      capability: "net.fetch",
      hosts: ["api.github.com"],
      methods: ["POST"],
      paths: ["/v1/**"],
    });
    await expect(
      loader.callCapability("demo.net", "net.fetch", {
        url: "https://api.github.com/v1/a/b/c",
        method: "POST",
      }),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("声明 POST 却没有路径模板：拒绝", async () => {
    await activateNetFetch(loader, {
      capability: "net.fetch",
      hosts: ["api.github.com"],
      methods: ["POST"],
    });
    await expect(
      loader.callCapability("demo.net", "net.fetch", {
        url: "https://api.github.com/graphql",
        method: "POST",
      }),
    ).rejects.toThrow(/requires declared path templates/);
  });
});

describe("net.fetch v2 请求体门禁", () => {
  it("GET 带 body 被拒", async () => {
    await activateNetFetch(loader, { capability: "net.fetch", hosts: ["api.github.com"] });
    await expect(
      loader.callCapability("demo.net", "net.fetch", {
        url: "https://api.github.com/meta",
        body: "x",
      }),
    ).rejects.toThrow(/body is only allowed for POST/);
  });

  it("body 超过声明的 maxBytes 被拒", async () => {
    await activateNetFetch(loader, {
      capability: "net.fetch",
      hosts: ["api.github.com"],
      methods: ["POST"],
      paths: ["/graphql"],
      maxBytes: 1024,
    });
    await expect(
      loader.callCapability("demo.net", "net.fetch", {
        url: "https://api.github.com/graphql",
        method: "POST",
        body: "a".repeat(2048),
      }),
    ).rejects.toThrow(/request body exceeds 1024 bytes/);
    expect(calls).toHaveLength(0);
  });
});
