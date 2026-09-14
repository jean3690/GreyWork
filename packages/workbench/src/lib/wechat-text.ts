/**
 * 助手回复（Markdown）→ 微信纯文本。
 *
 * 微信聊天窗不渲染 Markdown：围栏、星号、表格竖线会原样出现，读起来像乱码。
 * 转换原则是「留内容、去标记」，与腾讯官方 openclaw-weixin 插件的
 * `markdownToPlainText` 同思路（代码块留内容、图片整段去掉、链接留文字、表格去竖线）。
 * 只做单遍文本变换，不做语法解析 —— 输出来自本机模型，不是任意网页。
 */

/** 代码围栏：去掉 ```lang 行与收尾围栏，代码内容原样保留。 */
const FENCED_CODE = /```[^\n]*\n?([\s\S]*?)```/g;
/** 图片：整段去掉（目标是文字通道，地址没有意义）。 */
const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
/** 链接：留展示文字。 */
const LINK = /\[([^\]]+)\]\([^)]*\)/g;
/** 表格分隔行：`|---|:--:|`。 */
const TABLE_SEPARATOR = /^\s*\|[\s:|-]+\|\s*$/gm;
/** 表格内容行：去首尾竖线，单元格用两个空格连接。 */
const TABLE_ROW = /^\s*\|(.+)\|\s*$/gm;
/** ATX 标题：去井号。 */
const HEADING = /^#{1,6}\s+/gm;
/** 无序列表项：统一成「· 」。有序列表的数字前缀保留（1. 2. …）。 */
const BULLET = /^(\s*)[-*+]\s+/gm;
/** 引用块：去 >。 */
const QUOTE = /^\s*>\s?/gm;
/** 分隔线：整行去掉。 */
const RULE = /^\s*([-*_]\s*){3,}$/gm;
/** 行内代码：去反引号。 */
const INLINE_CODE = /`([^`]+)`/g;
/** 粗体 / 斜体 / 删除线。 */
const BOLD = /\*\*([^*]+)\*\*/g;
const BOLD_ALT = /__([^_]+)__/g;
const ITALIC_STAR = /(?<!\*)\*([^*\n]+)\*(?!\*)/g;
const ITALIC_UNDER = /(?<!_)_([^_\n]+)_(?!_)/g;
const STRIKE = /~~([^~]+)~~/g;
/** 三个以上连续空行收到两个。 */
const BLANK_RUN = /\n{3,}/g;

/**
 * Markdown → 纯文本。纯文本输入走一遍是恒等变换（除空白收敛），可放心重复调用。
 *
 * 已知取舍：`2 * 3 * 4` 这类行内星号会被当成斜体标记吃掉。模型产出的正文里
 * 这种写法极少，为它保留一套 Markdown 解析器不划算。
 */
export function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(FENCED_CODE, (_match, code: string) => code.trim())
    .replace(IMAGE, "")
    .replace(LINK, "$1")
    .replace(TABLE_SEPARATOR, "")
    .replace(TABLE_ROW, (_match, inner: string) =>
      inner
        .split("|")
        .map((cell) => cell.trim())
        .join("  "),
    )
    .replace(HEADING, "")
    .replace(BULLET, "$1· ")
    .replace(QUOTE, "")
    .replace(RULE, "")
    .replace(INLINE_CODE, "$1")
    .replace(BOLD, "$1")
    .replace(BOLD_ALT, "$1")
    .replace(ITALIC_STAR, "$1")
    .replace(ITALIC_UNDER, "$1")
    .replace(STRIKE, "$1")
    .replace(BLANK_RUN, "\n\n")
    .trim();
}
