// i18n 数据正确性验证：两语言 key 集合对等 + setLocale 行为冒烟。
// 本文件位于 src/i18n/（coverage exclude 内），仍正常执行测试。
import { describe, expect, it } from "vitest";
import { i18n, setLocale } from "@/i18n/index";
import { enUS } from "@/i18n/locales/en-US";
import { zhCN } from "@/i18n/locales/zh-CN";

type Dict = Record<string, unknown>;

function flatten(obj: Dict, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === "string" ? [path] : flatten(value as Dict, path);
  });
}

describe("i18n locales", () => {
  it("zh-CN 与 en-US 的扁平 key 集合对等", () => {
    const zh = flatten(zhCN as Dict).sort();
    const en = flatten(enUS as Dict).sort();
    expect(en).toEqual(zh);
  });

  it("setLocale 更新全局 locale（无 DOM 环境安全）", () => {
    const original = i18n.global.locale.value;
    setLocale("en-US");
    expect(i18n.global.locale.value).toBe("en-US");
    expect(i18n.global.t("settings.title")).toBe("Settings");
    expect(i18n.global.t("common.save")).toBe("Save");
    setLocale(original as "zh-CN" | "en-US");
    expect(i18n.global.t("settings.title")).toBe("设置");
  });

  it("缺失 key 回退原文（数据驱动动态标题场景不告警）", () => {
    // 市场插件贡献的 title 字符串（非 i18n key）应原样回显。
    expect(i18n.global.t("ext:ext-gis:gis")).toBe("ext:ext-gis:gis");
  });

  it("命名插值渲染", () => {
    expect(i18n.global.t("errors.startFailed", { detail: "boom" })).toBe("启动失败：boom");
    expect(i18n.global.t("market.fileCount", { count: 3 })).toBe("3 个文件");
  });

  it("外观术语统一：功能名「深色模式」，取值「深色 / 浅色 / 跟随系统」", () => {
    setLocale("zh-CN");
    expect(i18n.global.t("settings.colorMode.title")).toBe("深色模式");
    expect([
      i18n.global.t("settings.colorMode.dark"),
      i18n.global.t("settings.colorMode.light"),
      i18n.global.t("settings.colorMode.system"),
    ]).toEqual(["深色", "浅色", "跟随系统"]);

    // 旧称（暗黑模式 / 深浅模式 / 明暗模式）不得回到界面文案里
    for (const key of ["settings.colorMode.title", "settings.appearance.paletteHint", "settings.sections.appearance.desc"]) {
      expect(i18n.global.t(key)).not.toMatch(/暗黑|深浅|明暗/);
    }

    // 侧栏快捷行的提示带当前模式与下一个模式
    expect(i18n.global.t("settings.colorMode.cycle", { current: "深色", next: "浅色" })).toBe("外观：深色，点击切换为浅色");
  });
});
