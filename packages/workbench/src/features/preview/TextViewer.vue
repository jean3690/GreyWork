<script setup lang="ts">
/**
 * 代码 / 文本预览（kind `code` 与 `raw` 共用）—— **可就地编辑并保存**。
 *
 * 用已装的 CodeMirror 6，不引 shiki / highlight.js —— 编辑器和高亮器同一套栈，
 * 主题、行号、折行行为天然一致，所以「预览即编辑」只是换一组扩展的事。
 *
 * 语言扩展按扩展名动态 import：各官方 lang 包按需加载（独立 chunk，不进主包），
 * `codeLanguageOfPath` 返回 null 时就纯文本渲染，不去猜一个没装的包。
 *
 * 高亮配色直接写 CSS 变量（见 buildHighlightStyle）：宿主翻主题时变量换值，
 * CodeMirror 生成的样式规则原地生效，不需要重建编辑器或重新解析文档。
 *
 * **可编辑的两个前提**（磁盘源先探测，见 state/workspaceFiles.probeWorkspaceFile）：
 * - 不像二进制：二进制按文本读只会得到一屏 U+FFFD 且不报错，预览改给占位；
 * - 是 UTF-8：写回命令只写 UTF-8，放开编辑等于静默把整份文件转码，故非 UTF-8 只读。
 *
 * 编码 / 行尾的还原在保存时做（`restoreEncoding`）：解码时 BOM 已被剥掉，
 * 而 CodeMirror 的 doc 一律用 `\n` 拼接 —— 直接写回会把 CRLF 文件整篇改成 LF。
 */
import { computed, onUnmounted, ref, toRef, watch } from "vue";
import { usePreviewLoader, readPreviewText } from "@/lib/preview-content";
import { codeLanguageOfPath, type CodeLanguage } from "@/lib/viewer";
import { probeWorkspaceFile, type FileProbeInfo } from "@/state/workspaceFiles";
import { registerPreviewSaver, unregisterPreviewSaver, writePreviewText } from "@/lib/preview-save";
import PreviewExternalButton from "@/features/preview/PreviewExternalButton.vue";
import { i18n } from "@/i18n";
import type { PreviewTab } from "@/stores/preview";

const props = defineProps<{ tab: PreviewTab }>();

/** 直挂组件（测试）时可能没有 i18n 插件，故用全局实例而非 useI18n。 */
const t = i18n.global.t;

/** 磁盘探测结果；非磁盘源恒为 null（vfs 产物一定是管线写出的文本）。 */
const probe = ref<FileProbeInfo | null>(null);
/** 探测判定为二进制 → 渲染占位，不建编辑器。 */
const binary = ref(false);
/** 只读原因（已翻译的文案）；非 null 时仍可预览但不可编辑。 */
const readOnlyReason = ref<string | null>(null);
/** 有未保存改动；由编辑器自己的 updateListener 置位（见 mountEditor）。 */
const dirty = ref(false);

/** 可否编辑：网页正文没有可写回的文件；二进制与非 UTF-8 已在探测阶段拦下。 */
const editable = computed(() => props.tab.source !== "web" && !binary.value && !readOnlyReason.value);

const host = ref<HTMLElement | null>(null);
/** CodeMirror 建不起来时（happy-dom 无完整 DOM API）降级为 <pre>，不白屏。 */
const degraded = ref(false);

type EditorViewInstance = {
  destroy: () => void;
  scrollDOM: HTMLElement;
  state: { doc: { length: number; toString: () => string } };
  dispatch: (tr: unknown) => void;
};
let view: EditorViewInstance | null = null;
/** 是否已注册 saver（只读 / 降级态不注册，守卫也就不会来问它）。 */
let saverRegistered = false;

/**
 * 磁盘文件先探测再决定读不读、能不能编辑。
 *
 * **探测失败不挡预览**：拿不到探测结果就按「普通文本」走下去（能看，只是可能编辑后
 * 写坏编码）—— 这条路也是浏览器态的兜底：`invoke` 会抛，随后 `readPreviewText`
 * 给出那句人话错误（「浏览器态没有磁盘通道」）。
 */
