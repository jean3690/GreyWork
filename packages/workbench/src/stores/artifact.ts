import type { Artifact, ReviewItem, SourceRef } from "../types";
import { MOCK_ARTIFACTS, MOCK_REVIEW_ITEMS, MOCK_SOURCE_ITEMS } from "../mocks/artifacts";
import { defineStore } from "pinia";
import { ref } from "vue";

let artifactSeq = 0;

/** 活动产物：交付物 / 审查 / 来源（ActivityPanel 数据源；Diff 由 vfsStore 驱动）。 */
export const useArtifactStore = defineStore("artifact", () => {
  const artifacts = ref<Artifact[]>([...MOCK_ARTIFACTS]);
  const reviewItems = ref<ReviewItem[]>([...MOCK_REVIEW_ITEMS]);
  const sources = ref<SourceRef[]>([...MOCK_SOURCE_ITEMS]);

  /** 交付物流线终点：追加一条交付物卡片并返回其 id。 */
  function pushArtifact(input: Pick<Artifact, "name" | "meta" | "type" | "source">): string {
    artifactSeq += 1;
    const id = `af-live-${artifactSeq}`;
    artifacts.value.unshift({ ...input, id, createdAt: Date.now() });
    return id;
  }

  return { artifacts, reviewItems, sources, pushArtifact };
});
