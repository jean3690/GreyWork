/**
 * 会话状态派生：优先级是这块唯一的契约，且容易搞反 ——
 * waiting 必须压过 running（等待权限确认时回合仍在跑），否则「等待中」永远不可达。
 */
import { describe, expect, it } from "vitest";
import { sessionStatus } from "@/lib/session-status";

describe("sessionStatus", () => {
  it("waiting 优先于 running（权限确认发生在回合进行中）", () => {
    expect(sessionStatus({ hasMessages: true, running: true, waiting: true })).toBe("waiting");
  });

  it("running 优先于 done", () => {
    expect(sessionStatus({ hasMessages: true, running: true, waiting: false })).toBe("running");
  });

  it("有消息且已结算 = done", () => {
    expect(sessionStatus({ hasMessages: true, running: false, waiting: false })).toBe("done");
  });

  it("没有消息且空闲 = idle（未开始）", () => {
    expect(sessionStatus({ hasMessages: false, running: false, waiting: false })).toBe("idle");
  });

  it("还没有消息但在跑 = running", () => {
    expect(sessionStatus({ hasMessages: false, running: true, waiting: false })).toBe("running");
  });
});
