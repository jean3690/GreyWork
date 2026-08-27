<script setup lang="ts">
import { computed, ref } from "vue";
import { Check, Copy } from "lucide-vue-next";

/**
 * 轻量 Markdown：仅渲染围栏代码块（路径标签 + 行号 + 复制）、行内 code、粗体与链接。
 * 不引入依赖、不使用 v-html（内容来自模型输出，规避注入）。
 */
const props = defineProps<{ content: string }>();

type InlineToken = { t: "text"; v: string } | { t: "code"; v: string } | { t: "bold"; v: string } | { t: "link"; v: string; href: string };

interface Block {
  type: "p" | "code";
  inline?: InlineToken[];
  lang?: string;
  path?: string;
  codeLines?: string[];
}

const PATH_LABEL = /^[\w.-]+[\\/][\w./-]+\.\w{1,8}$/;
const SAFE_SCHEME = /^(https?:|mailto:|#)/i;

function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  for (const match of text.matchAll(re)) {
    const index = match.index ?? 0;
    if (index > last) tokens.push({ t: "text", v: text.slice(last, index) });
    const raw = match[0];
    if (raw.startsWith("`")) tokens.push({ t: "code", v: raw.slice(1, -1) });
    else if (raw.startsWith("**")) tokens.push({ t: "bold", v: raw.slice(2, -2) });
    else {
      const link = raw.slice(1, -1);
      const sep = link.lastIndexOf("](");
      const href = link.slice(sep + 2).trim();
      if (SAFE_SCHEME.test(href)) tokens.push({ t: "link", v: link.slice(0, sep), href });
      else tokens.push({ t: "text", v: raw });
    }
    last = index + raw.length;
  }
  if (last < text.length) tokens.push({ t: "text", v: text.slice(last) });
  return tokens;
}

/** 顺序解析：段落 / 围栏代码块（```lang 或 ```lang 路径名）。 */
function parseBlocks(content: string): Block[] {
  const out: Block[] = [];
  const lines = content.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```(\S+)?\s*(.*)$/);
    if (fence) {
      const lang = fence[1] ?? "";
      const caption = fence[2]?.trim() ?? "";
      const path = PATH_LABEL.test(caption) ? caption : undefined;
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过闭合围栏
      out.push({ type: "code", lang, path, codeLines });
      continue;
    }
    if (line.trim().length === 0) {
      i += 1;
      continue;
    }
    out.push({ type: "p", inline: parseInline(line) });
    i += 1;
  }
  return out;
}

const blocks = computed(() => parseBlocks(props.content));

const copiedIndex = ref(-1);
let copyTimer: ReturnType<typeof setTimeout> | null = null;

async function copy(index: number): Promise<void> {
  const block = blocks.value[index];
  if (!block?.codeLines) return;
  await navigator.clipboard?.writeText(block.codeLines.join("\n"));
  copiedIndex.value = index;
  if (copyTimer) clearTimeout(copyTimer);
  copyTimer = setTimeout(() => (copiedIndex.value = -1), 1500);
}
</script>

<template>
  <div class="md">
    <template v-for="(block, i) in blocks" :key="i">
      <p v-if="block.type === 'p'">
        <template v-for="(token, j) in block.inline" :key="j">
          <code v-if="token.t === 'code'">{{ token.v }}</code>
          <strong v-else-if="token.t === 'bold'">{{ token.v }}</strong>
          <a v-else-if="token.t === 'link'" :href="token.href" target="_blank" rel="noopener">{{ token.v }}</a>
          <template v-else>{{ token.v }}</template>
        </template>
      </p>
      <div v-else class="md-code">
        <div class="md-code__head">
          <span v-if="block.path" class="md-code__path">{{ block.path }}</span>
          <span v-else-if="block.lang" class="md-code__lang">{{ block.lang }}</span>
          <button class="md-code__copy" :aria-label="copiedIndex === i ? '已复制' : '复制代码'" @click="copy(i)">
            <Check v-if="copiedIndex === i" class="size-3" />
            <Copy v-else class="size-3" />
          </button>
        </div>
        <div class="md-code__body">
          <div class="md-code__lines" aria-hidden="true">
            <span v-for="(_, n) in block.codeLines" :key="n">{{ n + 1 }}</span>
          </div>
          <pre><code>{{ block.codeLines?.join("\n") }}</code></pre>
        </div>
      </div>
    </template>
  </div>
</template>
