<script setup lang="ts">
/* CodeMirror 6 编辑器 · greywork 主题（暖石墨底 + 仪表琥珀语义，对齐 theme/tokens.css）。
 * 契约与旧编辑器组件一致：v-model:value 双向同步 + language 切换（Compartment 热重配）。 */
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { basicSetup, EditorView } from "codemirror";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { html as htmlLang } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json as jsonLang } from "@codemirror/lang-json";
import { markdown as markdownLang } from "@codemirror/lang-markdown";

const props = withDefaults(defineProps<{ value: string; language?: string }>(), { language: "typescript" });
const emit = defineEmits<{ (event: "update:value", value: string): void }>();

const containerRef = ref<HTMLElement | null>(null);
let view: EditorView | null = null;
const languageCompartment = new Compartment();

/* greywork 高亮：与 ui-design.md 信号语义一致（琥珀=关键字、mint=字符串、钢蓝=数值/类型）。
 * 非 fallback：完全接管 basicSetup 内置 defaultHighlightStyle，未命中标签继承暖纸白。 */
const greyworkHighlight = HighlightStyle.define([
  { tag: t.keyword, color: "#ffb224" },
  { tag: [t.bool, t.null], color: "#ffb224" },
  { tag: t.string, color: "#34d399" },
  { tag: [t.number, t.integer, t.float], color: "#7aa2ff" },
  { tag: [t.typeName, t.className, t.namespace], color: "#7aa2ff" },
  { tag: [t.propertyName, t.attributeName], color: "#eceae3" },
  { tag: [t.function(t.variableName), t.definition(t.variableName)], color: "#eceae3" },
  { tag: t.comment, color: "#6c7076", fontStyle: "italic" },
  { tag: [t.heading, t.strong], color: "#ffb224", fontWeight: "700" },
  { tag: t.link, color: "#7aa2ff", textDecoration: "underline" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: [t.meta, t.processingInstruction], color: "#9da1a4" },
  { tag: t.invalid, color: "#ef6c4d" },
]);

const greyworkTheme = EditorView.theme(
  {
    "&": {
      color: "#eceae3",
      backgroundColor: "transparent",
      fontSize: "12.5px",
      height: "100%",
    },
    ".cm-scroller": {
      fontFamily: '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace',
      lineHeight: "22px",
    },
    ".cm-content": {
      caretColor: "#ffb224",
      padding: "14px 0",
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#ffb224" },
    "&.cm-focused": { outline: "none" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
      backgroundColor: "#3b4049",
    },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: "#6c7076",
      border: "none",
    },
    ".cm-lineNumbers .cm-gutterElement": { minWidth: "34px", padding: "0 10px 0 6px" },
    ".cm-activeLine": { backgroundColor: "rgba(27, 29, 34, 0.6)" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "#9da1a4" },
    ".cm-foldGutter .cm-gutterElement": { color: "#6c7076" },
    ".cm-selectionMatch": { backgroundColor: "rgba(255, 178, 36, 0.18)" },
    ".cm-tooltip": {
      backgroundColor: "#1b1d22",
      border: "1px solid #3b4049",
      color: "#eceae3",
    },
  },
  { dark: true },
);

/** 语言 → CM 扩展；csv 等未知类型回退无着色纯文本（EditorPane LANG 映射已归一）。 */
function languageExtension(lang: string): Extension | null {
  switch (lang) {
    case "typescript":
      return javascript({ typescript: true });
    case "javascript":
      return javascript();
    case "html":
      return htmlLang();
    case "markdown":
      return markdownLang();
    case "json":
      return jsonLang();
    default:
      return null;
  }
}

function extensionsFor(lang: string): Extension[] {
  const ext = languageExtension(lang);
  return [
    basicSetup,
    keymap.of([indentWithTab]),
    greyworkTheme,
    syntaxHighlighting(greyworkHighlight),
    ...(ext ? [ext] : []),
  ];
}

onMounted(() => {
  if (!containerRef.value) return;
  view = new EditorView({
    state: EditorState.create({
      doc: props.value,
      extensions: [
        languageCompartment.of(extensionsFor(props.language)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) emit("update:value", update.state.doc.toString());
        }),
      ],
    }),
    parent: containerRef.value,
  });
});

onBeforeUnmount(() => {
  view?.destroy();
  view = null;
});

/* 外部内容变化（打开文件 / 保存回灌）：仅在差异时整体替换，避免光标跳动 */
watch(
  () => props.value,
  (value) => {
    if (view && view.state.doc.toString() !== value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    }
  },
);

/* 语言切换（打开不同文件）：Compartment 热重配，保留文档与撤销历史 */
watch(
  () => props.language,
  (next) => {
    view?.dispatch({ effects: languageCompartment.reconfigure(extensionsFor(next)) });
  },
);
</script>

<template>
  <div ref="containerRef" class="cm-pane"></div>
</template>

<style scoped>
.cm-pane {
  width: 100%;
  height: 100%;
  min-height: 440px;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--line-2);
  background: var(--ink);
}
.cm-pane :deep(.cm-editor) {
  height: 100%;
}
</style>
