/**
 * ACP 会话配置选项的通用判定与标签（cowork 成员配置、主会话配置簇共用）。
 *
 * 思考强度类配置项的 id 因 agent 而异（opencode 用 category=thought_level + id=effort；
 * codex / claude-code 等用 reasoning_effort / thought_level…），统一按 category 或 id
 * 特征识别，避免写死单一 id 导致后端一换整块配置就消失。
 */
import { i18n } from "../i18n";

const t = i18n.global.t;

export interface AcpConfigOptionLike {
  id: string;
  category?: string;
  name?: string;
}

/** 是否为思考强度类配置项。 */
export function isThoughtLevelConfigOption(entry: AcpConfigOptionLike): boolean {
  return entry.category === "thought_level" || entry.id === "effort" || entry.id === "reasoning_effort" || entry.id === "thought_level";
}

/** 配置项的展示标签：已知类别走本地化文案，未知回落 agent 自带 name（再兜底 id）。 */
export function configOptionLabel(entry: AcpConfigOptionLike): string {
  if (isThoughtLevelConfigOption(entry)) return t("chat.configThoughtLevel");
  if (entry.category === "mode" || entry.id === "mode") return t("chat.configMode");
  return entry.name || entry.id;
}
