<script setup lang="ts">
/**
 * ToolCallDetail —— 单次工具调用的细节面板：改动差分 / 命令 / 输出 / 入参。
 *
 * 改动块走真正的行级 LCS 差分（`diffTexts`）：只标真正增删的行，并给出 +N/-N，
 * 视觉沿用 DiffViewer 的既有语言（双列行号 + 标记列 + 增删底色）。早先的实现把
 * oldText 每行标 `-`、newText 每行标 `+`，改一行会显示成整文件删除 + 整文件新增。
 *
 * 每种片段都带「在哪个文件上做了什么」的抬头（写入 / 修改 / 读取 / 执行 + 路径），
 * 并给出行号与语法高亮：命令按 shell 着色，输出按被读文件的扩展名或 JSON 嗅探着色。
 * 高亮按需加载语言包，加载前/失败时退回纯文本，不阻塞渲染。
 *
 * 长内容只渲染前 maxLines 行，余下折起成「还有 N 行」按钮，点开再全量渲染：
 * 一次 write 可能上千行，全量塞进消息流会把 DOM 和滚动直接拖死。
 */
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import Icon from "@/features/shared/Icon.vue";
import ToolCodeLines from "@/features/conversation/ToolCodeLines.vue";
import { guessCodeLanguage, useCodeHighlights } from "@/lib/code-highlight";
import { useDiffHighlights } from "@/lib/diff-highlight";
import { diffTexts, type DiffFile, type DiffLine } from "@/lib/unified-diff";
import type { CodeLanguage } from "@/lib/viewer";
import type { ToolActivityKind, ToolDetail } from "@/types";

const props = withDefaults(
  defineProps<{
    detail: ToolDetail;
    /** 工具类型：决定抬头动作（写入 / 修改 / 删除 / 移动 / 读取 / 执行）。 */
    kind?: ToolActivityKind;
    /** 本次调用涉及的文件路径（read / edit 有，execute 通常没有）。 */
    path?: string;
    /** execute 的命令原文：以 `$` 起头单独成块，别和输出混在一起。 */
    command?: string;
    maxLines?: number;
  }>(),
  { maxLines: 12, kind: "other" },
);
const { t } = useI18n();

const expanded = ref(false);

/** 改动块：路径 + 行级差分 + 增删统计。无 diff 时为 null。 */
const diff = computed(() => {
  const raw = props.detail.diff;
  if (!raw) return null;
  const result = diffTexts(raw.oldText, raw.newText);
  return { path: raw.path || props.path || "", ...result };
});

const diffLines = computed<DiffLine[]>(() => diff.value?.lines ?? []);
/** 语法高亮按「整份 diff」算；工具调用只有一份，fileIndex 恒为 0。 */
const diffFile = computed<DiffFile | null>(() =>
  diff.value ? { path: diff.value.path, lines: diff.value.lines, added: diff.value.added, removed: diff.value.removed } : null,
);
const diffFiles = computed<DiffFile[]>(() => (diffFile.value ? [diffFile.value] : []));
const diffHighlights = useDiffHighlights(diffFiles);

function highlightAt(lineIndex: number): string | null {
  return diffHighlights.value[0]?.[lineIndex] ?? null;
}

// 按 `\r\n|\n|\r` 拆行：Windows 上工具输出常是 CRLF，只按 `\n` 拆会在每行尾留一个 `\r`
// （渲染上看不见，但复制出去就是脏字符）。
function splitLines(text: string | undefined): string[] {
  return text ? text.split(/\r\n|\n|\r/) : [];
}
const commandLines = computed(() => splitLines(props.command));
const textLines = computed(() => splitLines(props.detail.text));
const argLines = computed(() => splitLines(props.detail.args));

// ===== 片段语言：命令恒为 shell；输出按「被读文件扩展名 → JSON 内容嗅探」；入参是 JSON =====
const commandLang = computed<CodeLanguage | null>(() => (commandLines.value.length ? "shell" : null));
const commandHtml = useCodeHighlights(commandLines, commandLang);

