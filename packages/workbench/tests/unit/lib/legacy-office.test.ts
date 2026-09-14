/**
 * 老格式容器嗅探：结论决定用户看到的是「不支持这种格式」还是「改名就能看」，
 * 判错的代价是把能打开的文件说成打不开，所以每种容器都要有用例。
 */
import { describe, expect, it } from "vitest";
import { sniffOfficeContainer } from "@/lib/legacy-office";

/** OLE2 复合文档头（.doc / .xls / .ppt 的真身）。 */
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
/** ZIP 本地文件头。 */
const ZIP = [0x50, 0x4b, 0x03, 0x04];
/** 空归档 / 分卷归档的 ZIP 头，也应当被判为 ZIP。 */
const ZIP_EMPTY = [0x50, 0x4b, 0x05, 0x06];

function bytes(...parts: Array<number[] | string>): Uint8Array {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      for (const char of part) out.push(char.charCodeAt(0) & 0xff);
    } else {
      out.push(...part);
    }
  }
  return new Uint8Array(out);
}

describe("sniffOfficeContainer", () => {
  it("OLE2 头判为真·老格式", () => {
    expect(sniffOfficeContainer(bytes(OLE2, [0, 1, 2]))).toEqual({ kind: "ole2" });
  });

  it.each([
    ["word/document.xml", "docx"],
    ["xl/workbook.xml", "xlsx"],
    ["ppt/presentation.xml", "pptx"],
  ] as const)("ZIP 里带 %s 判为 %s（扩展名被改错的情况）", (marker, format) => {
    expect(sniffOfficeContainer(bytes(ZIP, [0, 0], marker))).toEqual({ kind: "ooxml", format });
  });

  it("是 ZIP 但找不到 OOXML 条目名时降级为 zip，不硬猜格式", () => {
    expect(sniffOfficeContainer(bytes(ZIP, "some/other/entry.xml"))).toEqual({ kind: "zip" });
  });

  it("空归档头也是 ZIP", () => {
    expect(sniffOfficeContainer(bytes(ZIP_EMPTY))).toEqual({ kind: "zip" });
  });

  it("只扫描开头一段，窗口之外的条目名不算数", () => {
    // 本地文件头集中在文件开头，超长填充后出现标记属于异常布局，宁可判 zip 也不误报可渲染。
    const padding = new Array<number>(9 * 1024).fill(0);
    expect(sniffOfficeContainer(bytes(ZIP, padding, "word/document.xml"))).toEqual({ kind: "zip" });
  });

  it("空内容与无关字节都判 unknown", () => {
    expect(sniffOfficeContainer(new Uint8Array(0))).toEqual({ kind: "unknown" });
    expect(sniffOfficeContainer(bytes("not an office file at all"))).toEqual({ kind: "unknown" });
  });

  it("签名被截断时不算命中", () => {
    // 只有前 4 个 OLE2 字节：长度不足，不能判成 OLE2。
    expect(sniffOfficeContainer(bytes(OLE2.slice(0, 4)))).toEqual({ kind: "unknown" });
    // 只有一个字节的 ZIP 头同理。
    expect(sniffOfficeContainer(bytes([0x50]))).toEqual({ kind: "unknown" });
  });
});
