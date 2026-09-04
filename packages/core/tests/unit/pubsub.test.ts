import { describe, expect, it, vi } from "vitest";
import { createEventBus, type PubSub } from "../../src/pubsub";

interface TestEvents {
  "task:done": { id: string };
  "task:progress": { id: string; pct: number };
  "no-payload": unknown;
}

function createBus(): PubSub<TestEvents> {
  return createEventBus<TestEvents>();
}

describe("createEventBus", () => {
  it("on/emit 基本派发，payload 透传", () => {
    const bus = createBus();
    const handler = vi.fn();
    bus.on("task:done", handler);
    bus.emit("task:done", { id: "t-1" });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ id: "t-1" });
  });

  it("on 返回的取消函数解除订阅", () => {
    const bus = createBus();
    const handler = vi.fn();
    const unsubscribe = bus.on("task:done", handler);
    unsubscribe();
    bus.emit("task:done", { id: "t-2" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("once 只触发一次后自动移除", () => {
    const bus = createBus();
    const handler = vi.fn();
    bus.once("task:done", handler);
    bus.emit("task:done", { id: "a" });
    bus.emit("task:done", { id: "b" });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ id: "a" });
  });

  it("off 移除精确订阅，不影响其他订阅者", () => {
    const bus = createBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.on("task:progress", a);
    bus.on("task:progress", b);
    bus.off("task:progress", a);
    bus.emit("task:progress", { id: "p", pct: 50 });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("单个 handler 抛错被隔离，其余继续执行", () => {
    const bus = createBus();
    const broken = vi.fn(() => {
      throw new Error("boom");
    });
    const healthy = vi.fn();
    bus.on("task:done", broken);
    bus.on("task:done", healthy);
    expect(() => bus.emit("task:done", { id: "x" })).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it("无订阅者时 emit 安全", () => {
    const bus = createBus();
    expect(() => bus.emit("no-payload", undefined)).not.toThrow();
  });

  it("listenerCount 统计，clear 清空指定/全部", () => {
    const bus = createBus();
    const handler = vi.fn();
    bus.on("task:done", handler);
    bus.on("task:progress", handler);
    expect(bus.listenerCount("task:done")).toBe(1);
    expect(bus.listenerCount("task:progress")).toBe(1);
    bus.clear("task:done");
    expect(bus.listenerCount("task:done")).toBe(0);
    expect(bus.listenerCount("task:progress")).toBe(1);
    bus.clear();
    expect(bus.listenerCount("task:progress")).toBe(0);
  });

  it("同事件多订阅者按注册顺序调用", () => {
    const bus = createBus();
    const order: string[] = [];
    bus.on("task:done", () => order.push("first"));
    bus.on("task:done", () => order.push("second"));
    bus.emit("task:done", { id: "s" });
    expect(order).toEqual(["first", "second"]);
  });
});