const outputLang = computed<CodeLanguage | null>(() => {
  if (textLines.value.length === 0) return null;
  // 只有读取类工具的输出才是「文件内容」：其余工具（edit 的回执、MCP 的答案）
  // 即便带 path 也不能按文件扩展名着色，否则会把一段中文结论按 .ts 上色。
  return guessCodeLanguage(props.kind === "read" ? props.path : undefined, props.detail.text ?? "");
});
const outputHtml = useCodeHighlights(textLines, outputLang);

const argLang = computed<CodeLanguage | null>(() => (argLines.value.length ? guessCodeLanguage(undefined, props.detail.args ?? "") : null));
const argsHtml = useCodeHighlights(argLines, argLang);

// ===== 抬头：在哪个文件上做了什么 =====
type FileAction = "wrote" | "edited" | "deleted" | "moved" | "read" | "ran";

const ACTION_ICON: Record<FileAction, string> = {
  wrote: "edit",
  edited: "edit",
  deleted: "delete",
  moved: "arrow-right",
  read: "folder",
  ran: "terminal",
};
const ACTION_KEY: Record<FileAction, string> = {
  wrote: "chatView.tools.fileAction.wrote",
  edited: "chatView.tools.fileAction.edited",
  deleted: "chatView.tools.fileAction.deleted",
  moved: "chatView.tools.fileAction.moved",
  read: "chatView.tools.fileAction.read",
  ran: "chatView.tools.fileAction.ran",
};

/** 动作判定：kind 明确时听 kind；只有 diff 没有 kind 时按「有 oldText = 修改」推断。 */
const action = computed<FileAction | null>(() => {
  if (props.kind === "delete") return "deleted";
  if (props.kind === "move") return "moved";
  if (props.detail.diff) return props.detail.diff.oldText === null ? "wrote" : "edited";
  if (props.kind === "execute") return "ran";
  if (props.kind === "read") return "read";
  if (props.kind === "edit") return "edited";
  return null;
});
const actionLabel = computed(() => (action.value ? t(ACTION_KEY[action.value]) : ""));
const actionIcon = computed(() => (action.value ? ACTION_ICON[action.value] : "file"));

/**
 * 输出抬头挂文件路径：读取类（输出即文件内容），以及没有 diff 的写类工具
 * （工具只回了句「已写入」，路径信息全在 activity.path 上，不挂就丢）。
 * 有 diff 时路径已经在差分抬头里，别重复。
 */
const showsOutputPath = computed(() => !diff.value && action.value !== null && action.value !== "ran" && Boolean(props.path));
const outputIcon = computed(() => (showsOutputPath.value && action.value ? ACTION_ICON[action.value] : "terminal"));
const outputLabel = computed(() => (showsOutputPath.value && action.value ? t(ACTION_KEY[action.value]) : t("chatView.tools.output")));
const outputPath = computed(() => (showsOutputPath.value ? props.path : undefined));

/** 折叠时每块各留 maxLines 行；四块共用一个展开开关，不要一块一个按钮。 */
function visible<T>(rows: T[]): T[] {
  return expanded.value ? rows : rows.slice(0, props.maxLines);
}

const hiddenLines = computed(() =>
  expanded.value
    ? 0
    : [commandLines.value, diffLines.value, textLines.value, argLines.value].reduce(
        (sum, rows) => sum + Math.max(0, rows.length - props.maxLines),
        0,
      ),
);

/** 行首标记：与 patch 原文一致，方便复制出去还能用。 */
const MARKER: Record<string, string> = { add: "+", del: "-", context: " " };

/** 行底色/字色：与 DiffViewer 对齐（新增 mint、删除 orange）。 */
const LINE_CLASS: Record<string, string> = {
  add: "bg-mint/10 text-mint",
  del: "bg-orange/10 text-orange",
  context: "text-dim",
};
</script>

