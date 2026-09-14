import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { sanitizeXlsxGraphics, hasGraphicsParts } from "@/lib/xlsx-sanitize";

/**
 * 预览跑在 Tauri 的 webview 里，`exceljs` 走 package 的 `browser` 字段 → dist 预打包产物，
 * 仓库 pnpm patch 打的是 `lib/`，对这份产物无效。所以回归必须落在 dist 上才算数：
 * 用 `createRequire` 直接把它拉进来，而不是用 vitest 解析到的（打过补丁的）`lib/`。
 */
const browserExcelJS: typeof ExcelJS = createRequire(import.meta.url)("exceljs/dist/exceljs.min.js");

/** openpyxl 风格的图纸部件：`<wsDr>` 用默认命名空间，exceljs 的 dist 按 `xdr:` 前缀匹配，解析不出 anchors。 */
const DRAWING_XML =
  '<wsDr xmlns="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing">' +
  "<oneCellAnchor><from><col>5</col><row>1</row></from><ext/><graphicFrame>" +
  '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData/></a:graphic>' +
  "</graphicFrame><clientData/></oneCellAnchor></wsDr>";

const SHEET_RELS_XML =
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" ' +
  'Target="/xl/drawings/drawing1.xml" Id="rId1"/></Relationships>';

/** 造一份「写入器带图纸」的 xlsx：内容用 exceljs 自己写，再手工塞入 openpyxl 风格的图纸。 */
async function workbookWithDrawing(): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("数据");
  sheet.getCell("A1").value = "站点";
  sheet.getCell("B1").value = 42;

  const zip = await JSZip.loadAsync(await workbook.xlsx.writeBuffer());
  zip.file("xl/drawings/drawing1.xml", DRAWING_XML);
  zip.file("xl/worksheets/_rels/sheet1.xml.rels", SHEET_RELS_XML);
  const sheetXml = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
  zip.file("xl/worksheets/sheet1.xml", sheetXml.replace("</worksheet>", '<drawing r:id="rId1"/></worksheet>'));
  return new Uint8Array(await zip.generateAsync({ type: "arraybuffer" }));
}

function load(data: Uint8Array | ArrayBuffer): Promise<ExcelJS.Workbook> {
  const workbook = new browserExcelJS.Workbook();
  return workbook.xlsx.load(data).then(() => workbook);
}

describe("sanitizeXlsxGraphics", () => {
  it("带图纸的表格：未清洗会在 dist 上崩在 anchors，清洗后能读回", async () => {
    const raw = await workbookWithDrawing();
    await expect(load(raw)).rejects.toThrow();

    const workbook = await load(await sanitizeXlsxGraphics(raw));
    expect(workbook.worksheets).toHaveLength(1);
    expect(workbook.getWorksheet("数据")!.getCell("A1").value).toBe("站点");
    expect(workbook.getWorksheet("数据")!.getCell("B1").value).toBe(42);
  });

  it("图纸部件、图纸关系、sheet 里的 drawing 引用三处都清掉", async () => {
    const zip = await JSZip.loadAsync(await sanitizeXlsxGraphics(await workbookWithDrawing()));
    const names = Object.keys(zip.files);
    expect(names.filter((name) => /drawings|charts|media/.test(name))).toEqual([]);
    expect(await zip.file("xl/worksheets/sheet1.xml")!.async("string")).not.toContain("<drawing");
    expect(await zip.file("xl/worksheets/_rels/sheet1.xml.rels")!.async("string")).not.toContain("drawings/");
  });

  it("没有图纸时原样返回，不重打包", async () => {
    const plain = new Uint8Array(await new ExcelJS.Workbook().xlsx.writeBuffer());
    // 原样返回的是同一份字节的视图，不是 generateAsync 出来的新包
    expect(new Uint8Array(await sanitizeXlsxGraphics(plain))).toEqual(plain);
  });

  it("不是 zip 时原样返回，把报错权留给 exceljs", async () => {
    const junk = new TextEncoder().encode("not a zip at all");
    expect(new Uint8Array(await sanitizeXlsxGraphics(junk))).toEqual(junk);
  });
});

describe("hasGraphicsParts", () => {
  it("带图纸的表格判为 true（保存会丢掉这些部件，需要提前告知用户）", async () => {
    expect(await hasGraphicsParts(await workbookWithDrawing())).toBe(true);
  });

  it("自家写入器产出的无图纸表格判为 false", async () => {
    const plain = new Uint8Array(await new ExcelJS.Workbook().xlsx.writeBuffer());
    expect(await hasGraphicsParts(plain)).toBe(false);
  });

  it("不是 zip 时回 false，不抢 exceljs 的报错语义", async () => {
    expect(await hasGraphicsParts(new TextEncoder().encode("junk"))).toBe(false);
  });
});
