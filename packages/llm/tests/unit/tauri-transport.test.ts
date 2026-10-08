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
      // 采样参数缺省不传（宿主仅在显式给值时写进请求体）
      temperature: null,
      maxTokens: null,
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
      temperature: null,
      maxTokens: null,
      clientToken: "",
    });
    vi.unstubAllGlobals();
  });

  it("采样参数显式设置时原样上行", async () => {
    h.invoke.mockResolvedValue(5);
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    const transport = new TauriLlmTransport();
    await transport.chat({ baseUrl: "https://x", model: "m", messages: [], temperature: 0.2, maxTokens: 512 });
    expect(h.invoke).toHaveBeenCalledWith("llm_chat_start", expect.objectContaining({ temperature: 0.2, maxTokens: 512 }));
    vi.unstubAllGlobals();
  });

  it("listModels / embed / transcribe 打到对应宿主命令", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    const transport = new TauriLlmTransport();

    h.invoke.mockResolvedValueOnce(["m1", "m2"]);
    await expect(transport.listModels({ baseUrl: "http://localhost:11434" })).resolves.toEqual(["m1", "m2"]);
    expect(h.invoke).toHaveBeenCalledWith("llm_list_models", {
      baseUrl: "http://localhost:11434",
      apiKeyEnv: "",
      headers: {},
    });

    h.invoke.mockResolvedValueOnce({ embeddings: [[1, 2]], dim: 2, model: "bge" });
    await transport.embed({ baseUrl: "http://localhost:11434", model: "bge", input: ["x"] });
    expect(h.invoke).toHaveBeenCalledWith("llm_embed", {
      baseUrl: "http://localhost:11434",
      model: "bge",
      apiKeyEnv: "",
      headers: {},
      input: ["x"],
    });

    h.invoke.mockResolvedValueOnce({ text: "你好" });
    await transport.transcribe({ baseUrl: "http://localhost:9000", model: "whisper-1", path: "/a/voice.wav" });
    expect(h.invoke).toHaveBeenCalledWith("llm_transcribe", {
      baseUrl: "http://localhost:9000",
      model: "whisper-1",
      apiKeyEnv: "",
      headers: {},
      path: "/a/voice.wav",
      language: null,
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

  it("agentRun 打到 llm_agent_start，参数形状与 chat 一致外加 maxRounds", async () => {
    h.invoke.mockResolvedValue(9);
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    const transport = new TauriLlmTransport();
    const id = await transport.agentRun({
      baseUrl: "http://localhost:11434",
      model: "qwen2.5",
      messages: [{ role: "user", content: "看看 src" }],
      clientToken: "turn-a",
      maxRounds: 8,
    });
    expect(id).toBe(9);
    expect(h.invoke).toHaveBeenCalledWith("llm_agent_start", {
      baseUrl: "http://localhost:11434",
      model: "qwen2.5",
      apiKeyEnv: "",
      messages: [{ role: "user", content: "看看 src" }],
      reasoningEffort: "",
      headers: {},
      temperature: null,
      maxTokens: null,
      maxRounds: 8,
      clientToken: "turn-a",
    });
    vi.unstubAllGlobals();
  });

  it("agentRun 缺省 maxRounds 传 null（宿主取自己的默认值并硬夹上限）", async () => {
    h.invoke.mockResolvedValue(1);
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    const transport = new TauriLlmTransport();
    await transport.agentRun({ baseUrl: "http://x", model: "m", messages: [] });
    expect(h.invoke).toHaveBeenCalledWith("llm_agent_start", expect.objectContaining({ maxRounds: null }));
    vi.unstubAllGlobals();
  });

  it("stopAgent 打到 llm_agent_stop（与 stop 是不同的宿主句柄表）", async () => {
    h.invoke.mockResolvedValue(undefined);
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    const transport = new TauriLlmTransport();
    await transport.stopAgent(9);
    expect(h.invoke).toHaveBeenCalledWith("llm_agent_stop", { requestId: 9 });
    vi.unstubAllGlobals();
  });
});
