<script setup lang="ts">
import { computed, ref } from "vue";
import { Check, Copy } from "lucide-vue-next";
import { parseBlocks } from "../lib/markdown";
import MarkdownInline from "./MarkdownInline.vue";
import MarkdownList from "./MarkdownList.vue";

/**
 * Markdown 渲染：解析在 lib/markdown.ts，此处只做块级分派与样式。
 * 支持标题、段落、有序/无序嵌套列表、表格、引用、分割线、围栏代码块
 * （路径标签 + 行号 + 复制）与行内 code/粗体/斜体/删除线/链接。
 * 不引入解析依赖、不使用 v-html —— 内容来自模型输出，从根上规避注入。
 */
const props = defineProps<{ content: string }>();

const blocks = computed(() => parseBlocks(props.content));

const copiedIndex = ref(-1);
let copyTimer: ReturnType<typeof setTimeout> | null = null;

async function copy(index: number): Promise<void> {
  const block = blocks.value[index];
  if (block?.type !== "code") return;
  await navigator.clipboard?.writeText(block.codeLines.join("\n"));
  copiedIndex.value = index;
  if (copyTimer) clearTimeout(copyTimer);
  copyTimer = setTimeout(() => (copiedIndex.value = -1), 1500);
}

/** 表格列对齐：解析器给 null 时不落 style，交给默认左对齐。 */
function alignOf(align: (string | null)[], column: number): Record<string, string> {
  const value = align[column];
  return value ? { "text-align": value } : {};
}
</script>

<template>
  <div class="md text-[13.5px] leading-[1.7] text-foreground [overflow-wrap:anywhere] [&>:first-child]:mt-0 [&>:last-child]:mb-0">
    <template v-for="(block, i) in blocks" :key="i">
      <!-- 标题：动态标签保持 h1–h6 语义层级，供屏幕阅读器构建文档大纲 -->
      <component
        :is="`h${block.level}`"
        v-if="block.type === 'heading'"
        class="md__h font-display font-bold leading-[1.3] mt-[1.15em] mb-[0.5em] text-foreground"
        :class="{
          'text-[1.6em] pb-[0.3em] border-b border-line': block.level === 1,
          'text-[1.32em] pb-[0.25em] border-b border-line': block.level === 2,
          'text-[1.15em]': block.level === 3,
          'text-[1.04em]': block.level === 4,
          'text-[1em]': block.level === 5,
          'text-[1em] text-dim': block.level === 6,
        }"
      >
        <MarkdownInline :tokens="block.inline" />
      </component>

      <p v-else-if="block.type === 'p'" class="md__p my-[0.6em]">
        <template v-for="(line, j) in block.lines" :key="j">
          <br v-if="j > 0" />
          <MarkdownInline :tokens="line" />
        </template>
      </p>

      <MarkdownList v-else-if="block.type === 'list'" :node="block" />

      <blockquote v-else-if="block.type === 'quote'" class="md__quote my-[0.7em] py-0.5 pl-3 border-l-[3px] border-line-2 text-dim">
        <template v-for="(line, j) in block.lines" :key="j">
          <br v-if="j > 0" />
          <MarkdownInline :tokens="line" />
        </template>
      </blockquote>

      <hr v-else-if="block.type === 'hr'" class="md__hr my-[1.1em] border-0 border-t border-line" />

      <div v-else-if="block.type === 'table'" class="md__table-wrap my-[0.7em] overflow-x-auto rounded-[8px] border border-line">
        <table class="md__table w-full border-collapse text-[0.94em] [&_tbody_tr:last-child_td]:border-b-0">
          <thead>
            <tr>
              <th
                v-for="(cell, c) in block.headers"
                :key="c"
                :style="alignOf(block.align, c)"
                scope="col"
                class="px-2.5 py-1.5 border-b border-line text-left align-top bg-panel-2 font-bold whitespace-nowrap"
              >
                <MarkdownInline :tokens="cell" />
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, r) in block.rows" :key="r">
              <td
                v-for="(cell, c) in row"
                :key="c"
                :style="alignOf(block.align, c)"
                class="px-2.5 py-1.5 border-b border-line text-left align-top"
              >
                <MarkdownInline :tokens="cell" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-else-if="block.type === 'code'" class="md-code my-[0.7em] overflow-hidden rounded-[8px] border border-line bg-panel-2">
        <div class="md-code__head flex items-center gap-2 border-b border-line bg-panel py-1 pl-2.5 pr-2">
          <span v-if="block.path" class="md-code__path font-mono text-[11px] text-dim">{{ block.path }}</span>
          <span v-else-if="block.lang" class="md-code__lang font-mono text-[11px] text-dim2">{{ block.lang }}</span>
          <span v-else class="md-code__lang font-mono text-[11px] text-dim2">text</span>
          <button
            class="md-code__copy ml-auto grid size-[22px] place-items-center rounded-[5px] border border-transparent bg-transparent text-dim2 cursor-pointer hover:border-line hover:bg-panel-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
            :aria-label="copiedIndex === i ? '已复制' : '复制代码'"
            @click="copy(i)"
          >
            <Check v-if="copiedIndex === i" class="size-3" />
            <Copy v-else class="size-3" />
          </button>
        </div>
        <div class="md-code__body flex overflow-x-auto font-mono text-xs leading-[1.6]">
          <div
            class="md-code__lines flex flex-none flex-col py-2 pl-2.5 pr-2 border-r border-line text-dim2 text-right select-none"
            aria-hidden="true"
          >
            <span v-for="(_, n) in block.codeLines" :key="n">{{ n + 1 }}</span>
          </div>
          <pre
            class="m-0 flex-1 min-w-0 px-3 py-2"
          ><code class="[font-family:inherit] whitespace-pre">{{ block.codeLines.join("\n") }}</code></pre>
        </div>
      </div>
    </template>
  </div>
</template>
