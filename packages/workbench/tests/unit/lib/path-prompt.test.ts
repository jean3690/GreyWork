/**
 * 手输路径弹层的请求/收口语义（lib/path-prompt）。
 *
 * 关键契约：每次 requestPathInput 都**必须**有结局 —— 重入时前一个按取消收口，
 * 否则调用方的 await 永远悬着，「添加工作区」就还是「点了没反应」。
 */
import { describe, expect, it } from "vitest";
import { pathPromptOpen, requestPathInput, settlePathInput } from "@/lib/path-prompt";

describe("path-prompt", () => {
  it("请求打开弹层，收口后带值返回并收起", async () => {
    const pending = requestPathInput();
    expect(pathPromptOpen.value).toBe(true);

    settlePathInput("/srv/data/project");
    await expect(pending).resolves.toBe("/srv/data/project");
    expect(pathPromptOpen.value).toBe(false);
  });

  it("取消返回 null", async () => {
    const pending = requestPathInput();
    settlePathInput(null);
    await expect(pending).resolves.toBeNull();
    expect(pathPromptOpen.value).toBe(false);
  });

  it("重入：前一个请求按取消收口，不会永久悬着", async () => {
    const first = requestPathInput();
    const second = requestPathInput();

    await expect(first).resolves.toBeNull();
    expect(pathPromptOpen.value).toBe(true);

    settlePathInput("/srv/b");
    await expect(second).resolves.toBe("/srv/b");
    expect(pathPromptOpen.value).toBe(false);
  });

  it("没有待答请求时收口是空操作", () => {
    expect(() => settlePathInput("/nowhere")).not.toThrow();
    expect(pathPromptOpen.value).toBe(false);
  });
});