async function loadText(path: string): Promise<string> {
  if (props.tab.source !== "disk") {
    applyProbe(path, null);
    return readPreviewText(props.tab, path);
  }
  let info: FileProbeInfo | null = null;
  try {
    info = await probeWorkspaceFile(path);
  } catch {
    info = null;
  }
  applyProbe(path, info);
  // 二进制不读内容：读回来只会是乱码，还要白付一次最多 10MB 的 IPC。
  if (info?.binary) return "";
  return readPreviewText(props.tab, path);
}

/** 探测结果落到本组件；路径已换（这轮结果属于上一个 tab）就丢弃。 */
function applyProbe(path: string, info: FileProbeInfo | null): void {
  if (path !== props.tab.path) return;
  probe.value = info;
  binary.value = info?.binary ?? false;
  readOnlyReason.value = info && !info.binary && !info.utf8 ? t("preview.text.notUtf8") : null;
}

const { data, loading, error } = usePreviewLoader(toRef(props, "tab"), loadText);

/** 还原保存形式：CRLF 补回 `\r\n`，带 BOM 的补回 BOM。 */
function restoreEncoding(text: string): string {
  const info = probe.value;
  if (!info) return text;
  const out = info.crlf ? text.replace(/\r?\n/g, "\r\n") : text;
  return info.bom && !out.startsWith("\uFEFF") ? `\uFEFF${out}` : out;
}

/**
 * 保存。
 *
 * **先同步取内容再 await**：守卫会在切 tab / 关窗时调本函数，而编辑器实例紧接着就被
 * 销毁 —— 先取字符串才能保证写进去的是用户看到的那份。
 */
async function save(): Promise<void> {
  const text = view ? view.state.doc.toString() : (data.value ?? "");
  await writePreviewText(props.tab, restoreEncoding(text));
  dirty.value = false;
}

async function languageExtension(language: CodeLanguage | null): Promise<unknown[]> {
  // tsx/jsx 同走一个分支：jsx: true 让 JSX 语法也被识别，否则 .tsx 只按 TS 高亮
  if (language === "javascript") return [(await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: true })];
  if (language === "vue") return [(await import("@codemirror/lang-vue")).vue()];
  if (language === "json") return [(await import("@codemirror/lang-json")).json()];
  if (language === "markdown") return [(await import("@codemirror/lang-markdown")).markdown()];
  if (language === "html") return [(await import("@codemirror/lang-html")).html()];
  if (language === "python") return [(await import("@codemirror/lang-python")).python()];
  if (language === "rust") return [(await import("@codemirror/lang-rust")).rust()];
  if (language === "go") return [(await import("@codemirror/lang-go")).go()];
  if (language === "java") return [(await import("@codemirror/lang-java")).java()];
  if (language === "cpp") return [(await import("@codemirror/lang-cpp")).cpp()];
  if (language === "css") return [(await import("@codemirror/lang-css")).css()];
  if (language === "sass") return [(await import("@codemirror/lang-sass")).sass()];
  if (language === "less") return [(await import("@codemirror/lang-less")).less()];
  if (language === "yaml") return [(await import("@codemirror/lang-yaml")).yaml()];
  if (language === "sql") return [(await import("@codemirror/lang-sql")).sql()];
  if (language === "xml") return [(await import("@codemirror/lang-xml")).xml()];
  // toml / shell 没有官方 lang 包，用 legacy-modes 的 StreamLanguage 适配器桥接
  if (language === "toml") {
    const { StreamLanguage } = await import("@codemirror/language");
    return [StreamLanguage.define((await import("@codemirror/legacy-modes/mode/toml")).toml)];
  }
  if (language === "shell") {
    const { StreamLanguage } = await import("@codemirror/language");
    return [StreamLanguage.define((await import("@codemirror/legacy-modes/mode/shell")).shell)];
  }
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
    const { EditorView, lineNumbers, highlightSpecialChars, keymap } = viewModule;
    const editing = editable.value;
    // 编辑态才装历史与键位表：只读预览装上只是白付一份包体。
    // **必须留在这个 try 里动态 import**：`@codemirror/commands` 依赖 `@codemirror/view`，
    // 而测试把后者 mock 成加载失败（TextViewer.dom.test.ts）—— 挪到模块顶层会让那个
    // 测试文件在导入期就崩。
    const commands = editing ? await import("@codemirror/commands") : null;
    const state = EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        highlightSpecialChars(),
        EditorView.lineWrapping,
        ...(editing && commands
          ? [
              commands.history(),
              keymap.of([...commands.defaultKeymap, ...commands.historyKeymap]),
              // docChanged 是 O(1) 的；不拿 doc.toString() 和基线比 —— 大文件每次按键都 O(n)。
              // 改回原样仍算脏，只是多存一次，代价可接受。
              EditorView.updateListener.of((update: { docChanged: boolean }) => {
                if (update.docChanged) dirty.value = true;
              }),
            ]
          : [EditorState.readOnly.of(true), EditorView.editable.of(false)]),
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
    // 滚动发生在 CodeMirror 自己的 .cm-scrollDOM 里（外层容器是 overflow-hidden），
    // 给它打上滚动契约标记，PreviewSurface 才找得到该还位置的地方
    (view.scrollDOM as HTMLElement).dataset.scrollRoot = "";
    degraded.value = false;
    if (editing) {
      registerPreviewSaver(props.tab.id, { dirty, save });
      saverRegistered = true;
    }
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
 * 同时观察 `data`、`host` 与 `binary`：首帧 `loading` 为真，模板渲染的是占位文案，
 * 容器 div 还不存在。只 watch `data` 的话，内容到达时 `host.value` 仍是 null，
 * 编辑器永远建不起来（表现为面板里空着一块，没有任何报错）。
 *
 * 已建好之后内容再变，走 dispatch 替换全文而不是重建 view —— 重建会丢滚动位置且更贵；
 * 但**编辑中（dirty）不替换**：revision 自增会触发重读，拿外部内容冲掉用户正在改的
 * 缓冲比不刷新更糟。
 */
