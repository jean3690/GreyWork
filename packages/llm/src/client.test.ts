// 契约：非 Tauri 运行时下 LLM 直连不可用，chat 拒绝而非静默降级。
import { describe, expect, it } from "vitest";
import { createLlmClient, LlmUnavailableError } from "./client";

describe("createLlmClient outside Tauri runtime", () => {
  it("reports unavailability and rejects chat with LlmUnavailableError", async () => {
    const client = createLlmClient();
    if (client.isAvailable()) {
      // 在桌面运行时里跑测试时跳过 web 分支断言
      return;
    }
    await expect(client.chat({ baseUrl: "https://api.example.com", model: "gpt-test", messages: [] })).rejects.toBeInstanceOf(
      LlmUnavailableError,
    );
  });
});

describe("createLlmClient desktop-path seams", () => {
  it("stop 在非桌面运行时拒绝（invoke 无宿主）", async () => {
    const client = createLlmClient();
    if (client.isAvailable()) return;
    await expect(client.stop(1)).rejects.toThrow();
  });
  it("onEvent 在非桌面运行时拒绝（无事件宿主）", () => {
    const client = createLlmClient();
    if (client.isAvailable()) return Promise.resolve();
    return expect(client.onEvent(() => undefined)).rejects.toThrow();
  });
});
