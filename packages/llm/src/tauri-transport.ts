import { hasHostCommands, invoke, listen, type UnlistenFn } from "@greywork/host-ipc";
import type {
  LlmChatParams,
  LlmClient,
  LlmConnection,
  LlmEmbedParams,
  LlmEmbedResult,
  LlmEventEnvelope,
  LlmTranscribeParams,
  LlmTranscribeResult,
} from "./transports";

const EVENT_NAME = "llm://event";

/** 宿主传输：经 @greywork/host-ipc 门面调用 Rust LLM 宿主（llm.rs，密钥宿主侧解析）——桌面走 Tauri IPC，服务端走 HTTP。 */
export class TauriLlmTransport implements LlmClient {
  readonly available = true;

  isAvailable(): boolean {
    return hasHostCommands();
  }

  async chat(params: LlmChatParams): Promise<number> {
    return invoke<number>("llm_chat_start", {
      baseUrl: params.baseUrl,
      model: params.model,
      apiKeyEnv: params.apiKeyEnv ?? "",
      messages: params.messages,
      reasoningEffort: params.reasoningEffort ?? "",
      headers: params.headers ?? {},
      temperature: params.temperature ?? null,
      maxTokens: params.maxTokens ?? null,
      clientToken: params.clientToken ?? "",
    });
  }

  async stop(requestId: number): Promise<void> {
    await invoke("llm_chat_stop", { requestId });
  }

  async onEvent(listener: (event: LlmEventEnvelope) => void): Promise<() => void> {
    const unlisten: UnlistenFn = await listen<LlmEventEnvelope>(EVENT_NAME, (event) => {
      listener(event.payload);
    });
    return () => unlisten();
  }

  async listModels(connection: LlmConnection): Promise<string[]> {
    return invoke<string[]>("llm_list_models", {
      baseUrl: connection.baseUrl,
      apiKeyEnv: connection.apiKeyEnv ?? "",
      headers: connection.headers ?? {},
    });
  }

  async embed(params: LlmEmbedParams): Promise<LlmEmbedResult> {
    return invoke<LlmEmbedResult>("llm_embed", {
      baseUrl: params.baseUrl,
      model: params.model,
      apiKeyEnv: params.apiKeyEnv ?? "",
      headers: params.headers ?? {},
      input: params.input,
    });
  }

  async transcribe(params: LlmTranscribeParams): Promise<LlmTranscribeResult> {
    return invoke<LlmTranscribeResult>("llm_transcribe", {
      baseUrl: params.baseUrl,
      model: params.model,
      apiKeyEnv: params.apiKeyEnv ?? "",
      headers: params.headers ?? {},
      path: params.path,
      language: params.language ?? null,
    });
  }
}
