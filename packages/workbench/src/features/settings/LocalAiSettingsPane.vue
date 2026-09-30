<script setup lang="ts">
/**
 * 设置 · 本地 AI 分区：工作区语义检索（RAG）与语音转写（STT）。
 *
 * 两者都**复用模型供应商**的连接信息（Base URL / 密钥环境变量名 / 附加头），只是
 * embedding / whisper 模型与对话模型不同，故模型名在这里单独配。宿主侧命令见
 * `crates/greywork-host/src/rag.rs` 与 `llm.rs`（`llm_embed` / `llm_transcribe`）。
 *
 * 一处硬边界必须如实说清：**本地服务要自己先跑起来**（Ollama / whisper.cpp server /
 * speaches 等），GreyWork 只做 OpenAI 兼容客户端的调用方，不内嵌模型。
 */
import { computed, onMounted, ref } from "vue";
import { hasHostCommands } from "@greywork/host-ipc";
import { resolveWorkspaceRoot } from "@/lib/workspace-dir";
import { useSettingsStore, LOCAL_AI_TOP_K_RANGE } from "@/stores/settings";
import { useLocalAiStore } from "@/stores/local-ai";

const settings = useSettingsStore();
const localAi = useLocalAiStore();

/** 浏览器预览态没有宿主命令，这一页的开关都无从生效 —— 如实说明而不是给能点但没反应的按钮。 */
const hostAvailable = hasHostCommands();

const rag = computed(() => settings.localAi.rag);
const stt = computed(() => settings.localAi.stt);

/** 索引根（当前工作区目录）——展示用，实际以构建时的解析结果为准。 */
const workspaceRoot = ref("");
onMounted(async () => {
  if (hostAvailable) {
    await localAi.refreshStatus();
    localAi.ensureListener();
    try {
      workspaceRoot.value = (await resolveWorkspaceRoot()).dir;
    } catch {
      workspaceRoot.value = "";
    }
  }
});

/** 供应商下拉：空值 = 跟随当前选中的对话供应商。 */
function setRagProvider(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  settings.setLocalAiRag({ providerId: value === "" ? null : value });
}

function setSttProvider(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  settings.setLocalAiStt({ providerId: value === "" ? null : value });
}

function setTopK(event: Event): void {
  settings.setLocalAiRag({ topK: Number((event.target as HTMLInputElement).value) });
}

const progressText = computed(() =>
  localAi.progress.total > 0 ? `${localAi.progress.done} / ${localAi.progress.total} 个文件` : "准备中…",
);
</script>

