/**
 * xlsx 回写：只把「用户改动过的单元格」写进原始文件。
 *
 * 这里最要紧的一条断言是「未被动过的公式格仍是公式」—— 这正是选择差量回写而不是
 * 快照全量导出的理由：读入方向只取公式的缓存结果，整表重建会把公式烤成静态值。
 */
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import type { IWorkbookData } from "@univerjs/core";
import { xlsxToUniverWorkbook } from "@/lib/univer-xlsx";
import { applyUniverEdits } from "@/lib/univer-xlsx-write";

/** 测试用宽松形态：只看 sheets[id].name / cellData，不关心 Univer 快照的其余字段。 */
interface LooseCell {
  v?: unknown;
  f?: string;
}
interface LooseSheet {
  id?: string;
  name?: string;
  cellData?: Record<number, Record<number, LooseCell | undefined>>;
}

/** 快照里的工作表表（键是 sheetId）；Univer 那边按 Partial<IWorksheetData> 声明，这里只取用到的部分。 */
function sheetsOf(workbook: IWorkbookData): Record<string, LooseSheet> {
  return (workbook as unknown as { sheets: Record<string, LooseSheet> }).sheets;
}

/** 一张带公式的小表（B2 是数值，C2 是公式，用于验证「没碰的公式别动」）。 */
async function buildXlsx(): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("客流");
  sheet.getCell("A1").value = "站点";
  sheet.getCell("B1").value = "客流";
  sheet.getCell("A2").value = "北京站";
  sheet.getCell("B2").value = 4281;
  sheet.getCell("C2").value = { formula: "SUM(B2)", result: 4281 } as never;
  return new Uint8Array((await workbook.xlsx.writeBuffer()) as ArrayBuffer);
}

async function reload(data: Uint8Array): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(data) as unknown as ArrayBuffer);
  return workbook;
}

async function baseAndCurrent(): Promise<{ bytes: Uint8Array; base: IWorkbookData; current: IWorkbookData }> {
  const bytes = await buildXlsx();
  const base = await xlsxToUniverWorkbook(bytes);
  return { bytes, base, current: structuredClone(base) };
}

describe("applyUniverEdits", () => {
  it("改过的格写回，未动的格（含公式）原样保留", async () => {
    const { bytes, base, current } = await baseAndCurrent();
    sheetsOf(current)["sheet-1"]!.cellData![1]![1] = { v: 9999 };

    const sheet = (await reload(await applyUniverEdits(bytes, base, current))).getWorksheet("客流")!;
    expect(sheet.getCell("B2").value).toBe(9999);
    expect(sheet.getCell("A1").value).toBe("站点");
    // 公式格没被碰过 → 原始文件里的公式必须还在（不是被烤成 4281）
    expect(sheet.getCell("C2").value).toEqual({ formula: "SUM(B2)", result: 4281 });
  });

  it("删掉的格在回写后为空，相邻格不受影响", async () => {
    const { bytes, base, current } = await baseAndCurrent();
    delete sheetsOf(current)["sheet-1"]!.cellData![1]![1];

    const sheet = (await reload(await applyUniverEdits(bytes, base, current))).getWorksheet("客流")!;
    expect(sheet.getCell("B2").value).toBeNull();
    expect(sheet.getCell("A2").value).toBe("北京站");
  });

  it("新输入的内容写进原本空着的格", async () => {
    const { bytes, base, current } = await baseAndCurrent();
    sheetsOf(current)["sheet-1"]!.cellData![2] = { 0: { v: "上海站" }, 1: { v: 3650 } };

    const sheet = (await reload(await applyUniverEdits(bytes, base, current))).getWorksheet("客流")!;
    expect(sheet.getCell("A3").value).toBe("上海站");
    expect(sheet.getCell("B3").value).toBe(3650);
  });

  it("在预览里新写入的公式以公式形态落进文件", async () => {
    const { bytes, base, current } = await baseAndCurrent();
    sheetsOf(current)["sheet-1"]!.cellData![2] = { 0: { v: "上海站" }, 1: { f: "SUM(B2:B2)", v: 4281 } };

    const sheet = (await reload(await applyUniverEdits(bytes, base, current))).getWorksheet("客流")!;
    expect(sheet.getCell("B3").value).toEqual({ formula: "SUM(B2:B2)", result: 4281 });
  });

  it("Univer 里改的表名写回工作簿", async () => {
    const { bytes, base, current } = await baseAndCurrent();
    sheetsOf(current)["sheet-1"]!.name = "改名了";

    const workbook = await reload(await applyUniverEdits(bytes, base, current));
    expect(workbook.worksheets).toHaveLength(1);
    expect(workbook.getWorksheet("改名了")!.getCell("A1").value).toBe("站点");
  });

  it("Univer 里新增的工作表一并写回", async () => {
    const { bytes, base, current } = await baseAndCurrent();
    sheetsOf(current)["新增"] = { id: "新增", name: "新增", cellData: { 0: { 0: { v: "明细" } } } };
    current.sheetOrder.push("新增");

    const workbook = await reload(await applyUniverEdits(bytes, base, current));
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(["客流", "新增"]);
    expect(workbook.getWorksheet("新增")!.getCell("A1").value).toBe("明细");
  });

  it("没有任何改动时也能正常产出可读的工作簿", async () => {
    const { bytes, base, current } = await baseAndCurrent();
    const sheet = (await reload(await applyUniverEdits(bytes, base, current))).getWorksheet("客流")!;
    expect(sheet.getCell("B2").value).toBe(4281);
  });
});
