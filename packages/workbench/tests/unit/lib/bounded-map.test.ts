/**
 * 有界 LRU：容量淘汰、命中刷新顺序、onEvict 在三种移除路径上都要触发。
 *
 * 最后一条是给 blob URL 用的：`clear()` 若不回调释放，清空缓存就成了泄漏源。
 */
import { describe, expect, it, vi } from "vitest";
import { createBoundedMap } from "@/lib/bounded-map";

describe("createBoundedMap", () => {
  it("超过上限丢最久未用的条目", () => {
    const map = createBoundedMap<string, number>(3);
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);
    map.set("d", 4);
    expect(map.size).toBe(3);
    expect(map.has("a")).toBe(false);
    expect(map.get("b")).toBe(2);
    expect(map.get("d")).toBe(4);
  });

  it("get 命中刷新顺序：被读过的不先被淘汰", () => {
    const map = createBoundedMap<string, number>(3);
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);
    // a 被读一次 → 变成最近使用，最久未用的应是 b
    expect(map.get("a")).toBe(1);
    map.set("d", 4);
    expect(map.has("a")).toBe(true);
    expect(map.has("b")).toBe(false);
  });

  it("覆盖已有 key 也算一次使用", () => {
    const map = createBoundedMap<string, number>(3);
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);
    map.set("a", 10);
    map.set("d", 4);
    expect(map.get("a")).toBe(10);
    expect(map.has("b")).toBe(false);
  });

  it("onEvict 在容量淘汰 / delete / clear 上都触发", () => {
    const evicted = vi.fn();
    const map = createBoundedMap<string, string>(2, (value, key) => evicted(value, key));

    map.set("a", "A");
    map.set("b", "B");
    map.set("c", "C"); // 淘汰 a
    expect(evicted).toHaveBeenCalledWith("A", "a");

    map.delete("b");
    expect(evicted).toHaveBeenCalledWith("B", "b");

    map.clear();
    expect(evicted).toHaveBeenCalledWith("C", "c");
    expect(map.size).toBe(0);
  });

  it("clear 后再读为空，且不会重复回调", () => {
    const evicted = vi.fn();
    const map = createBoundedMap<string, string>(4, evicted);
    map.set("a", "A");
    map.clear();
    expect(map.get("a")).toBeUndefined();
    expect(map.size).toBe(0);
    expect(evicted).toHaveBeenCalledTimes(1);
  });

  it("delete 不存在的 key 返回 false 且不回调", () => {
    const evicted = vi.fn();
    const map = createBoundedMap<string, string>(4, evicted);
    expect(map.delete("missing")).toBe(false);
    expect(evicted).not.toHaveBeenCalled();
  });
});
