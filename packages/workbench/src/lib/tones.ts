/** AionUI 多色 Agent 系统：角色 / 提供方 → 主题色调（CSS 变量引用，随令牌同源）。
 * 纯数据映射：调用处直接索引，未命中回退 DEFAULT_TONE。 */

/** 未收录角色 / 提供方的回退色（品牌蓝）。 */
export const DEFAULT_TONE = "var(--aion-blue)";

/** Agent 角色 → 主题色。 */
export const AGENT_ROLE_TONES: Record<string, string> = {
  planner: "var(--aion-blue)",
  "geo-analyst": "var(--aion-green)",
  "spatial-artist": "var(--aion-violet)",
  reviewer: "var(--aion-orange)",
};

/** ACP 后端 / 助手提供方轮换色板（按索引取模）。 */
export const PROVIDER_TONES: readonly string[] = [
  "var(--aion-blue)",
  "var(--aion-violet)",
  "var(--aion-green)",
  "var(--aion-orange)",
  "var(--aion-red)",
];

/** 同色系的浅底（图标底色 / 徽章底）。 */
export const TONE_SOFT: Record<string, string> = {
  "var(--aion-blue)": "rgba(59, 130, 246, 0.12)",
  "var(--aion-green)": "rgba(16, 185, 129, 0.12)",
  "var(--aion-orange)": "rgba(245, 158, 11, 0.12)",
  "var(--aion-violet)": "rgba(139, 92, 246, 0.12)",
  "var(--aion-red)": "rgba(239, 68, 68, 0.12)",
};
