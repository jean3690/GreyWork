// i18n 单例：zh-CN 默认 + en-US。
// 注意：本模块禁止 import 任何 store（settings.ts 被测试直接 import，循环会炸）；
// locale 初值直接从 localStorage 解析（与 settings 持久化同源），不经 store。
import { createJsonStorage } from "@greywork/core";
import { createI18n } from "vue-i18n";
import { enUS } from "./locales/en-US";
import { zhCN } from "./locales/zh-CN";

const STORAGE_KEY = "greywork.settings";

export type AppLocale = "zh-CN" | "en-US";

const settingsLocaleStorage = createJsonStorage<{ locale?: string }>(
  STORAGE_KEY,
  (value): value is { locale?: string } => typeof value === "object" && value !== null && !Array.isArray(value),
);

function initialLocale(): AppLocale {
  return settingsLocaleStorage.read()?.locale === "en-US" ? "en-US" : "zh-CN";
}

export const i18n = createI18n({
  legacy: false,
  locale: initialLocale(),
  fallbackLocale: "zh-CN",
  // 数据驱动的动态标题（如市场插件贡献的 title 字符串）缺失 key 时回退原文，不告警。
  missingWarn: false,
  fallbackWarn: false,
  messages: { "zh-CN": zhCN, "en-US": enUS },
});

/** 切换语言并同步 <html lang>；locale 落盘由 settings.persist() 负责。 */
export function setLocale(locale: AppLocale): void {
  i18n.global.locale.value = locale;
  if (typeof document !== "undefined") document.documentElement.lang = locale;
}
