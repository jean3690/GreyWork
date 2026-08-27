import { DEFAULT_COMMAND_POLICY } from "@greywork/plugins";
import type { AiLoopPolicy, PluginMarketEntry } from "./types";

export const SAMPLE_PLUGIN_MARKET: PluginMarketEntry[] = [
  {
    id: "skill-gis",
    name: "GIS 分析 Skill",
    version: "0.2.1",
    author: "GreyWork",
    description: "GeoJSON/MBTiles 空间分析与可视化指令集",
    tags: ["skill", "gis"],
    downloads: 3200,
    rating: 4.8,
  },
  {
    id: "ext-github",
    name: "GitHub Connector",
    version: "0.1.4",
    author: "GreyWork",
    description: "Issue / PR / 代码评审接入",
    tags: ["extension", "github"],
    downloads: 2100,
    rating: 4.6,
  },
  {
    id: "mcp-cesium",
    name: "Cesium MCP",
    version: "0.3.0",
    author: "Community",
    description: "CesiumJS 数字地球 MCP 桥接",
    tags: ["mcp", "3d"],
    downloads: 540,
    rating: 4.4,
  },
  {
    id: "skill-report",
    name: "报告生成 Skill",
    version: "0.1.0",
    author: "GreyWork",
    description: "分析结果一键转 Markdown/PDF 报告",
    tags: ["skill", "report"],
    downloads: 980,
    rating: 4.7,
  },
];

export const DEFAULT_AI_LOOP_POLICY: AiLoopPolicy = {
  maxRounds: 12,
  commandGuard: DEFAULT_COMMAND_POLICY,
  toolAllowlist: ["read_file", "web_search", "spatial_query", "git_diff"],
  requireApproval: ["git push", "rm -rf", "publish"],
};
