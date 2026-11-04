import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { datetimeToString, detectCustomNumberFormat, excelToStandardDatetime, readSheetFromBytes, rustFloatString } from "../src/sheet.js";

const sample = readFileSync(new URL("./fixtures/sample.xls", import.meta.url));

describe("rustFloatString", () => {
  it("matches Rust f64 Display", () => {
    expect(rustFloatString(10)).toBe("10");
    expect(rustFloatString(2.5)).toBe("2.5");
    expect(rustFloatString(0.1)).toBe("0.1");
    expect(rustFloatString(-7)).toBe("-7");
    expect(rustFloatString(1e21)).toBe("1000000000000000000000");
    expect(rustFloatString(1e-7)).toBe("0.0000001");
  });
});

describe("detectCustomNumberFormat", () => {
  it("mirrors calamine classification", () => {
    expect(detectCustomNumberFormat("mm-dd-yy")).toBe("datetime");
    expect(detectCustomNumberFormat("[h]:mm:ss")).toBe("timedelta");
    expect(detectCustomNumberFormat("h:mm AM/PM")).toBe("datetime");
    expect(detectCustomNumberFormat("General")).toBe("other");
    expect(detectCustomNumberFormat("0.00")).toBe("other");
    expect(detectCustomNumberFormat("yyyy;mmm")).toBe("datetime");
  });
});

describe("excelToStandardDatetime", () => {
  it("matches Rust test vectors", () => {
    expect(excelToStandardDatetime(45293, false)).toEqual([2024, 1, 2, 0, 0, 0]);
    expect(excelToStandardDatetime(45293.5, false)).toEqual([2024, 1, 2, 12, 0, 0]);
  });
});

describe("datetimeToString", () => {
  it("formats by shape", () => {
    expect(datetimeToString(45293, false, false)).toBe("2024-01-02");
    expect(datetimeToString(45293.5, false, false)).toBe("2024-01-02 12:00:00");
    expect(datetimeToString(0.5, false, false)).toBe("12:00:00");
    expect(datetimeToString(1.5, true, false)).toBe("36:00:00");
    expect(datetimeToString(0.25, true, false)).toBe("06:00:00");
  });
});

describe("readSheetFromBytes (legacy .xls)", () => {
  it("matches the Rust fixture expectations", () => {
    const table = readSheetFromBytes(sample, null, 20000);
    expect(table.sheets).toEqual(["Sheet1"]);
    expect(table.name).toBe("Sheet1");
    expect(table.truncated).toBe(false);
    expect(table.rows[0]).toEqual(["name", "qty", "when", "flag"]);
    expect(table.rows[1]).toEqual(["alpha", "10", "2024-01-02 03:04:05", "TRUE"]);
    expect(table.rows[2]).toEqual(["beta", "2.5", "2024-06-30", "FALSE"]);
    expect(table.rows.length).toBe(4);
  });

  it("unknown sheet falls back to first and row limit truncates", () => {
    const table = readSheetFromBytes(sample, "不存在的表", 2);
    expect(table.name).toBe("Sheet1");
    expect(table.truncated).toBe(true);
    expect(table.rows.length).toBe(2);
  });

  it("garbage bytes are rejected with a message", () => {
    expect(() => readSheetFromBytes(Buffer.from("not a spreadsheet"), null, 20000)).toThrow(/无法识别表格格式/);
  });
});
