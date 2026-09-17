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
      // 附加请求头随请求上行；未配置时传空对象 = 不加头
      headers: {},
      // 轮次令牌随请求上行，宿主原样回灌进每条事件（消费方据此过滤并行的流）
      clientToken: "",
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
      headers: {},
      clientToken: "",
    });
    vi.unstubAllGlobals();
  });

  it("自定义请求头原样上行（{{ENV}} 占位由宿主解析）", async () => {
    h.invoke.mockResolvedValue(3);
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    const transport = new TauriLlmTransport();
    await transport.chat({
      baseUrl: "https://x",
      model: "m",
      messages: [],
      headers: { "X-Tenant": "acme", Authorization: "Bearer {{OPENAI_KEY}}" },
    });
    expect(h.invoke).toHaveBeenCalledWith(
      "llm_chat_start",
      expect.objectContaining({ headers: { "X-Tenant": "acme", Authorization: "Bearer {{OPENAI_KEY}}" } }),
    );
    vi.unstubAllGlobals();
  });

  it("clientToken 原样上行（并行流靠它分流）", async () => {
    h.invoke.mockResolvedValue(2);
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    const transport = new TauriLlmTransport();
    await transport.chat({ baseUrl: "https://x", model: "m", messages: [], clientToken: "turn-1" });
    expect(h.invoke).toHaveBeenCalledWith("llm_chat_start", expect.objectContaining({ clientToken: "turn-1" }));
    vi.unstubAllGlobals();
  });
});
