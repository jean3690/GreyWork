/**
 * diff 行级语法高亮。
 *
 * 复用 CodeMirror 的 lezer 解析器离线着色，不引 shiki / highlight.js：
 * 与 TextViewer 同一套语言包与配色令牌，包里也不会多出一份语法定义。
 *
 * 做法是「整侧 parse」而不是逐行 parse：把 diff 的旧/新文本各自拼成完整文档解析一次，
 * 再按行号把 token 映射回每条 diff 行 —— 逐行解析会丢掉多行注释 / 模板串的上下文。
 *
 * 输出的 HTML 只含固定的 Tailwind 类名与转义后的文本，可安全用 v-html。
 */
import { ref, watch, type Ref } from "vue";
import type { Language } from "@codemirror/language";
import { highlightCode, tagHighlighter, tags } from "@lezer/highlight";
import { loadCodeLanguage } from "./code-language";
import type { DiffFile } from "./unified-diff";

/** 与 TextViewer.buildHighlightStyle 同一套语义色（tailwind.css 的 --color-* 工具类）。 */
const HIGHLIGHTER = tagHighlighter([
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

/** 着色行数上限：超大 diff 不做 lezer 解析（错误恢复可能很慢），退回纯文本 + 增删底色。 */
const MAX_HIGHLIGHT_LINES = 2_000;

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 把整段文本着色，按行返回 HTML（与输入行一一对应，不含换行）。 */
function highlightText(text: string, language: Language): string[] {
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
    // 语法树解析失败（极端输入 / StreamLanguage 异常）就退回纯文本，绝不让预览挂掉。
    return [];
  }
}

/**
 * 单份 diff 的逐行 HTML。header / hunk / meta 行不做语法着色（返回 null）。
 * 上下文行同时存在于旧/新两侧，取旧侧即可（文本一致）。
 */
export function highlightDiffLines(file: DiffFile, language: Language): Array<string | null> {
  const oldText: string[] = [];
  const newText: string[] = [];
  const plan: Array<{ side: "old" | "new" | "both" | null; index: number }> = [];

  for (const line of file.lines) {
    if (line.kind === "context") {
      const index = oldText.length;
      oldText.push(line.text);
      newText.push(line.text);
      plan.push({ side: "both", index });
    } else if (line.kind === "del") {
      plan.push({ side: "old", index: oldText.length });
      oldText.push(line.text);
    } else if (line.kind === "add") {
      plan.push({ side: "new", index: newText.length });
      newText.push(line.text);
    } else {
      plan.push({ side: null, index: -1 });
    }
  }

  if (oldText.length > MAX_HIGHLIGHT_LINES || newText.length > MAX_HIGHLIGHT_LINES) {
    return file.lines.map(() => null);
  }

  const oldHtml = highlightText(oldText.join("\n"), language);
  const newHtml = highlightText(newText.join("\n"), language);
  return plan.map(({ side, index }) => {
    if (side === null) return null;
    return (side === "new" ? newHtml[index] : oldHtml[index]) ?? null;
  });
}

/**
 * 组合式：为每份 diff 按其文件路径加载语言并着色。
 * 语言包按需动态 import，加载完成前返回空数组（调用方退回纯文本）；过期结果按 generation 丢弃。
 */
export function useDiffHighlights(files: Ref<readonly DiffFile[]>): Ref<Array<Array<string | null>>> {
  const output = ref<Array<Array<string | null>>>([]);
  let generation = 0;

  watch(
    files,
    async (next) => {
      const run = ++generation;
      const paths = [...new Set(next.map((file) => file.path))];
      const languages = new Map<string, Language | null>();
      await Promise.all(
        paths.map(async (path) => {
          const loaded = await loadCodeLanguage(path);
          languages.set(path, loaded?.language ?? null);
        }),
      );
      if (run !== generation) return;
      output.value = next.map((file) => {
        const language = languages.get(file.path);
        return language ? highlightDiffLines(file, language) : file.lines.map(() => null);
      });
    },
    { immediate: true },
  );

  return output;
}
