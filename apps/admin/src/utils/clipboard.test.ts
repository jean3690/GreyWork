import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

describe("copyText", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("成功时返回 true 并清理临时节点", () => {
    const exec = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", { value: exec, configurable: true });

    expect(copyText("GW-CODE")).toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("execCommand 抛错时返回 false，不把异常抛给调用方", () => {
    Object.defineProperty(document, "execCommand", {
      value: vi.fn(() => {
        throw new Error("denied");
      }),
      configurable: true,
    });

    expect(copyText("x")).toBe(false);
    expect(document.querySelector("textarea")).toBeNull();
  });
});
