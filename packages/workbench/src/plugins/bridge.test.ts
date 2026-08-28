// 桥接层验收：市场插件 manifest → 能力注册表清单；安装/卸载经 sync 产生/移除 UI 贡献。
import { describe, expect, it } from "vitest";
import { createPluginStore, type PluginManifest } from "@greywork/plugins";
import { createCapabilityLoader } from "./loader";
import { seamifyMarketManifest, syncMarketToCapabilities } from "./bridge";

const gisView: PluginManifest = {
  id: "ext-gis",
  kind: "extension",
  type: "ui",
  name: "GIS 视图",
  version: "0.1.0",
  entry: "views/gis.ts",
  contributes: { views: ["gis"], panels: ["activity.terminal"] },
};
const githubConnector: PluginManifest = {
  id: "ext-github",
  kind: "extension",
  type: "connector",
  name: "GitHub Connector",
  version: "0.1.4",
  entry: "connectors/github.ts",
  contributes: { commands: ["github.list-issues"] },
};
const skill: PluginManifest = {
  id: "skill-gis",
  kind: "skill",
  name: "GIS 分析 Skill",
  version: "0.2.1",
  entry: "skills/gis.md",
};
const mcp: PluginManifest = {
  id: "mcp-cesium",
  kind: "mcp-server",
  name: "Cesium MCP",
  version: "0.3.0",
  transport: "streamable-http",
  url: "http://localhost:9100/mcp",
};
const ghostView: PluginManifest = {
  id: "ext-ghost",
  kind: "extension",
  type: "ui",
  name: "Ghost",
  version: "0.1.0",
  entry: "views/ghost.ts",
  contributes: { views: ["ghost-view"] },
};

describe("seamifyMarketManifest", () => {
  it("ui extension 的 views/panels 映射为 modes/uiRegions", () => {
    const seam = seamifyMarketManifest(gisView);
    expect(seam?.id).toBe("ext-gis");
    expect(seam?.contributes?.modes?.map((mode) => mode.id)).toEqual(["ext:ext-gis:gis"]);
    expect(seam?.contributes?.uiRegions?.map((region) => region.id)).toEqual(["ext:ext-gis:activity.terminal"]);
  });

  it("skill / mcp-server / 非 ui extension 仅登记 capabilities", () => {
    expect(seamifyMarketManifest(skill)?.contributes?.capabilities).toEqual(["skill:skill-gis"]);
    expect(seamifyMarketManifest(mcp)?.contributes?.capabilities).toEqual(["mcp-server:mcp-cesium"]);
    expect(seamifyMarketManifest(githubConnector)?.contributes?.capabilities).toEqual(["extension:ext-github"]);
  });

  it("无法解析的 views 降级为 capabilities 登记", () => {
    const seam = seamifyMarketManifest(ghostView);
    expect(seam?.contributes?.modes ?? []).toHaveLength(0);
    expect(seam?.contributes?.capabilities).toEqual(["extension:ext-ghost"]);
  });
});

describe("syncMarketToCapabilities", () => {
  it("安装后贡献出现在 snapshot，卸载后消失", async () => {
    const loader = createCapabilityLoader();
    const market = createPluginStore({ remoteMarketplace: [gisView, skill], initialInstalled: [], persist: false });
    await syncMarketToCapabilities(market, loader);
    expect(loader.snapshot().modes.map((mode) => mode.id)).not.toContain("ext:ext-gis:gis");

    expect(market.install("ext-gis")).toBe(true);
    await syncMarketToCapabilities(market, loader);
    expect(loader.snapshot().modes.map((mode) => mode.id)).toContain("ext:ext-gis:gis");
    expect(loader.snapshot().uiRegions.map((region) => region.id)).toContain("ext:ext-gis:activity.terminal");
    expect(loader.activeIds()).toContain("ext-gis");

    expect(market.uninstall("ext-gis")).toBe(true);
    await syncMarketToCapabilities(market, loader);
    expect(loader.snapshot().modes.map((mode) => mode.id)).not.toContain("ext:ext-gis:gis");
    expect(loader.activeIds()).not.toContain("ext-gis");
  });

  it("已安装 skill 只登记 capabilities，不产生 UI 贡献", async () => {
    const loader = createCapabilityLoader();
    const market = createPluginStore({ remoteMarketplace: [skill], initialInstalled: ["skill-gis"], persist: false });
    await syncMarketToCapabilities(market, loader);
    expect(loader.snapshot().modes).toHaveLength(0);
    expect(loader.snapshot().uiRegions).toHaveLength(0);
    expect(loader.activeIds()).toContain("skill-gis");
  });

  it("重复同步幂等：不重复注册也不抛错", async () => {
    const loader = createCapabilityLoader();
    const market = createPluginStore({ remoteMarketplace: [gisView], initialInstalled: ["ext-gis"], persist: false });
    await syncMarketToCapabilities(market, loader);
    await syncMarketToCapabilities(market, loader);
    expect(loader.snapshot().modes.map((mode) => mode.id)).toEqual(["ext:ext-gis:gis"]);
    expect(loader.activeIds()).toEqual(["ext-gis"]);
  });
});
