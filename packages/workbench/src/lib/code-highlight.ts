/**
 * 代码片段的逐行语法高亮（非 diff）。
 *
 * 工具调用的命令、输出、入参都要着色：与 diff 视图共用同一套 lezer 解析器与配色，
 * 不引第二份高亮引擎。整段解析而不是逐行解析 —— 逐行会丢掉多行字符串 / 注释的上下文。
 *
 * 输出的 HTML 只含固定的 Tailwind 类名与转义后的文本，可安全用 v-html。
 */
import { ref, watch, type Ref } from "vue";
import type { Language } from "@codemirror/language";
import { highlightCode, tagHighlighter, tags } from "@lezer/highlight";
import { loadCodeLanguageByKind } from "./code-language";
import { codeLanguageOfPath, type CodeLanguage } from "./viewer";

/** 与 TextViewer.buildHighlightStyle 同一套语义色（tailwind.css 的 --color-* 工具类）。 */
export const HIGHLIGHTER = tagHighlighter([
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], class: "text-dim2 italic" },
  {
    tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword, tags.definitionKeyword, tags.moduleKeyword, tags.modifier],
    class: "text-violet",
  },
  { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.character], class: "text-mint" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom, tags.unit], class: "text-amber" },
  { tag: [tags.variableName, tags.propertyName, tags.attributeName], class: "text-cyan" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], class: "text-accent" },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.self], class: "text-cyan" },
  { tag: [tags.tagName, tags.angleBracket], class: "text-orange" },
  { tag: [tags.heading, tags.strong], class: "text-foreground font-semibold" },
  { tag: [tags.link, tags.url], class: "text-accent underline" },
  { tag: [tags.operator, tags.punctuation, tags.separator, tags.bracket, tags.meta], class: "text-dim" },
  { tag: tags.invalid, class: "text-orange" },
]);

/** 着色行数上限：超大片段不做 lezer 解析（错误恢复可能很慢），退回纯文本。 */
export const MAX_HIGHLIGHT_LINES = 2_000;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 把整段文本着色，按行返回 HTML（与输入行一一对应，不含换行）。 */
export function highlightTextLines(text: string, language: Language): string[] {
  if (text === "") return [];
  try {
    const tree = language.parser.parse(text);
    const lines: string[] = [""];
    highlightCode(
      text,
      tree,
      HIGHLIGHTER,
      (chunk, classes) => {
        if (chunk === "") return;
        lines[lines.length - 1] += classes ? `<span class="${classes}">${escapeHtml(chunk)}</span>` : escapeHtml(chunk);
      },
      () => lines.push(""),
    );
    return lines;
  } catch {
    // 语法树解析失败（极端输入 / StreamLanguage 异常）就退回纯文本，绝不让面板挂掉。
    return [];
  }
}

/**
 * 从路径或内容推断片段语言：路径扩展名优先（读文件 / 写文件），
 * 其次嗅探 JSON（命令输出常是 JSON，肉眼最需要着色的就是它）。
 */
export function guessCodeLanguage(path: string | null | undefined, text: string): CodeLanguage | null {
  if (path) {
    const byPath = codeLanguageOfPath(path);
    if (byPath) return byPath;
  }
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 组合式：给一组已经拆好的行按语言着色。
 *
 * 返回 null 表示「不着色」（语言未知 / 超长 / 解析失败 / 尚未加载完成），
 * 调用方退回纯文本渲染。加载期间的 null 不是错误，只是还没好。
 */
export function useCodeHighlights(lines: Ref<readonly string[]>, language: Ref<CodeLanguage | null>): Ref<string[] | null> {
  const output = ref<string[] | null>(null);
  let generation = 0;

  watch(
    [lines, language],
    async ([next, kind]) => {
      const run = ++generation;
      if (!kind || next.length === 0 || next.length > MAX_HIGHLIGHT_LINES) {
        output.value = null;
        return;
      }
      const loaded = await loadCodeLanguageByKind(kind);
      if (run !== generation) return;
      if (!loaded) {
        output.value = null;
        return;
      }
      const html = highlightTextLines(next.join("\n"), loaded.language);
      // 行数对不上（尾部空行 / 解析器差异）就别硬映射，退回纯文本更安全。
      output.value = html.length === next.length ? html : null;
    },
    { immediate: true },
  );

  return output;
}