<template>
  <div class="flex flex-col gap-4">
    <p v-if="!hostAvailable" class="rounded-[calc(10px*var(--gw-radius-scale))] bg-panel-2 px-3 py-2 text-[11px] leading-[1.6] text-dim2">
      当前是浏览器预览态，没有宿主进程：本地检索与语音转写不可用。请用桌面端或自托管服务端打开。
    </p>

    <!-- 本地检索（RAG） -->
    <div class="rounded-[calc(14px*var(--gw-radius-scale))] border border-line bg-panel p-4">
      <div class="mb-3 flex items-center justify-between gap-2">
        <span class="text-[13px] font-medium text-foreground">工作区语义检索（RAG）</span>
        <label class="flex cursor-pointer items-center gap-1.5 text-[11px] text-dim">
          <input
            type="checkbox"
            class="size-4 cursor-pointer accent-[var(--accent)]"
            :checked="rag.enabled"
            data-testid="rag-enabled"
            aria-label="启用工作区语义检索"
            @change="settings.setLocalAiRag({ enabled: ($event.target as HTMLInputElement).checked })"
          />
          启用
        </label>
      </div>
      <p class="mb-3 text-[11px] leading-relaxed text-dim2">
        构建后，每轮对话会用本地 embedding
        检索工作区里最相关的片段并注入上下文。索引只覆盖<strong>已授权的工作区根</strong>内的文本文件（忽略 node_modules / target
        等目录，单文件 ≤ 1MB），向量存在本地 SQLite，绝不上传。
      </p>

      <div class="flex flex-col gap-2.5">
        <label class="flex items-center gap-2">
          <span class="w-24 shrink-0 text-[11.5px] text-dim2">embedding 供应商</span>
          <select
            class="min-w-0 flex-1 cursor-pointer rounded-[calc(8px*var(--gw-radius-scale))] border border-line bg-panel-2 px-2 py-1.5 text-[12px] text-foreground outline-none focus:border-line-2"
            :value="rag.providerId ?? ''"
            data-testid="rag-provider"
            @change="setRagProvider"
          >
            <option value="">跟随当前选中的供应商</option>
            <option v-for="provider in settings.modelProviders" :key="provider.id" :value="provider.id">{{ provider.name }}</option>
          </select>
        </label>
        <label class="flex items-center gap-2">
          <span class="w-24 shrink-0 text-[11.5px] text-dim2">embedding 模型</span>
          <input
            class="min-w-0 flex-1 rounded-[calc(8px*var(--gw-radius-scale))] border border-line bg-panel-2 px-2 py-1.5 font-mono text-[12px] text-foreground outline-none placeholder:text-dim2 focus:border-line-2"
            :value="rag.embeddingModel"
            placeholder="bge-m3 / nomic-embed-text"
            data-testid="rag-model"
            @input="settings.setLocalAiRag({ embeddingModel: ($event.target as HTMLInputElement).value })"
          />
        </label>
        <label class="flex items-center gap-2">
          <span class="w-24 shrink-0 text-[11.5px] text-dim2">注入片段数</span>
          <input
            type="number"
            class="w-24 rounded-[calc(8px*var(--gw-radius-scale))] border border-line bg-panel-2 px-2 py-1.5 text-[12px] text-foreground outline-none focus:border-line-2"
            :value="rag.topK"
            :min="LOCAL_AI_TOP_K_RANGE.min"
            :max="LOCAL_AI_TOP_K_RANGE.max"
            data-testid="rag-topk"
            @change="setTopK"
          />
          <span class="text-[11px] text-dim2">每次检索注入的片段数（{{ LOCAL_AI_TOP_K_RANGE.min }}–{{ LOCAL_AI_TOP_K_RANGE.max }}）</span>
        </label>
      </div>

      <div class="mt-3 flex flex-col gap-2 rounded-[calc(10px*var(--gw-radius-scale))] bg-panel-2 px-3 py-2.5">
        <div class="flex items-center gap-2 text-[11px] text-dim2">
          <span class="truncate">索引根：{{ workspaceRoot || "（未解析）" }}</span>
        </div>
        <div class="flex items-center gap-2 text-[11px] text-dim2" data-testid="rag-status">
          <span>已索引 {{ localAi.status.files }} 个文件 / {{ localAi.status.chunks }} 个片段</span>
          <span v-if="localAi.status.model" class="truncate">· 模型 {{ localAi.status.model }}</span>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="h-7 cursor-pointer rounded-[calc(7px*var(--gw-radius-scale))] bg-accent px-3 text-[11.5px] font-medium text-accent-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="!hostAvailable || localAi.building"
            data-testid="rag-build"
            @click="localAi.buildIndex(false)"
          >
            {{ localAi.building ? progressText : "构建 / 增量更新索引" }}
          </button>
          <button
            type="button"
            class="h-7 cursor-pointer rounded-[calc(7px*var(--gw-radius-scale))] border border-line bg-panel px-2.5 text-[11px] text-dim transition-colors hover:bg-panel-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="!hostAvailable || localAi.building"
            data-testid="rag-rebuild"
            @click="localAi.buildIndex(true)"
          >
            全量重建
          </button>
          <button
            type="button"
            class="h-7 cursor-pointer rounded-[calc(7px*var(--gw-radius-scale))] border border-line bg-panel px-2.5 text-[11px] text-dim transition-colors hover:bg-panel-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="!hostAvailable || localAi.building"
            data-testid="rag-clear"
            @click="localAi.clearIndex()"
          >
            清空索引
          </button>
        </div>
      </div>
    </div>

    <!-- 本地语音转写（STT） -->
    <div class="rounded-[calc(14px*var(--gw-radius-scale))] border border-line bg-panel p-4">
      <div class="mb-3 flex items-center justify-between gap-2">
        <span class="text-[13px] font-medium text-foreground">语音转写（STT）</span>
        <label class="flex cursor-pointer items-center gap-1.5 text-[11px] text-dim">
          <input
            type="checkbox"
            class="size-4 cursor-pointer accent-[var(--accent)]"
            :checked="stt.enabled"
            data-testid="stt-enabled"
            aria-label="启用语音转写"
            @change="settings.setLocalAiStt({ enabled: ($event.target as HTMLInputElement).checked })"
          />
          启用
        </label>
      </div>
      <p class="mb-3 text-[11px] leading-relaxed text-dim2">
        启用后，语音附件（上传的音频、各聊天通道的入站语音）会先经本地 whisper
        服务转写成文本再进模型；未启用或转写失败时，回落到只递文件路径引用。 需要本机跑一个 <strong>OpenAI 兼容</strong>的 whisper 服务（如
        whisper.cpp server 的 <code class="font-mono">/v1/audio/transcriptions</code>、speaches），把它的地址填进对应供应商的 Base URL。
      </p>
      <div class="flex flex-col gap-2.5">
        <label class="flex items-center gap-2">
          <span class="w-24 shrink-0 text-[11.5px] text-dim2">转写供应商</span>
          <select
            class="min-w-0 flex-1 cursor-pointer rounded-[calc(8px*var(--gw-radius-scale))] border border-line bg-panel-2 px-2 py-1.5 text-[12px] text-foreground outline-none focus:border-line-2"
            :value="stt.providerId ?? ''"
            data-testid="stt-provider"
            @change="setSttProvider"
          >
            <option value="">跟随当前选中的供应商</option>
            <option v-for="provider in settings.modelProviders" :key="provider.id" :value="provider.id">{{ provider.name }}</option>
          </select>
        </label>
        <label class="flex items-center gap-2">
          <span class="w-24 shrink-0 text-[11.5px] text-dim2">whisper 模型</span>
          <input
            class="min-w-0 flex-1 rounded-[calc(8px*var(--gw-radius-scale))] border border-line bg-panel-2 px-2 py-1.5 font-mono text-[12px] text-foreground outline-none placeholder:text-dim2 focus:border-line-2"
            :value="stt.model"
            placeholder="whisper-1"
            data-testid="stt-model"
            @input="settings.setLocalAiStt({ model: ($event.target as HTMLInputElement).value })"
          />
        </label>
      </div>
    </div>
  </div>
</template>
