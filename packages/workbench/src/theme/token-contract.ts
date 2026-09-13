/**
 * GreyWork 主题令牌契约（M6）——对标 GreyWork `common/theme/tokenContract.ts`。
 *
 * 权威的可覆盖 CSS 自定义属性清单：任何主题改写通道（未来编辑器 / 用户主题）
 * 只能改这里的 key，用 {@link isThemeTokenKey} 做 O(1) 校验。清单镜像
 * `theme/tokens.css` 中的语义变量，不发明新名。
 *
 * 两层 scope（同 GreyWork）：
 *  - `appearance-invariant`：明暗两态取值相同 → 定义在 `:root`，两态通用
 *    （如 --console 固定深底、--grey-* 品牌色、字族）。
 *  - `appearance-scoped`：明暗取值不同 → 定义在 `:root`（浅）并被
 *    `:root[data-theme="dark"]` 覆盖。
 *
 * 结构布局变量（--gw-*）不属于主题可覆盖的颜色通道，刻意排除在契约外。
 */

/** 令牌在明/暗外观下的行为。 */
export type TokenScope = "appearance-invariant" | "appearance-scoped";

/** 单个可覆盖令牌及元信息。 */
export interface ThemeTokenDescriptor {
  /** 含前导 `--` 的 CSS 自定义属性名。 */
  key: string;
  /** 语义分组（文档 / 未来编辑器分组用）。 */
  group: ThemeTokenGroup;
  /** 两态共享还是分态定义。 */
  scope: TokenScope;
  /** 简短人话：该令牌控制什么。 */
  description: string;
}

/** 语义分组。 */
export type ThemeTokenGroup = "background" | "text" | "border" | "semantic" | "brand" | "accent" | "special";

/**
 * 令牌契约。顺序按 {@link ThemeTokenGroup} 分组，与 `tokens.css` 保持同步
 * （token-contract.test.ts 的 parity 断言强制校验）。
 */
