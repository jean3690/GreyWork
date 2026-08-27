import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauriRuntime, type LlmChatParams, type LlmClient, type LlmEventEnvelope } from "./transports";

const EVENT_NAME = "llm://event";

/** 桌面端传输：经 Tauri IPC 调用 Rust LLM 宿主（llm.rs，密钥宿主侧解析）。 */
export class TauriLlmTransport implements LlmClient {
  readonly available = true;

  isAvailable(): boolean {
    return isTauriRuntime();
  }

  async chat(params: LlmChatParams): Promise<number> {
    return invoke<number>("llm_chat_start", {
      baseUrl: params.baseUrl,
      model: params.model,
      apiKeyEnv: params.apiKeyEnv ?? "",
      messages: params.messages,
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
}
