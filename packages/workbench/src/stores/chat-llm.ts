import type { ModelProviderConfig } from "@greywork/shell";
import type { LlmChatMessage } from "@greywork/llm";

/** Phase 1 统一 openai-compatible 线格式：anthropic / ollama 均提供兼容端点，
 * kind 不作为路由条件，只要求启用且 baseUrl/model 已配置。 */
export function selectLlmProvider(providers: ModelProviderConfig[], preferredId?: string | null): ModelProviderConfig | null {
  const available = providers.filter((provider) => provider.enabled && !!provider.baseUrl?.trim() && !!provider.model.trim());
  return available.find((provider) => provider.id === preferredId) ?? available[0] ?? null;
}

export const LLM_SYSTEM_PROMPT = "你是 GreyWork 智能工作台中的助手。回答简洁准确；涉及数据或文件操作时，先给出简短计划再执行说明。";

interface HistorySource {
  role: string;
  content: string;
}

/** 历史上下文整形：仅保留 user/assistant 非空消息，截取最近 cap 条，前置系统提示。
 * 空 content 的 assistant 占位消息（流式开始前）天然被过滤。 */
export function buildLlmHistory(messages: HistorySource[], cap = 20): LlmChatMessage[] {
  const history = messages
    .filter((message) => (message.role === "user" || message.role === "assistant") && message.content.trim().length > 0)
    .slice(-cap)
    .map((message) => ({ role: message.role as "user" | "assistant", content: message.content }));
  return [{ role: "system", content: LLM_SYSTEM_PROMPT }, ...history];
}