export const THEME_TOKENS: readonly ThemeTokenDescriptor[] = [
  // Background
  { key: "--ink", group: "background", scope: "appearance-scoped", description: "应用画布底色" },
  { key: "--panel", group: "background", scope: "appearance-scoped", description: "面板表面" },
  { key: "--panel-2", group: "background", scope: "appearance-scoped", description: "抬升面板 / 输入底" },
  { key: "--side", group: "background", scope: "appearance-scoped", description: "侧边栏底色" },
  { key: "--bubble", group: "background", scope: "appearance-scoped", description: "用户消息气泡底（= GreyWork message-user-bg）" },
  { key: "--console", group: "background", scope: "appearance-invariant", description: "终端 / SQL 控制台固定深底" },
  { key: "--paper", group: "background", scope: "appearance-scoped", description: "文档纸张底（暗态压暗纯白消眩光）" },
  { key: "--paper-ink", group: "text", scope: "appearance-invariant", description: "纸张上的默认正文色" },
  { key: "--message-tips-bg", group: "background", scope: "appearance-scoped", description: "提示面板背景（= GreyWork message-tips-bg）" },
  {
    key: "--workspace-btn-bg",
    group: "background",
    scope: "appearance-scoped",
    description: "工作区按钮底（= GreyWork workspace-btn-bg）",
  },
  {
    key: "--thought-gradient",
    group: "background",
    scope: "appearance-scoped",
    description: "思考面板背景渐变（= GreyWork thought-gradient）",
  },

  // Text
  { key: "--text", group: "text", scope: "appearance-scoped", description: "主文字" },
  { key: "--dim", group: "text", scope: "appearance-scoped", description: "次要文字" },
  { key: "--dim2", group: "text", scope: "appearance-scoped", description: "三级文字 / 分组标签" },

  // Border
  { key: "--line", group: "border", scope: "appearance-scoped", description: "发丝边框" },
  { key: "--line-2", group: "border", scope: "appearance-scoped", description: "加强边框" },

  // Semantic（状态信号）
  { key: "--amber", group: "semantic", scope: "appearance-scoped", description: "警示信号" },
  { key: "--cyan", group: "semantic", scope: "appearance-scoped", description: "信息 / 运行中信号" },
  { key: "--violet", group: "semantic", scope: "appearance-scoped", description: "Agent 强调信号" },
  { key: "--mint", group: "semantic", scope: "appearance-scoped", description: "成功信号" },
  { key: "--orange", group: "semantic", scope: "appearance-scoped", description: "危险 / 破坏信号" },

  // Brand（GreyWork 多色系统：Agent 主题色，两态同值）
  { key: "--grey-blue", group: "brand", scope: "appearance-invariant", description: "GreyWork Agent 蓝" },
  { key: "--grey-green", group: "brand", scope: "appearance-invariant", description: "GreyWork Agent 绿" },
  { key: "--grey-orange", group: "brand", scope: "appearance-invariant", description: "GreyWork Agent 橙" },
  { key: "--grey-violet", group: "brand", scope: "appearance-invariant", description: "GreyWork Agent 紫" },
  { key: "--grey-red", group: "brand", scope: "appearance-invariant", description: "GreyWork Agent 红" },
  // Brand 品牌色（GreyWork 紫罗兰）与 10 阶品牌色阶（深色下反转）
  { key: "--brand", group: "brand", scope: "appearance-scoped", description: "品牌色（紫罗兰）" },
  { key: "--brand-light", group: "brand", scope: "appearance-scoped", description: "品牌浅（深）背景" },
  { key: "--brand-hover", group: "brand", scope: "appearance-scoped", description: "品牌悬停" },
  { key: "--brand-1", group: "brand", scope: "appearance-scoped", description: "品牌色阶 1（最浅表面）" },
  { key: "--brand-2", group: "brand", scope: "appearance-scoped", description: "品牌色阶 2" },
  { key: "--brand-3", group: "brand", scope: "appearance-scoped", description: "品牌色阶 3" },
  { key: "--brand-4", group: "brand", scope: "appearance-scoped", description: "品牌色阶 4" },
  { key: "--brand-5", group: "brand", scope: "appearance-scoped", description: "品牌色阶 5" },
  { key: "--brand-6", group: "brand", scope: "appearance-scoped", description: "品牌色阶 6（= brand）" },
  { key: "--brand-7", group: "brand", scope: "appearance-scoped", description: "品牌色阶 7" },
  { key: "--brand-8", group: "brand", scope: "appearance-scoped", description: "品牌色阶 8" },
  { key: "--brand-9", group: "brand", scope: "appearance-scoped", description: "品牌色阶 9" },
  { key: "--brand-10", group: "brand", scope: "appearance-scoped", description: "品牌色阶 10（最深表面）" },

  // Accent（主强调）
  { key: "--accent", group: "accent", scope: "appearance-scoped", description: "主动作色（= GreyWork primary：浅=#165dff / 深=#4d9fff）" },
  { key: "--accent-ink", group: "accent", scope: "appearance-scoped", description: "强调色上的文字" },
  { key: "--accent-hi", group: "accent", scope: "appearance-scoped", description: "强调悬停亮阶" },

  // Special（字族，两态同值）
  { key: "--font-ui", group: "special", scope: "appearance-invariant", description: "UI 字族栈" },
  { key: "--font-display", group: "special", scope: "appearance-invariant", description: "展示字族栈" },
  { key: "--font-mono", group: "special", scope: "appearance-invariant", description: "等宽字族栈" },
];

/** 全部可覆盖令牌 key 的集合，供 O(1) 校验（模块私有）。 */
const THEME_TOKEN_KEYS: ReadonlySet<string> = new Set(THEME_TOKENS.map((token) => token.key));

/** 某 CSS 自定义属性是否属于可覆盖令牌契约。 */
export function isThemeTokenKey(key: string): boolean {
  return THEME_TOKEN_KEYS.has(key);
}
