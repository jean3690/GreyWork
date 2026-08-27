import type { Project } from "../types";

/** mock 项目清单：Projects 为顶层组织（第一项为默认项目）。 */
export const MOCK_PROJECTS: Project[] = [
  { id: "p-gw-main", name: "GreyWork 主仓", description: "工作台与能力包主仓库" },
  { id: "p-city", name: "城市数据洞察", description: "站点客流 / 台风路径空间分析" },
  { id: "p-general", name: "普通对话", description: "未绑定项目的自由会话" },
];

export const DEFAULT_PROJECT_ID = MOCK_PROJECTS[0]?.id ?? "p-gw-main";