<template>
  <div
    class="flex flex-col gap-1.5 rounded-[calc(8px*var(--gw-radius-scale))] border border-line bg-panel px-2 py-1.5"
    data-testid="tool-detail"
  >
    <div v-if="diff" class="flex flex-col" data-testid="tool-diff">
      <div class="mb-1 flex items-center gap-1.5 border-b border-line/70 pb-1">
        <Icon :name="actionIcon" :size="10" class="flex-none text-cyan" />
        <span v-if="actionLabel" class="flex-none text-[10.5px] text-dim2" data-testid="tool-detail-action">{{ actionLabel }}</span>
        <span class="min-w-0 flex-1 truncate font-mono text-[10.5px] text-dim">{{ diff.path }}</span>
        <span v-if="diff.added" class="shrink-0 font-mono text-[10.5px] tabular-nums text-mint" data-testid="tool-diff-added"
          >+{{ diff.added }}</span
        >
        <span v-if="diff.removed" class="shrink-0 font-mono text-[10.5px] tabular-nums text-orange" data-testid="tool-diff-removed"
          >-{{ diff.removed }}</span
        >
      </div>
      <div
        v-for="(row, index) in visible(diffLines)"
        :key="`d${index}`"
        class="flex items-start font-mono text-[11px] leading-[1.55]"
        :class="LINE_CLASS[row.kind]"
      >
        <span class="w-8 shrink-0 select-none px-1 text-right tabular-nums text-dim2">{{ row.oldNo ?? "" }}</span>
        <span class="w-8 shrink-0 select-none px-1 text-right tabular-nums text-dim2">{{ row.newNo ?? "" }}</span>
        <span class="w-3 shrink-0 select-none text-center">{{ MARKER[row.kind] ?? "" }}</span>
        <span
          v-if="highlightAt(index)"
          class="min-w-0 flex-1 whitespace-pre-wrap pe-1 [overflow-wrap:anywhere]"
          v-html="highlightAt(index)"
        />
        <span v-else class="min-w-0 flex-1 whitespace-pre-wrap pe-1 [overflow-wrap:anywhere]">{{ row.text }}</span>
      </div>
    </div>

    <div v-if="commandLines.length" class="flex flex-col" data-testid="tool-command">
      <div class="mb-0.5 flex items-center gap-1.5 text-[10.5px] text-dim2">
        <Icon name="terminal" :size="10" class="flex-none" />
        <span>{{ t("chatView.tools.command") }}</span>
      </div>
      <ToolCodeLines :lines="visible(commandLines)" :html="commandHtml" gutter="prompt" />
    </div>

    <div v-if="textLines.length" class="flex flex-col" data-testid="tool-output">
      <div class="mb-0.5 flex min-w-0 items-center gap-1.5 text-[10.5px] text-dim2">
        <Icon :name="outputIcon" :size="10" class="flex-none" />
        <span class="flex-none">{{ outputLabel }}</span>
        <span v-if="outputPath" class="min-w-0 truncate font-mono text-dim" data-testid="tool-output-path">{{ outputPath }}</span>
        <span class="ml-auto flex-none font-mono tabular-nums" data-testid="tool-output-count">{{
          t("chatView.tools.lines", { n: textLines.length })
        }}</span>
      </div>
      <ToolCodeLines :lines="visible(textLines)" :html="outputHtml" />
    </div>

    <div v-if="argLines.length" class="flex flex-col" data-testid="tool-args">
      <div class="mb-0.5 flex items-center gap-1.5 text-[10.5px] text-dim2">
        <Icon name="file" :size="10" class="flex-none" />
        <span>{{ t("chatView.tools.args") }}</span>
      </div>
      <ToolCodeLines :lines="visible(argLines)" :html="argsHtml" tone="text-dim2" />
    </div>

    <div v-if="detail.terminalId" class="font-mono text-[10.5px] text-dim2">
      {{ t("chatView.tools.terminal", { id: detail.terminalId }) }}
    </div>

    <div class="flex items-center gap-2">
      <button
        v-if="hiddenLines > 0 || expanded"
        type="button"
        class="cursor-pointer rounded-[calc(6px*var(--gw-radius-scale))] border border-line px-1.5 py-0.5 text-[10.5px] text-dim transition-colors hover:border-line-2 hover:text-foreground [font-family:inherit]"
        data-testid="tool-detail-toggle"
        @click="expanded = !expanded"
      >
        {{ expanded ? t("chatView.tools.collapseLines") : t("chatView.tools.moreLines", { n: hiddenLines }) }}
      </button>
      <span v-if="detail.clipped" class="text-[10.5px] text-amber">{{ t("chatView.tools.clipped") }}</span>
    </div>
  </div>
</template>
