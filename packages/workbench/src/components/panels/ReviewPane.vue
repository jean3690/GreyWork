<script setup lang="ts">
import { useArtifactStore } from "../../stores/artifact";
import { useI18n } from "vue-i18n";

const artifactStore = useArtifactStore();
const { t } = useI18n();
const highCount = artifactStore.reviewItems.filter((item) => item.level === "high").length;
</script>

<template>
  <div class="side__pane">
    <div class="review-score">
      <strong>B+</strong>
      <span>{{ t("panels.review.summary", { count: artifactStore.reviewItems.length, high: highCount }) }}</span>
    </div>
    <div class="review-list">
      <div v-for="r in artifactStore.reviewItems" :key="r.file + r.comment" class="review-item" :data-level="r.level">
        <span class="review-item__level">{{
          r.level === "high"
            ? t("panels.review.levelHigh")
            : r.level === "medium"
              ? t("panels.review.levelMedium")
              : t("panels.review.levelLow")
        }}</span>
        <div>
          <code>{{ r.file }}</code>
          <p>{{ r.comment }}</p>
        </div>
      </div>
    </div>
  </div>
</template>
