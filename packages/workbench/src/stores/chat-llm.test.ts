// 聊天 → LLM 路由的纯函数契约：供应商选择与历史整形。
import { describe, expect, it } from "vitest";
import type { ModelProviderConfig } from "@greywork/shell";
import { buildLlmHistory, selectLlmProvider, LLM_SYSTEM_PROMPT } from "./chat-llm";

function provider(overrides: Partial<ModelProviderConfig> = {}): ModelProviderConfig {
  return {
    id: "p1",
    name: "测试供应商",
    kind: "openai-compatible",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-test",
    apiKeyEnv: "TEST_KEY",
    enabled: true,
    ...overrides,
  };
}

describe("selectLlmProvider", () => {
  it("requires enabled + baseUrl + model", () => {
    expect(selectLlmProvider([provider()])?.id).toBe("p1");
    expect(selectLlmProvider([provider({ enabled: false })])).toBeNull();
    expect(selectLlmProvider([provider({ baseUrl: "  " })])).toBeNull();
    expect(selectLlmProvider([provider({ model: "" })])).toBeNull();
    expect(selectLlmProvider([])).toBeNull();
  });

  it("returns the first qualifying provider", () => {
    const picked = selectLlmProvider([
      provider({ id: "off", enabled: false }),
      provider({ id: "first-ok", baseUrl: "http://localhost:11434/v1" }),
      provider({ id: "second-ok" }),
    ]);
    expect(picked?.id).toBe("first-ok");
  });
});

describe("buildLlmHistory", () => {
  it("keeps only non-empty user/assistant messages and prepends system prompt", () => {
    const history = buildLlmHistory([
      { role: "system", content: "不应透传的本地 system" },
      { role: "user", content: "你好" },
      { role: "assistant", content: "" }, // 流式占位
      { role: "tool", content: "杂音" },
      { role: "assistant", content: "答复" },
      { role: "user", content: "继续" },
    ]);
    expect(history[0]).toEqual({ role: "system", content: LLM_SYSTEM_PROMPT });
    expect(history.slice(1)).toEqual([
      { role: "user", content: "你好" },
      { role: "assistant", content: "答复" },
      { role: "user", content: "继续" },
    ]);
  });

  it("caps history to the most recent entries", () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ role: "user", content: `m${index}` }));
    const history = buildLlmHistory(many, 20);
    expect(history).toHaveLength(21); // system + 20
    expect(history[1]?.content).toBe("m10");
    expect(history.at(-1)?.content).toBe("m29");
  });
});
