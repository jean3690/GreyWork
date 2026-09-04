// 网页搜索供应商选择契约（纯函数；Tauri 传输在 node 测试环境不可用）。
import { describe, expect, it } from "vitest";
import type { WebSearchProviderConfig } from "../../src/types";
import { selectWebSearchProvider } from "../../src/search";

function provider(overrides: Partial<WebSearchProviderConfig> = {}): WebSearchProviderConfig {
  return {
    id: "tavily",
    name: "Tavily",
    endpoint: "https://api.tavily.com/search",
    apiKeyEnv: "TAVILY_API_KEY",
    enabled: true,
    ...overrides,
  };
}

describe("selectWebSearchProvider", () => {
  it("requires enabled + endpoint", () => {
    expect(selectWebSearchProvider([provider()])?.id).toBe("tavily");
    expect(selectWebSearchProvider([provider({ enabled: false })])).toBeNull();
    expect(selectWebSearchProvider([provider({ endpoint: "" })])).toBeNull();
    expect(selectWebSearchProvider([provider({ endpoint: undefined })])).toBeNull();
    expect(selectWebSearchProvider([])).toBeNull();
  });

  it("returns the first qualifying provider", () => {
    const picked = selectWebSearchProvider([
      provider({ id: "off", enabled: false }),
      provider({ id: "brave-first", name: "Brave" }),
      provider({ id: "second" }),
    ]);
    expect(picked?.id).toBe("brave-first");
  });
});
