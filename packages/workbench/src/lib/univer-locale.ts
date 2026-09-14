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
 * 加载并合并 Univer 表格用的 zh-CN 语言包（design / ui 为共用底座，sheets 系为表格）。
 *
 * 只剩表格：docx 与 pptx 预览都已改为自解析 + DOM 渲染
 * （`lib/docx-parse.ts` / `lib/pptx-parse.ts`），不再经 Univer。
 * 表格留着它是因为 Univer 的虚拟化网格（滚动 / 冻结 / 列宽）自己重写不划算。
 * 清单与 SheetViewer 手动注册的插件集一一对应（去掉了 preset 后没有旁路可兜底）。
 */
export async function loadUniverZhLocales(): Promise<UniverLocaleMap> {
  const modules = await Promise.all([
    import("@univerjs/design/locale/zh-CN") as Promise<LocaleModule>,
    import("@univerjs/ui/locale/zh-CN") as Promise<LocaleModule>,
    import("@univerjs/docs-ui/locale/zh-CN") as Promise<LocaleModule>,
    import("@univerjs/sheets/locale/zh-CN") as Promise<LocaleModule>,
    import("@univerjs/sheets-ui/locale/zh-CN") as Promise<LocaleModule>,
    import("@univerjs/sheets-numfmt-ui/locale/zh-CN") as Promise<LocaleModule>,
  ]);
  return deepMerge({}, ...modules.map((m) => m.default));
}

/** 供 `new Univer({ locale, locales })` 使用的最小 locales 配置（含合并后的 zh-CN 数据）。 */
export async function buildUniverLocaleConfig(): Promise<{ locale: LocaleType; locales: ILocales }> {
  return {
    locale: LocaleType.ZH_CN,
    locales: { [LocaleType.ZH_CN]: await loadUniverZhLocales() },
  };
}
