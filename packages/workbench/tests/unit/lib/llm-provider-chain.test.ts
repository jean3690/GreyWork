/**
 * Agent 回合的供应商链：主供应商 + 其它「已开启 Agent 模式」的启用项。
 *
 * 回退只在 agentMode 之间发生：没开这一项的端点大概率不支持 tools，
 * 切过去只会拿 400（而 400 本身不触发回退）。
 */
import { describe, expect, it } from "vitest";

import { buildAgentProviderChain } from "@/lib/llm-provider";
import type { ModelProviderConfig } from "@greywork/shell";

function provider(patch: Partial<ModelProviderConfig> & { id: string }): ModelProviderConfig {
  return {
    name: patch.id,
    kind: "openai-compatible",
    baseUrl: "https://example.test/v1",
    model: "m",
    enabled: true,
    ...patch,
  } as ModelProviderConfig;
}

describe("buildAgentProviderChain", () => {
  it("选中的排第一，之后是其它开了 Agent 模式的启用项", () => {
    const chain = buildAgentProviderChain(
      [provider({ id: "a", agentMode: true }), provider({ id: "b", agentMode: true }), provider({ id: "c" })],
      "b",
    );
    expect(chain.map((item) => item.id)).toEqual(["b", "a"]);
  });

  it("没开 Agent 模式 / 未启用 / 没有 baseUrl 的都不进链", () => {
    const chain = buildAgentProviderChain(
      [
        provider({ id: "main", agentMode: true }),
        provider({ id: "no-agent" }),
        provider({ id: "disabled", agentMode: true, enabled: false }),
        provider({ id: "no-url", agentMode: true, baseUrl: "" }),
      ],
      "main",
    );
    expect(chain.map((item) => item.id)).toEqual(["main"]);
  });

  it("选中的不存在时退到第一个可用项", () => {
    const chain = buildAgentProviderChain([provider({ id: "only", agentMode: true })], "missing");
    expect(chain.map((item) => item.id)).toEqual(["only"]);
  });

  it("一个可用的都没有时返回空数组（调用方自行兜底）", () => {
    expect(buildAgentProviderChain([provider({ id: "x", enabled: false })], null)).toEqual([]);
  });
});
