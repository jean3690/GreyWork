import type { ModelProviderConfig } from "@greywork/shell";

/**
 * 从供应商列表里挑一个实际可用的（选中项优先，否则回落第一个可用）。
 *
 * Phase 1 统一 openai-compatible 线格式：anthropic / ollama 均提供兼容端点，
 * kind 不作为路由条件，只要求启用且 baseUrl/model 已配置。
 *
 * 放在 `lib/` 而非 `stores/chat-llm`：它是纯函数，`lib/local-ai.ts` 等低层模块
 * 也要用 —— 让 lib 反向依赖 store 会成环（见重构计划 P5）。
 */
export function selectLlmProvider(providers: ModelProviderConfig[], preferredId?: string | null): ModelProviderConfig | null {
  const available = providers.filter((provider) => provider.enabled && !!provider.baseUrl?.trim() && !!provider.model.trim());
  return available.find((provider) => provider.id === preferredId) ?? available[0] ?? null;
}
