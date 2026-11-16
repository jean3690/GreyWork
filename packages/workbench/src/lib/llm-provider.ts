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

/**
 * Agent 回合的供应商链：主供应商 + 其它「同样开了 Agent 模式」的启用项。
 *
 * 只把 agentMode=true 的作为回退：工具调用是端点/模型能力，没开这一项的端点
 * 大概率不支持 tools，切过去只会拿 400 再挂一次（400 本身不触发回退）。
 */
export function buildAgentProviderChain(providers: ModelProviderConfig[], selectedId?: string | null): ModelProviderConfig[] {
  const available = providers.filter((provider) => provider.enabled && !!provider.baseUrl?.trim() && !!provider.model.trim());
  const primary = available.find((provider) => provider.id === selectedId) ?? available[0];
  if (!primary) return [];
  const backups = available.filter((provider) => provider.id !== primary.id && provider.agentMode === true);
  return [primary, ...backups];
}
