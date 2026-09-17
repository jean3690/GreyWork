/**
 * Univer 中文本地化合并（lib/univer-locale.ts）：
 * 真加载八个 @univerjs locale 包（design / ui / docs-ui / sheets / sheets-ui / sheets-numfmt-ui /
 * sheets-formula / sheets-formula-ui），
 * 验证 buildUniverLocaleConfig 的契约：locale 固定 ZH_CN、locales 只有 zh-CN 一份、合并后是
 * 包含真实中文文案的大对象。
 */
import { describe, expect, it } from "vitest";
import { LocaleType } from "@univerjs/core";
import { buildUniverLocaleConfig, loadUniverZhLocales } from "@/lib/univer-locale";

describe("buildUniverLocaleConfig", () => {
  it("locale 固定 ZH_CN，locales 只注册合并后的 zh-CN", async () => {
    const config = await buildUniverLocaleConfig();
    expect(config.locale).toBe(LocaleType.ZH_CN);
    expect(Object.keys(config.locales)).toEqual([LocaleType.ZH_CN]);
  });

  it("八个模块合并成一份中文包，内容不是空壳", async () => {
    const pack = await loadUniverZhLocales();
    const values = JSON.stringify(pack);
    expect(Object.keys(pack)).toHaveLength(8);
    expect(values.length).toBeGreaterThan(10000);
    expect(values).toContain("表格");
    expect(values).toContain("撤销");
  });
});
