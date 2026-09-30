import { TauriLlmTransport } from "./tauri-transport";
import type { LlmClient } from "./transports";

export class LlmUnavailableError extends Error {
  constructor() {
    super("LLM direct calls require the desktop runtime (Tauri host); web has no CORS-free channel");
    this.name = "LlmUnavailableError";
  }
}

/** 统一 client 面：按运行环境选择传输（desktop→Tauri IPC；web→不可用）。 */
export function createLlmClient(): LlmClient {
  const transport = new TauriLlmTransport();
  const unavailable = (): Promise<never> => Promise.reject(new LlmUnavailableError());
  const gate = <T>(run: () => Promise<T>): Promise<T> => (transport.isAvailable() ? run() : unavailable());
  return {
    isAvailable: () => transport.isAvailable(),
    chat: (params) => gate(() => transport.chat(params)),
    stop: (requestId) => transport.stop(requestId),
    onEvent: (listener) => transport.onEvent(listener),
    listModels: (connection) => gate(() => transport.listModels(connection)),
    embed: (params) => gate(() => transport.embed(params)),
    transcribe: (params) => gate(() => transport.transcribe(params)),
  };
}

export type {
  LlmChatMessage,
  LlmChatParams,
  LlmClient,
  LlmConnection,
  LlmContentPart,
  LlmEmbedParams,
  LlmEmbedResult,
  LlmEventEnvelope,
  LlmTranscribeParams,
  LlmTranscribeResult,
} from "./transports";
export { isTauriRuntime } from "./transports";
