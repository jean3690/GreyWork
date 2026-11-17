import { describe, expect, it } from "vitest";
import { parseModelExtraBody, validateModelConnection } from "../../../src/lib/model-provider-config";

describe("第三方模型配置校验", () => {
  it("支持网关扩展参数和 null 移除字段", () => {
    expect(parseModelExtraBody('{"max_completion_tokens":8192,"temperature":null}').value).toEqual({
      max_completion_tokens: 8192,
      temperature: null,
    });
    expect(parseModelExtraBody("")).toEqual({});
  });
  it("拒绝非法 JSON、非对象和 agent 控制字段覆盖", () => {
    for (const text of ["{", "null", "[]", "2", '{"messages":[]}', '{"tool_choice":"none"}', '{"stream":false}'])
      expect(parseModelExtraBody(text).error).toBeTruthy();
  });
  it("手动模型 ID + 自定义网关路径有效，无需 /models", () => {
    expect(validateModelConnection("https://gateway.example/custom/api", "third-party/model")).toBeNull();
    expect(validateModelConnection("http://localhost:11434", "qwen3")).toBeNull();
    for (const url of ["", "nope", "file:///tmp", "https://user:password@example.com"])
      expect(validateModelConnection(url, "m")).toBeTruthy();
    expect(validateModelConnection("https://gateway.example", "")).toContain("模型 ID");
  });
});
