/**
 * CSV 解析：预览把 CSV 铺成表格，解析错一格就是「看起来对但其实错位」——
 * 引号、字段内逗号/换行、CRLF 这几条必须有用例。
 */
import { describe, expect, it } from "vitest";
import { parseCsv, splitHeader } from "@/lib/csv";

describe("parseCsv", () => {
  it("基本切分（LF 行尾）", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("CRLF 与 LF 混用都按行尾处理，\\r 不留进字段值", () => {
    expect(parseCsv("a,b\r\n1,2\n3,4")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("双引号包裹的字段内逗号不切分", () => {
    expect(parseCsv('name,note\n"北京站, 西","主站"')).toEqual([
      ["name", "note"],
      ["北京站, 西", "主站"],
    ]);
  });

  it("字段内换行被保留在同一格里", () => {
    expect(parseCsv('a\n"line1\nline2"')).toEqual([["a"], ["line1\nline2"]]);
  });

  it('"" 是转义的引号，不是字段结束', () => {
    expect(parseCsv('a\n"say ""hi"""')).toEqual([["a"], ['say "hi"']]);
  });

  it("末尾换行不产生多余空行", () => {
    expect(parseCsv("a,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("中间空行保留为单个空字段的行（数据里的空行是信息）", () => {
    expect(parseCsv("a\n\nb")).toEqual([["a"], [""], ["b"]]);
  });

  it("单列与空输入", () => {
    expect(parseCsv("only")).toEqual([["only"]]);
    expect(parseCsv("")).toEqual([]);
  });
});

describe("splitHeader", () => {
  it("首行当表头，其余为 body", () => {
    expect(
      splitHeader([
        ["a", "b"],
        ["1", "2"],
      ]),
    ).toEqual({ header: ["a", "b"], body: [["1", "2"]] });
  });

  it("只有一行时 body 为空数组", () => {
    expect(splitHeader([["a"]])).toEqual({ header: ["a"], body: [] });
  });

  it("空输入两侧都为空数组", () => {
    expect(splitHeader([])).toEqual({ header: [], body: [] });
  });
});
