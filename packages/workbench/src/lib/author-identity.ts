/**
 * 作者身份：把消息的作者键映射成稳定的展示身份（名称 + 头像色 + 首字母）。
 *
 * 群聊式时间线里同一条流上混着用户、leader 与各成员位；每个作者必须有稳定可辨的头像
 * 与颜色，否则「谁说的」就退化成一串同色气泡。颜色复用 docs/ui-design.md 定义的
 * `--grey-*` agent 身份色族（见 theme/tokens.css），不新增 token。
 *
 * 纯函数、无依赖：渲染层（ConversationMessage）与团队时间线都能直接用。
 */

/** 身份色族：与 theme/tokens.css 的 `--grey-*` 一一对应。 */
const AUTHOR_COLORS = ["--grey-blue", "--grey-green", "--grey-orange", "--grey-violet", "--grey-red"] as const;

/** 人类用户固定用品牌蓝，不参与哈希 —— 它是「我」，颜色应当一眼可辨且跨会话稳定。 */
const USER_COLOR = "--grey-blue";
/** 系统消息用中性紫，和真实参与者区分开。 */
const SYSTEM_COLOR = "--grey-violet";

export interface AuthorIdentity {
  /** 稳定作者键（`user` / `system` / 成员位 id）。 */
  id: string;
  /** 展示名。 */
  name: string;
  /** 头像背景（CSS var 引用）。 */
  color: string;
  /** 头像首字母。 */
  initial: string;
}

/** 简易字符串散列：只为把作者键稳定地铺到调色板上，不追求分布质量。 */
function hash(value: string): number {
  let acc = 0;
  for (let index = 0; index < value.length; index += 1) acc = (acc * 31 + value.charCodeAt(index)) >>> 0;
  return acc;
}

/** 由作者键推出稳定颜色：同一作者永远同色，跨会话也一致。 */
export function authorColor(id: string): string {
  if (id === "user") return `var(${USER_COLOR})`;
  if (id === "system") return `var(${SYSTEM_COLOR})`;
  return `var(${AUTHOR_COLORS[hash(id) % AUTHOR_COLORS.length]})`;
}

/** 首字母：取首个可见字符（CJK 直接取该字，拉丁取大写），空名回落 `?`。 */
export function authorInitial(name: string): string {
  const first = [...name.trim()][0];
  return first ? first.toUpperCase() : "?";
}

/** 组装一个作者身份（name 缺省回落到 id）。 */
export function authorIdentity(id: string, name?: string): AuthorIdentity {
  const display = name?.trim() || id;
  return { id, name: display, color: authorColor(id), initial: authorInitial(display) };
}
