/**
 * Univer 中文本地化数据加载与合并（产物查看器共用）。
 *
 * Univer 的 LocaleService 只有在 `new Univer({ locales })` 传入数据后才会初始化；
 * 仅设置 `locale`（未 load 数据）会触发 `[LocaleService]: Locale not initialized`。
 * locale 模块均以 `export { locale as default }` 提供，这里统一 + 深合并。
 */
import { LocaleType, type ILanguagePack, type ILocales } from "@univerjs/core";

type UniverLocaleMap = ILanguagePack;

/** 深合并多个 locale 对象（Univer 的 `Tools.deepMerge` 语义：后者覆盖前者，嵌套对象递归）。 */
function deepMerge(target: UniverLocaleMap, ...sources: Partial<UniverLocaleMap>[]): UniverLocaleMap {
  for (const src of sources) {
    if (!src) continue;
    for (const key of Object.keys(src)) {
      const value = src[key] as ILanguagePack[string];
      const existing = target[key];
      target[key] =
        existing && value && typeof existing === "object" && typeof value === "object"
          ? deepMerge(existing as UniverLocaleMap, value as UniverLocaleMap)
          : value;
    }
  }
  return target;
}

type LocaleModule = { default: UniverLocaleMap };

/**
 * 加载并合并 Univer 常用 zh-CN 语言包。
 * design / ui 为所有产品共用；docs-ui 供文档；sheets-ui / sheets 供表格。
 * 幻灯片不在此列：pptx 预览已改为自解析 + DOM 渲染（`lib/pptx-parse.ts`），不再经 Univer。
 */
export async function loadUniverZhLocales(docs = false, sheets = false): Promise<UniverLocaleMap> {
  const imports: Promise<LocaleModule>[] = [
    import("@univerjs/design/locale/zh-CN") as Promise<LocaleModule>,
    import("@univerjs/ui/locale/zh-CN") as Promise<LocaleModule>,
  ];
  if (docs) imports.push(import("@univerjs/docs-ui/locale/zh-CN") as Promise<LocaleModule>);
  if (sheets) {
    imports.push(import("@univerjs/sheets/locale/zh-CN") as Promise<LocaleModule>);
    imports.push(import("@univerjs/sheets-ui/locale/zh-CN") as Promise<LocaleModule>);
  }

  const modules = await Promise.all(imports);
  return deepMerge({}, ...modules.map((m) => m.default));
}

/** 供 `new Univer({ locale, locales })` 使用的最小 locales 配置（含合并后的 zh-CN 数据）。 */
export async function buildUniverLocaleConfig(docs = false, sheets = false): Promise<{ locale: LocaleType; locales: ILocales }> {
  const localeData = await loadUniverZhLocales(docs, sheets);
  return {
    locale: LocaleType.ZH_CN,
    locales: { [LocaleType.ZH_CN]: localeData },
  };
}
