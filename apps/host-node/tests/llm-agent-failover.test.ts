/**
 * 供应商回退的判定：只对「换一家可能就好」的失败切换。
 * 400 通常是 payload 与端点能力不匹配（例如不支持 tool calling），换一家会用同样的 body 再撞一次。
 */
import { describe, expect, it } from "vitest";

import { canFailover } from "../src/llm-agent.js";

describe("canFailover", () => {
  it("网络错误与限流/鉴权/5xx 可切换", () => {
    for (const status of [0, 401, 403, 408, 425, 429, 500, 502, 503, 504]) {
      expect(canFailover(status)).toBe(true);
    }
  });

  it("400 与其它 4xx 不切换", () => {
    for (const status of [400, 404, 409, 413, 422]) {
      expect(canFailover(status)).toBe(false);
    }
  });
});
