<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { FileText, FileSpreadsheet } from "lucide-vue-next";
import MarkdownText from "../MarkdownText.vue";
import { useArtifactStore } from "../../stores/artifact";
import { workspaceFs } from "../../stores/vfs";
import type { Artifact } from "../../types";
import { useI18n } from "vue-i18n";

const artifactStore = useArtifactStore();
const { t } = useI18n();

/** 最新 Markdown 产物预览（读自虚拟文件系统；无产物文件时回退种子报告）。 */
const previewPath = ref("");
const previewContent = ref("");

/** 最新 xlsx 产物（二进制不落文本预览，提供下载入口）。 */
const latestXlsx = computed(() => artifactStore.artifacts.find((artifact) => artifact.format === "xlsx"));

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

/** xlsx 产物下载：读 VFS 二进制 → Blob → 触发浏览器下载。 */
async function downloadArtifact(artifact: Artifact): Promise<void> {
  if (artifact.format !== "xlsx") return;
  const path = `reports/${artifact.name}`;
  try {
    const data = await workspaceFs.readBinary(path);
    const blob = new Blob([data], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = artifact.name;
    anchor.click();
    URL.revokeObjectURL(url);
  } catch {
    /* 二进制文件不在 VFS 中（mock 环境） */
  }
}

void loadPreview();
watch(
  () => artifactStore.artifacts.length,
  () => void loadPreview(),
);
</script>

<template>
  <div class="side__pane">
    <p class="side__cap">{{ t("panels.artifacts.deliverables") }}</p>
    <div class="artifacts">
      <div v-for="a in artifactStore.artifacts" :key="a.id" class="artifact" :data-artifact-id="a.id">
        <span class="artifact__glyph">
          <FileSpreadsheet v-if="a.format === 'xlsx'" class="size-4" />
          <FileText v-else class="size-4" />
        </span>
        <div>
          <strong>{{ a.name }}</strong
          ><span>{{ a.meta }} · {{ a.source }}</span>
        </div>
        <span v-if="a.format === 'xlsx'" class="artifact__badge">XLSX</span>
        <button v-if="a.format === 'xlsx'" class="btn btn--mini" @click="downloadArtifact(a)">{{ t("panels.artifacts.download") }}</button>
        <button v-else class="btn btn--mini">{{ t("panels.artifacts.open") }}</button>
      </div>
    </div>
    <p class="side__cap">
      {{ previewPath ? t("panels.artifacts.latestPreviewPath", { path: previewPath }) : t("panels.artifacts.latestPreview") }}
    </p>
    <div v-if="previewContent" class="artifact-preview">
      <MarkdownText :content="previewContent" />
    </div>
    <div v-else-if="latestXlsx" class="artifact-preview xlsx-note">
      <FileSpreadsheet class="size-4" />
      <span>{{ t("panels.artifacts.xlsxHint") }} · {{ latestXlsx.meta }}</span>
    </div>
    <p v-else class="footnote">{{ t("panels.artifacts.empty") }}</p>
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

.xlsx-note {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
  font-size: 12.5px;
}

.artifact__badge {
  flex: none;
  padding: 2px 6px;
  border: 1px solid var(--line-2);
  border-radius: 6px;
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--muted);
  font-family: var(--font-mono);
}
</style>
