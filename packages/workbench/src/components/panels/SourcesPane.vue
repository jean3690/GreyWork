<script setup lang="ts">
import { computed } from "vue";
import { useArtifactStore } from "../../stores/artifact";
import { DataTable, type TableColumn } from "../ui";
import { Globe } from "lucide-vue-next";
import { statusLetter, useVfsStore } from "../../stores/vfs";
import { useI18n } from "vue-i18n";
const artifactStore = useArtifactStore();
const vfs = useVfsStore();
const { t } = useI18n();

const gitRows = computed(() =>
  vfs.changes.map((change) => ({ status: statusLetter(change.status), path: change.path, add: change.add, del: change.del })),
);

const gitColumns: TableColumn[] = [
  { title: t("panels.sources.status"), key: "status", width: 64 },
  { title: t("panels.sources.path"), key: "path" },
];
</script>

<template>
  <div class="side__pane">
    <p class="side__cap">{{ t("panels.sources.refTitle") }}</p>
    <div class="src-list">
      <div v-for="s in artifactStore.sources" :key="s.title" class="src">
        <span class="src__glyph"><Globe class="size-4" /></span>
        <div>
          <strong>{{ s.title }}</strong
          ><code>{{ s.host }}</code>
        </div>
      </div>
    </div>
    <p class="side__cap">{{ t("panels.sources.gitStatus", { count: gitRows.length }) }}</p>
    <DataTable :columns="gitColumns" :data="gitRows" class="text-xs" />
    <p v-if="!gitRows.length" class="footnote">{{ t("panels.sources.noChanges") }}</p>
  </div>
</template>
