import type { ReasoningEffort } from "./types";

export interface ReasoningEffortOption {
  value: ReasoningEffort;
  label: string;
  description: string;
}

export const REASONING_EFFORTS: ReasoningEffortOption[] = [
  { value: "auto", label: "自动", description: "由模型供应商自动选择" },
  { value: "low", label: "低 · Low", description: "最快响应，适合简单指令" },
  { value: "medium", label: "中 · Medium", description: "平衡速度与质量" },
  { value: "high", label: "高 · High", description: "复杂空间分析 / 代码审查" },
  { value: "max", label: "最高 · Max", description: "深度推理，适合困难任务" },
];

export const REASONING_LABELS: Record<ReasoningEffort, string> = {
  auto: "自动",
  low: "低",
  medium: "中",
  high: "高",
  max: "最高",
};
