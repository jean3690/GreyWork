<script setup lang="ts">
/**
 * 交付物卡片组（对话内）：按消息携带的 artifact id 列出产物，给出预览与磁盘两个入口。
 *
 * 两个入口的分工是刻意的：「预览」在右栏就地打开（VFS 路径），是主路径；
 * 「在文件夹中打开」需要真落盘，浏览器态没有磁盘通道，按钮禁用并说明原因，
 * 而不是点了没反应。
 */
import { computed, ref } from "vue";
import { revealInFolder } from "../lib/reveal";
import { useArtifactStore } from "../stores/artifact";
import { usePreviewStore } from "../stores/preview";
import Icon from "./Icon.vue";

const props = defineProps<{ ids: string[] }>();

const artifactStore = useArtifactStore();
const preview = usePreviewStore();

/** 未登记的 id 直接跳过（消息比卡片活得久：清过产物的历史会话仍带着旧 id）。 */
const cards = computed(() => props.ids.map((id) => artifactStore.byId(id)).filter((artifact) => artifact !== undefined));

/** 最近一次打开失败的卡片 id（就地提示，不弹全局 toast）。 */
const failedId = ref<string | null>(null);

async function open(id: string, diskPath: string): Promise<void> {
  failedId.value = (await revealInFolder(diskPath)) ? null : id;
}
</script>

<template>
  <div v-if="cards.length" class="flex flex-col gap-1.5">
    <div
      v-for="artifact in cards"
      :key="artifact.id"
      data-testid="artifact-card"
      class="flex flex-col gap-1 rounded-[10px] border border-line bg-panel-2 px-3 py-2"
    >
      <div class="flex items-center gap-2">
        <Icon name="folder" :size="13" class="shrink-0 text-dim2" />
        <button
          type="button"
          data-testid="artifact-name"
          :disabled="!artifact.path"
          :title="artifact.path ? `在预览面板打开 ${artifact.path}` : '该产物没有 VFS 路径，无法预览'"
          class="min-w-0 flex-1 cursor-pointer truncate text-start text-[12.5px] text-foreground transition-colors hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan disabled:cursor-default disabled:hover:text-foreground"
          @click="artifact.path && preview.open(artifact.path, artifact.name)"
        >
          {{ artifact.name }}
        </button>
        <span class="shrink-0 text-[10.5px] text-dim2">{{ artifact.meta }}</span>
        <button
          type="button"
          data-testid="artifact-preview"
          :disabled="!artifact.path"
          :title="artifact.path ? '在右侧预览面板打开' : '该产物没有 VFS 路径，无法预览'"
          aria-label="预览"
          class="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-full border border-line bg-panel px-2 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:opacity-40"
          @click="artifact.path && preview.open(artifact.path, artifact.name)"
        >
          <Icon name="magic" :size="11" />
          预览
        </button>
        <button
          type="button"
          data-testid="artifact-reveal"
          :disabled="!artifact.diskPath"
          :title="artifact.diskPath ? '在系统文件管理器中打开所在文件夹' : '浏览器态未落盘：无磁盘路径可打开'"
          aria-label="在文件夹中打开"
          class="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-full border border-line bg-panel px-2 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:opacity-40"
          @click="artifact.diskPath && open(artifact.id, artifact.diskPath)"
        >
          <Icon name="folder" :size="11" />
          在文件夹中打开
        </button>
      </div>
      <span v-if="artifact.diskPath" class="break-all font-mono text-[10.5px] text-dim2">{{ artifact.diskPath }}</span>
      <span v-if="failedId === artifact.id" role="alert" class="text-[11px] text-red-400">打开失败，路径可能已被移动或删除</span>
    </div>
  </div>
</template>
