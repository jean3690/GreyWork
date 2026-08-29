import type { Workspace } from "../types";

/** mock 工作区清单：会话的顶层组织（第一项为默认工作区）。 */
export const MOCK_WORKSPACES: Workspace[] = [
  { id: "p-gw-main", name: "GreyWork 主仓", description: "工作台与能力包主仓库" },
  { id: "p-city", name: "城市数据洞察", description: "站点客流 / 台风路径空间分析" },
  { id: "p-general", name: "普通对话", description: "未绑定工作区的自由会话" },
];

export const DEFAULT_WORKSPACE_ID = MOCK_WORKSPACES[0]?.id ?? "p-gw-main";
