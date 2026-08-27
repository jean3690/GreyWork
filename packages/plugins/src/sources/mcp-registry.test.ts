// 官方 MCP 注册表条目 → McpServerManifest 的映射契约。
import { describe, expect, it } from "vitest";
import { mapMcpServers, slugifyMcpId, toMcpServerManifest } from "./mcp-registry";

const REMOTE_ENTRY = {
  name: "ac.inference.sh/mcp",
  title: "inference.sh",
  description: "Run 150+ AI apps",
  version: "1.0.0",
  remotes: [{ transport: "streamable-http", url: "https://api.inference.sh/mcp" }],
  packages: [],
};

const NPM_ONLY_ENTRY = {
  name: "example/npm-server",
  description: "stdio server",
  version: "2.1.0",
  remotes: [],
  packages: [
    {
      registryType: "npm",
      identifier: "@scope/mcp-server",
      version: "2.1.0",
      envNames: ["API_TOKEN"],
    },
    { registryType: "oci", identifier: "ghcr.io/x/server", envNames: [] },
  ],
};

describe("mapMcpServers", () => {
  it("skips entries without a name and malformed payloads", () => {
    const entries = mapMcpServers({
      servers: [{ server: { name: "a/b" } }, { server: {} }, "garbage"],
    });
    expect(entries.map((entry) => entry.name)).toEqual(["a/b"]);
    expect(mapMcpServers(null)).toEqual([]);
  });
});

describe("slugifyMcpId", () => {
  it("folds scoped names into mcp- slugs", () => {
    expect(slugifyMcpId("ac.inference.sh/mcp")).toBe("mcp-ac-inference-sh-mcp");
    expect(slugifyMcpId("@scope/Server")).toBe("mcp-scope-server");
    expect(slugifyMcpId("***")).toBe("mcp-server");
  });
});

describe("toMcpServerManifest", () => {
  it("prefers remote direct-connect over package install", () => {
    const manifest = toMcpServerManifest({
      ...REMOTE_ENTRY,
      packages: NPM_ONLY_ENTRY.packages,
    });
    expect(manifest).toMatchObject({
      kind: "mcp-server",
      id: "mcp-ac-inference-sh-mcp",
      transport: "streamable-http",
      url: "https://api.inference.sh/mcp",
      version: "1.0.0",
    });
  });

  it("maps npm packages to whitelisted stdio shape with env tags", () => {
    const manifest = toMcpServerManifest(NPM_ONLY_ENTRY);
    expect(manifest).toMatchObject({
      kind: "mcp-server",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@scope/mcp-server"],
      env: {},
    });
    // 必填环境变量以标签透出，描述中提示
    expect(manifest?.tags).toContain("env:API_TOKEN");
    expect(manifest?.description).toContain("API_TOKEN");
  });

  it("returns null when no supported transport exists", () => {
    expect(
      toMcpServerManifest({ name: "x/y", remotes: [], packages: [{ registryType: "oci", identifier: "img", envNames: [] }] }),
    ).toBeNull();
  });
});