watch(
  [data, host, binary] as const,
  ([next, container]) => {
    if (binary.value) {
      // 换了二进制内容：把编辑器收掉，模板改渲染占位。
      destroyEditor();
      return;
    }
    if (next === null || !container) return;
    if (!view) {
      void mountEditor(next);
      return;
    }
    if (dirty.value) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
  },
  { immediate: true, flush: "post" },
);

onUnmounted(() => {
  destroyEditor();
  if (saverRegistered) {
    unregisterPreviewSaver(props.tab.id);
    saverRegistered = false;
  }
});
</script>

<template>
  <div class="flex size-full min-h-0 flex-col overflow-hidden">
    <p v-if="loading" class="px-4 py-3 text-[12px] text-dim2">{{ t("preview.common.loading") }}</p>
    <div v-else-if="error" role="alert" class="flex flex-wrap items-center gap-2 px-4 py-3">
      <span class="text-[12px] text-orange">{{ t("preview.common.readFailed", { detail: error }) }}</span>
      <PreviewExternalButton :tab="tab" />
    </div>
    <div
      v-else-if="binary"
      data-testid="text-viewer-binary"
      class="flex size-full flex-col items-center justify-center gap-2 px-6 text-center"
    >
      <span class="text-[12px] text-dim2">{{ t("preview.text.binary") }}</span>
      <PreviewExternalButton :tab="tab" />
    </div>
    <div v-else class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <!-- 只读原因（目前只有「非 UTF-8」一条）：说清为什么不能改，比只给个不可编辑的框好。
           放在降级分支之外，CodeMirror 起不来时这条说明也还在。 -->
      <p v-if="readOnlyReason" data-testid="text-viewer-readonly" class="shrink-0 border-b border-line px-3 py-1 text-[11px] text-dim2">
        {{ readOnlyReason }}
      </p>
      <pre
        v-if="degraded"
        data-selection-scope
        data-scroll-root
        class="min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-[12px] text-foreground"
        >{{ data }}</pre
      >
      <div v-else ref="host" data-testid="text-viewer" data-selection-scope class="min-h-0 flex-1 overflow-hidden" />
    </div>
  </div>
</template>
