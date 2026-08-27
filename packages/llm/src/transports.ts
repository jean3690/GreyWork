/** LLM 直连传输抽象：desktop 走 Tauri IPC（Rust 宿主 reqwest），web 无直连通道。 */

export interface LlmEventEnvelope {
  kind: "llm-delta" | "llm-done" | "llm-error";
  payload: { delta?: string; message?: string };
}

/** 对话消息（与 Rust 侧 LlmChatMessage 对应）。 */
export interface LlmChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmChatParams {
  baseUrl: string;
  model: string;
  /** 密钥所在环境变量名；宿主侧解析，密钥不经过渲染端 */
  apiKeyEnv?: string;
  messages: LlmChatMessage[];
}

export interface LlmClient {
  isAvailable(): boolean;
  chat(params: LlmChatParams): Promise<number>;
  stop(requestId: number): Promise<void>;
  onEvent(listener: (event: LlmEventEnvelope) => void): Promise<() => void>;
}

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
