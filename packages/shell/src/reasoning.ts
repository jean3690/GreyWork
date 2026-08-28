import type { ReasoningEffort } from "./types";

export interface ReasoningEffortOption {
  value: ReasoningEffort;
  /** i18n key：渲染处经 t() 转译（shell 为纯 TS 包，不引入 vue-i18n）。 */
  label: string;
  description: string;
}

export const REASONING_EFFORTS: ReasoningEffortOption[] = [
  { value: "auto", label: "reasoning.auto.label", description: "reasoning.auto.description" },
  { value: "low", label: "reasoning.low.label", description: "reasoning.low.description" },
  { value: "medium", label: "reasoning.medium.label", description: "reasoning.medium.description" },
  { value: "high", label: "reasoning.high.label", description: "reasoning.high.description" },
  { value: "max", label: "reasoning.max.label", description: "reasoning.max.description" },
];

export const REASONING_LABELS: Record<ReasoningEffort, string> = {
  auto: "reasoning.auto.label",
  low: "reasoning.low.label",
  medium: "reasoning.medium.label",
  high: "reasoning.high.label",
  max: "reasoning.max.label",
};
