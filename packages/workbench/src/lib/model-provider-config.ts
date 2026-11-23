import { isJavaModelGateway } from "./java-model-gateway";

/** 与宿主 buildChatBody 的保留字段一致：扩展参数不应接管 agent 的控制流。 */
const RESERVED_BODY_KEYS = ["model", "messages", "tools", "tool_choice", "stream", "functions", "function_call", "n"];

export function parseModelExtraBody(text: string): { value?: Record<string, unknown>; error?: string } {
  if (!text.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: "自定义请求参数不是合法 JSON" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "自定义请求参数必须是 JSON 对象" };
  for (const key of RESERVED_BODY_KEYS) {
    if (Object.hasOwn(value, key)) return { error: `自定义请求参数不能覆盖 ${key}` };
  }
  return { value: value as Record<string, unknown> };
}

export function validateModelConnection(baseUrl: string, model: string): string | null {
  if (isJavaModelGateway(baseUrl)) return model.trim() ? null : "请填写模型 ID";
  if (!baseUrl.trim()) return "请填写 Base URL";
  try {
    const url = new URL(baseUrl.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
      return "Base URL 必须是 HTTP(S) 地址，且不能包含账号密码或片段";
  } catch {
    return "Base URL 不是有效的 HTTP(S) 地址";
  }
  if (!model.trim()) return "请填写模型 ID（不要求服务支持 /models，可手动填写）";
  return null;
}
