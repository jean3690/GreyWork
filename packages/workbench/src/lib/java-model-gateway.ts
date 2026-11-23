/** 与宿主 model-gateway.ts 的逻辑连接契约一致；这里从不持有账号 token。 */
export const JAVA_GATEWAY_PREFIX = "greywork://java/";
export const JAVA_GATEWAY_PROVIDERS = ["openai", "anthropic", "deepseek", "moonshot", "qwen", "zhipu", "ollama", "custom"] as const;
export function isJavaModelGateway(baseUrl?: string): boolean {
  return !!baseUrl && JAVA_GATEWAY_PROVIDERS.some((provider) => baseUrl.trim() === JAVA_GATEWAY_PREFIX + provider);
}
