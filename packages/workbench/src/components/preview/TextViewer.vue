<script setup lang="ts">
/**
 * 只读代码/文本预览（kind `code` 与 `raw` 共用）。
 *
 * 用已装的 CodeMirror 6，不引 shiki / highlight.js —— 编辑器和高亮器同一套栈，
 * 主题、行号、折行行为天然一致，将来要「预览即编辑」也只是去掉 readOnly。
 *
 * 语言扩展按扩展名动态 import：workbench 只装了 javascript/json/markdown/html 四个
 * lang 包，`codeLanguageOfPath` 返回 null 时就纯文本渲染，不去猜一个没装的包。
 *
 * 高亮配色直接写 CSS 变量（见 buildHighlightStyle）：宿主翻主题时变量换值，
 * CodeMirror 生成的样式规则原地生效，不需要重建编辑器或重新解析文档。
 */
import { onUnmounted, ref, toRef, watch } from "vue";
import { usePreviewText } from "../../lib/preview-content";
import { codeLanguageOfPath, type CodeLanguage } from "../../lib/viewer";
import type { PreviewTab } from "../../stores/preview";

const props = defineProps<{ tab: PreviewTab }>();

const { data, loading, error } = usePreviewText(toRef(props, "tab"));

const host = ref<HTMLElement | null>(null);
/** CodeMirror 建不起来时（happy-dom 无完整 DOM API）降级为 <pre>，不白屏。 */
const degraded = ref(false);

type EditorViewInstance = { destroy: () => void; state: { doc: { length: number } }; dispatch: (tr: unknown) => void };
let view: EditorViewInstance | null = null;

async function languageExtension(language: CodeLanguage | null): Promise<unknown[]> {
  if (language === "javascript") return [(await import("@codemirror/lang-javascript")).javascript({ typescript: true })];
  if (language === "json") return [(await import("@codemirror/lang-json")).json()];
  if (language === "markdown") return [(await import("@codemirror/lang-markdown")).markdown()];
  if (language === "html") return [(await import("@codemirror/lang-html")).html()];
  return [];
}

/**
 * 语法高亮配色：全部指向主题令牌变量，不落具体色值。
 *
 * 复用语义色而不是另开一套「代码专用」色板：预览面板和外壳同屏，两套相近但不
 * 相等的绿/紫会立刻看出割裂。语义色在明/暗两态都已各自调过对比度。
 */
async function buildHighlightStyle(): Promise<unknown[]> {
  const [{ HighlightStyle, syntaxHighlighting }, { tags }] = await Promise.all([
    import("@codemirror/language"),
    import("@lezer/highlight"),
  ]);
  const style = HighlightStyle.define([
    { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: "var(--dim2)", fontStyle: "italic" },
    {
      tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword, tags.definitionKeyword, tags.moduleKeyword, tags.modifier],
      color: "var(--violet)",
    },
    { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.character], color: "var(--mint)" },
    { tag: [tags.number, tags.bool, tags.null, tags.atom, tags.unit], color: "var(--amber)" },
    { tag: [tags.variableName, tags.propertyName, tags.attributeName], color: "var(--cyan)" },
    { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "var(--accent)" },
    { tag: [tags.typeName, tags.className, tags.namespace, tags.self], color: "var(--cyan)" },
    { tag: [tags.tagName, tags.angleBracket], color: "var(--orange)" },
    { tag: [tags.heading, tags.strong], color: "var(--text)", fontWeight: "600" },
    { tag: [tags.link, tags.url], color: "var(--accent)", textDecoration: "underline" },
    { tag: [tags.operator, tags.punctuation, tags.separator, tags.bracket, tags.meta], color: "var(--dim)" },
    { tag: tags.invalid, color: "var(--orange)" },
  ]);
  return [syntaxHighlighting(style)];
}

async function mountEditor(doc: string): Promise<void> {
  const container = host.value;
  if (!container) return;
  try {
    const [{ EditorState }, viewModule, langExtensions, highlight] = await Promise.all([
      import("@codemirror/state"),
      import("@codemirror/view"),
      languageExtension(codeLanguageOfPath(props.tab.path)),
      buildHighlightStyle(),
    ]);
    const { EditorView, lineNumbers, highlightSpecialChars } = viewModule;
    const state = EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        highlightSpecialChars(),
        EditorView.lineWrapping,
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        // 不引主题包：底色与文字都走外层 Tailwind 令牌，只借用容器的字体与字号。
        EditorView.theme({
          "&": { backgroundColor: "transparent", height: "100%", fontSize: "12px", color: "var(--text)" },
          ".cm-scroller": { fontFamily: "var(--font-mono, ui-monospace, monospace)" },
          ".cm-content": { caretColor: "var(--text)" },
          ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text)" },
          "&.cm-focused": { outline: "none" },
          ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "var(--dim2)" },
          ".cm-activeLine": { backgroundColor: "var(--panel-2)" },
          ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text)" },
          ".cm-selectionBackground, .cm-content ::selection": { backgroundColor: "var(--brand-3)" },
          "&.cm-focused .cm-selectionBackground": { backgroundColor: "var(--brand-3)" },
          ".cm-selectionMatch": { backgroundColor: "var(--brand-2)" },
        }),
        ...(langExtensions as never[]),
        ...(highlight as never[]),
      ],
    });
    view = new EditorView({ state, parent: container }) as unknown as EditorViewInstance;
    degraded.value = false;
  } catch (cause: unknown) {
    // 这里失败不该让整个面板挂掉：降级渲染纯文本，同时留下线索。
    console.warn("[preview] CodeMirror 初始化失败，降级为纯文本", cause);
    degraded.value = true;
  }
}

function destroyEditor(): void {
  view?.destroy();
  view = null;
}

/**
 * 同时观察 `data` 与 `host`：首帧 `loading` 为真，模板渲染的是占位文案，容器 div
 * 还不存在。只 watch `data` 的话，内容到达时 `host.value` 仍是 null，编辑器永远建不起来
 * （表现为面板里空着一块，没有任何报错）。
 *
 * 已建好之后内容再变，走 dispatch 替换全文而不是重建 view —— 重建会丢滚动位置且更贵。
 */
watch(
  [data, host] as const,
  ([next, container]) => {
    if (next === null || !container) return;
    if (!view) {
      void mountEditor(next);
      return;
    }
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
  },
  { immediate: true, flush: "post" },
);

onUnmounted(destroyEditor);
</script>

<template>
  <div class="flex size-full min-h-0 flex-col overflow-hidden">
    <p v-if="loading" class="px-4 py-3 text-[12px] text-dim2">读取中…</p>
    <p v-else-if="error" role="alert" class="px-4 py-3 text-[12px] text-orange">读取失败：{{ error }}</p>
    <pre
      v-else-if="degraded"
      data-selection-scope
      class="min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-[12px] text-foreground"
      >{{ data }}</pre
    >
    <div v-else ref="host" data-testid="text-viewer" data-selection-scope class="min-h-0 flex-1 overflow-hidden" />
  </div>
</template>
