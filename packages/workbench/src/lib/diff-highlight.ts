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
import { MAX_HIGHLIGHT_LINES, highlightTextLines } from "./code-highlight";
import { loadCodeLanguage } from "./code-language";
import type { DiffFile } from "./unified-diff";

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

  const oldHtml = highlightTextLines(oldText.join("\n"), language);
  const newHtml = highlightTextLines(newText.join("\n"), language);
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
