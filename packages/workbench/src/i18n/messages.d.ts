// vue-i18n 类型增强：让 useI18n().t / i18n.global.t 获得 zh-CN 的 key 自动补全。
import type { MessageSchema } from "./locales/zh-CN";

declare module "vue-i18n" {
  interface DefineLocaleMessage extends MessageSchema {}
}
