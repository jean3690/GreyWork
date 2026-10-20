import { HostLlmTransport } from "./host-transport";
import type { LlmClient } from "./transports";

export class LlmUnavailableError extends Error {
  constructor() {
    super("LLM direct calls require a host (Electron shell / self-hosted server); browser preview has none");
    this.name = "LlmUnavailableError";
  }
}

/** 统一 client 面：宿主托管走宿主命令；浏览器预览不可用。 */
export function createLlmClient(): LlmClient {
  const transport = new HostLlmTransport();
  const unavailable = (): Promise<never> => Promise.reject(new LlmUnavailableError());
  const gate = <T>(run: () => Promise<T>): Promise<T> => (transport.isAvailable() ? run() : unavailable());
  return {
    isAvailable: () => transport.isAvailable(),
    chat: (params) => gate(() => transport.chat(params)),
    stop: (requestId) => transport.stop(requestId),
    agentRun: (params) => gate(() => transport.agentRun(params)),
    stopAgent: (requestId) => transport.stopAgent(requestId),
    onEvent: (listener) => transport.onEvent(listener),
    listModels: (connection) => gate(() => transport.listModels(connection)),
    embed: (params) => gate(() => transport.embed(params)),
    transcribe: (params) => gate(() => transport.transcribe(params)),
  };
}

export type {
  LlmAgentParams,
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
