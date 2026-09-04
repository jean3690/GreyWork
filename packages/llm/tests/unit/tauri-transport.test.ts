// Tauri 传输层：invoke 参数形状（含 reasoningEffort 透传）。
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => h.invoke(cmd, args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
}));

import { TauriLlmTransport } from "../../src/tauri-transport";

describe("TauriLlmTransport", () => {
  it("chat 透传 reasoningEffort 到 llm_chat_start", async () => {
    h.invoke.mockResolvedValue(7);
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    const transport = new TauriLlmTransport();
    const id = await transport.chat({
      baseUrl: "https://api.example.com",
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
      reasoningEffort: "high",
    });
    expect(id).toBe(7);
    expect(h.invoke).toHaveBeenCalledWith("llm_chat_start", {
      baseUrl: "https://api.example.com",
      model: "gpt-test",
      apiKeyEnv: "",
      messages: [{ role: "user", content: "hi" }],
      reasoningEffort: "high",
    });
    vi.unstubAllGlobals();
  });

  it("reasoningEffort 缺省时传空字符串（宿主按 auto 处理）", async () => {
    h.invoke.mockResolvedValue(1);
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    const transport = new TauriLlmTransport();
    await transport.chat({ baseUrl: "https://x", model: "m", messages: [] });
    expect(h.invoke).toHaveBeenCalledWith("llm_chat_start", {
      baseUrl: "https://x",
      model: "m",
      apiKeyEnv: "",
      messages: [],
      reasoningEffort: "",
    });
    vi.unstubAllGlobals();
  });
});
