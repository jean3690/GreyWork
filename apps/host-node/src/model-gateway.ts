/** 逻辑连接标识，不是可请求的 URL；账号地址/token 仅由控制面运行时解析。 */
export const JAVA_GATEWAY_PREFIX = "greywork://java/";
const PROVIDERS = new Set(["openai", "anthropic", "deepseek", "moonshot", "qwen", "zhipu", "ollama", "custom"]);

export function javaGatewayProvider(baseUrl: string): string | null {
  const value = baseUrl.trim();
  if (!value.startsWith(JAVA_GATEWAY_PREFIX)) return null;
  const provider = value.slice(JAVA_GATEWAY_PREFIX.length);
  if (!PROVIDERS.has(provider)) throw new Error("无效的 Java 模型供应商");
  return provider;
}

/** 一轮操作固定账号；close 释放并取消连接，换号后 request 必须拒绝继续。 */
export interface ModelGatewaySession {
  readonly signal: AbortSignal;
  request(provider: string, body: Record<string, unknown> | null, signal: AbortSignal): Promise<Response>;
  close(): void;
}
export type ModelGatewayFactory = () => ModelGatewaySession;
