import type { Artifact, ReviewItem, SourceRef } from "../types";

/** 交付物种子（Artifacts 标签初始内容；运行期由 chatStore 管线追加）。 */
export const MOCK_ARTIFACTS: Artifact[] = [
  {
    id: "af-1",
    name: "weekly-report.md",
    meta: "Markdown · 12 KB",
    type: "report",
    source: "report-agent",
    createdAt: Date.now() - 86400_000,
  },
  {
    id: "af-2",
    name: "stations-result.csv",
    meta: "CSV · 4 行",
    type: "dataset",
    source: "analytics-agent",
    createdAt: Date.now() - 43200_000,
  },
  {
    id: "af-3",
    name: "core-refactor.patch",
    meta: "Patch · +412 −96",
    type: "diff",
    source: "workbench-agent",
    createdAt: Date.now() - 3600_000,
  },
];

/** Review 标签样本。 */
export const MOCK_REVIEW_ITEMS: ReviewItem[] = [
  { level: "high", file: "AppShell.vue", comment: "模拟任务链的定时器需确认在宿主卸载时清理，避免更新已卸载组件。" },
  { level: "medium", file: "session.ts", comment: "createSession 缺少并发去重，快速双击会产生重复会话。" },
  { level: "low", file: "App.vue", comment: "建议为根组件补充错误边界，避免局部渲染异常导致白屏。" },
];

/** Sources 标签样本：AI 引用来源。 */
export const MOCK_SOURCE_ITEMS: SourceRef[] = [
  { title: "Tauri 2.x · Window Customization Guide", host: "tauri.app" },
  { title: "Naive UI · Dark Theme Overrides", host: "naiveui.com" },
  { title: "CesiumJS · WebGL Fallback Strategies", host: "cesium.com" },
  { title: "Vue 3 · Reactivity in Depth", host: "vuejs.org" },
];
