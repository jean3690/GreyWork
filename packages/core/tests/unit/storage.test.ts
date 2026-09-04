import { beforeEach, describe, expect, it, vi } from "vitest";
import { createJsonStorage } from "../../src/storage";

const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => storage.clear(),
});

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

beforeEach(() => {
  storage.clear();
});

describe("createJsonStorage", () => {
  it("write 后 read 往返一致", () => {
    const json = createJsonStorage("k", isStringArray);
    json.write(["a", "b"]);
    expect(json.read()).toEqual(["a", "b"]);
  });

  it("无值返回 null", () => {
    const json = createJsonStorage("k", isStringArray);
    expect(json.read()).toBeNull();
  });

  it("JSON 损坏返回 null（不抛异常）", () => {
    storage.set("k", "{not-json");
    const json = createJsonStorage("k", isStringArray);
    expect(json.read()).toBeNull();
  });

  it("类型校验失败返回 null（结构不符视为损坏）", () => {
    storage.set("k", JSON.stringify("nope"));
    const json = createJsonStorage("k", isStringArray);
    expect(json.read()).toBeNull();
  });
});
