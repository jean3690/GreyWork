<script setup lang="ts">
import { useArtifactStore } from "../../stores/artifact";

const artifactStore = useArtifactStore();
const highCount = artifactStore.reviewItems.filter((item) => item.level === "high").length;
</script>

<template>
  <div class="side__pane">
    <div class="review-score">
      <strong>B+</strong>
      <span>{{ artifactStore.reviewItems.length }} 条待处理意见 · {{ highCount }} 高危</span>
    </div>
    <div class="review-list">
      <div v-for="r in artifactStore.reviewItems" :key="r.file + r.comment" class="review-item" :data-level="r.level">
        <span class="review-item__level">{{ r.level === "high" ? "高危" : r.level === "medium" ? "建议" : "提示" }}</span>
        <div>
          <code>{{ r.file }}</code>
          <p>{{ r.comment }}</p>
        </div>
      </div>
    </div>
  </div>
</template>
