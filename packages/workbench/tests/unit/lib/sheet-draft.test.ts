/**
 * 表格草稿登记处：切 tab / 切文件区 / 重载都会销毁 viewer，未保存的工作挂在这里，回来接着改。
 *
 * 语义的关键点是 **read 不删除** —— 删不删由「卸载时脏不脏、保存成不成功」决定，
 * 这样「初始化失败」也不会把草稿吃掉。
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { IWorkbookData } from "@univerjs/core";
import { dropSheetDraft, hasSheetDraft, readSheetDraft, stashSheetDraft } from "@/lib/sheet-draft";

function fakeSnapshot(tag: string): IWorkbookData {
  return { id: tag } as IWorkbookData;
}

const draft = (tag: string) => ({
  base: fakeSnapshot(`${tag}-base`),
  current: fakeSnapshot(`${tag}-current`),
  source: new Uint8Array([1, 2, 3]),
});

beforeEach(() => {
  dropSheetDraft("pv-1");
  dropSheetDraft("pv-2");
});

describe("sheet-draft", () => {
  it("stash 后能读回整条记录（基准 / 当前 / 原始字节三件套都要在，差量才算得出来）", () => {
    stashSheetDraft("pv-1", draft("a"));
    const read = readSheetDraft("pv-1");
    expect(read?.base.id).toBe("a-base");
    expect(read?.current.id).toBe("a-current");
    expect(read?.source).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("read 不删除：连续读两次都拿得到（初始化失败时不该把草稿吃掉）", () => {
    stashSheetDraft("pv-1", draft("a"));
    expect(readSheetDraft("pv-1")).not.toBeNull();
    expect(hasSheetDraft("pv-1")).toBe(true);
    expect(readSheetDraft("pv-1")).not.toBeNull();
  });

  it("再次 stash 覆盖旧的（卸载时留下的总是最新状态）", () => {
    stashSheetDraft("pv-1", draft("a"));
    stashSheetDraft("pv-1", draft("b"));
    expect(readSheetDraft("pv-1")?.current.id).toBe("b-current");
  });

  it("drop 之后读不到，也不影响别的 tab", () => {
    stashSheetDraft("pv-1", draft("a"));
    stashSheetDraft("pv-2", draft("b"));
    dropSheetDraft("pv-1");
    expect(hasSheetDraft("pv-1")).toBe(false);
    expect(readSheetDraft("pv-1")).toBeNull();
    expect(readSheetDraft("pv-2")?.current.id).toBe("b-current");
  });

  it("没登记过就回 null，drop 一个不存在的 key 也不报错", () => {
    expect(readSheetDraft("pv-9")).toBeNull();
    expect(() => dropSheetDraft("pv-9")).not.toThrow();
  });
});
