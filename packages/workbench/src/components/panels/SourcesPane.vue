<script setup lang="ts">
import { computed } from "vue";
import { useArtifactStore } from "../../stores/artifact";
 import { DataTable, type TableColumn } from "../ui";
 import { Globe } from "lucide-vue-next";
 import { statusLetter, useVfsStore } from "../../stores/vfs";
const artifactStore = useArtifactStore();
const vfs = useVfsStore();

const gitRows = computed(() =>
  vfs.changes.map((change) => ({ status: statusLetter(change.status), path: change.path, add: change.add, del: change.del })),
);

const gitColumns: TableColumn[] = [
  { title: "状态", key: "status", width: 64 },
  { title: "路径", key: "path" },
];
</script>

<template>
  <div class="side__pane">
    <p class="side__cap">AI 引用的来源</p>
    <div class="src-list">
      <div v-for="s in artifactStore.sources" :key="s.title" class="src">
        <span class="src__glyph"><Globe class="size-4" /></span>
        <div>
          <strong>{{ s.title }}</strong
          ><code>{{ s.host }}</code>
        </div>
      </div>
    </div>
    <p class="side__cap">Git 状态 · {{ gitRows.length }} CHANGES（虚拟文件系统）</p>
    <DataTable :columns="gitColumns" :data="gitRows" class="text-xs" />
    <p v-if="!gitRows.length" class="footnote">与基线一致，暂无变更。</p>
  </div>
</template>
