// 契约：非 Tauri 运行时下 LLM 直连不可用，chat 拒绝而非静默降级。
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ available: false }));

vi.mock("@greywork/host-ipc", () => ({
  // 运行时门控的唯一依据；默认置 false 以稳定命中「无宿主」分支。
  hasHostCommands: () => h.available,
  // 无宿主时 invoke / listen 抛错（browser-preview 下的真实行为）。注意 stop / stopAgent /
  // onEvent 在 client 层**没有** gate，它们靠这里抛错 —— 所以这个桩必须真的会失败。
  invoke: (cmd: string, args?: unknown) => (h.available ? Promise.resolve({ cmd, args }) : Promise.reject(new Error("no host"))),
  listen: vi.fn(() => (h.available ? Promise.resolve(() => undefined) : Promise.reject(new Error("no host")))),
}));

import { createLlmClient, LlmUnavailableError } from "../../src/client";

describe("createLlmClient outside Tauri runtime", () => {
  beforeEach(() => {
    h.available = false;
  });

  it("reports unavailability and rejects chat with LlmUnavailableError", async () => {
    const client = createLlmClient();
    expect(client.isAvailable()).toBe(false);
    await expect(client.chat({ baseUrl: "https://api.example.com", model: "gpt-test", messages: [] })).rejects.toBeInstanceOf(
      LlmUnavailableError,
    );
  });

  // agent 回合与 chat 走同一套门控：没有宿主就没有授权面，工具无从执行，
  // 所以必须同样显式拒绝，而不是「看起来在跑但永远不出结果」。
  it("agent 回合在无宿主时同样拒绝（工具需要宿主的授权面）", async () => {
    const client = createLlmClient();
    await expect(client.agentRun({ baseUrl: "http://localhost:11434", model: "qwen", messages: [] })).rejects.toBeInstanceOf(
      LlmUnavailableError,
    );
  });

  it("stop / stopAgent 在无宿主时都拒绝", async () => {
    const client = createLlmClient();
    await expect(client.stop(1)).rejects.toThrow();
    await expect(client.stopAgent(1)).rejects.toThrow();
  });

  it("有宿主时 gate 放行（不误伤服务端态）", () => {
    h.available = true;
    expect(createLlmClient().isAvailable()).toBe(true);
  });
});

describe("createLlmClient desktop-path seams", () => {
  beforeEach(() => {
    h.available = false;
  });

  it("onEvent 在非桌面运行时拒绝（无事件宿主）", async () => {
    const client = createLlmClient();
    await expect(client.onEvent(() => undefined)).rejects.toThrow();
  });

  it("listModels / embed / transcribe 在非桌面运行时拒绝（本地 AI 也要宿主）", async () => {
    const client = createLlmClient();
    await expect(client.listModels({ baseUrl: "http://localhost:11434" })).rejects.toBeInstanceOf(LlmUnavailableError);
    await expect(client.embed({ baseUrl: "http://localhost:11434", model: "bge-m3", input: ["x"] })).rejects.toBeInstanceOf(
      LlmUnavailableError,
    );
    await expect(client.transcribe({ baseUrl: "http://localhost:9000", model: "whisper-1", path: "/a/voice.wav" })).rejects.toBeInstanceOf(
      LlmUnavailableError,
    );
  });
});
