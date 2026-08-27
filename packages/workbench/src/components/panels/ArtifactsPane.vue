<script setup lang="ts">
import { ref, watch } from "vue";
import { FileText } from "lucide-vue-next";
import MarkdownText from "../MarkdownText.vue";
import { useArtifactStore } from "../../stores/artifact";
import { workspaceFs } from "../../stores/vfs";

const artifactStore = useArtifactStore();

/** 最新 Markdown 产物预览（读自虚拟文件系统；无产物文件时回退种子报告）。 */
const previewPath = ref("");
const previewContent = ref("");

async function loadPreview(): Promise<void> {
  const live = artifactStore.artifacts.find((artifact) => artifact.name.endsWith(".md"));
  const candidates = [live ? `reports/${live.name}` : "", "reports/城市态势报告.md"].filter(Boolean);
  for (const path of candidates) {
    if (await workspaceFs.exists(path)) {
      previewPath.value = path;
      previewContent.value = await workspaceFs.readFile(path);
      return;
    }
  }
  previewPath.value = "";
  previewContent.value = "";
}

void loadPreview();
watch(
  () => artifactStore.artifacts.length,
  () => void loadPreview(),
);
</script>

<template>
  <div class="side__pane">
    <p class="side__cap">交付物 · ARTIFACTS</p>
    <div class="artifacts">
      <div v-for="a in artifactStore.artifacts" :key="a.id" class="artifact" :data-artifact-id="a.id">
        <span class="artifact__glyph"><FileText class="size-4" /></span>
        <div>
          <strong>{{ a.name }}</strong
          ><span>{{ a.meta }} · {{ a.source }}</span>
        </div>
        <button class="btn btn--mini">打开</button>
      </div>
    </div>
    <p class="side__cap">最新产物预览{{ previewPath ? ` · ${previewPath}` : "" }}</p>
    <div v-if="previewContent" class="artifact-preview">
      <MarkdownText :content="previewContent" />
    </div>
    <p v-else class="footnote">运行一次任务后，Markdown 产物会在这里预览。</p>
  </div>
</template>

<style scoped>
.artifact-preview {
  max-height: 260px;
  overflow: auto;
  padding: 12px;
  border: 1px solid var(--line-2);
  border-radius: 12px;
  background: var(--panel);
}
</style>
