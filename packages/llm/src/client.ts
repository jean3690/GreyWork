import { TauriLlmTransport } from "./tauri-transport";
import type { LlmChatMessage, LlmChatParams, LlmClient, LlmEventEnvelope } from "./transports";

export class LlmUnavailableError extends Error {
  constructor() {
    super("LLM direct calls require the desktop runtime (Tauri host); web has no CORS-free channel");
    this.name = "LlmUnavailableError";
  }
}

/** 统一 client 面：按运行环境选择传输（desktop→Tauri IPC；web→不可用）。 */
export function createLlmClient(): LlmClient {
  const transport = new TauriLlmTransport();
  return {
    isAvailable: () => transport.isAvailable(),
    chat: (params) => {
      if (!transport.isAvailable()) return Promise.reject(new LlmUnavailableError());
      return transport.chat(params);
    },
    stop: (requestId) => transport.stop(requestId),
    onEvent: (listener) => transport.onEvent(listener),
  };
}

export type { LlmChatMessage, LlmChatParams, LlmClient, LlmEventEnvelope };
export { isTauriRuntime } from "./transports";
