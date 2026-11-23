import type { AppLocale } from "@/i18n";
import type { ColorMode, FontSize, Radius, ThemeId } from "@/stores/settings/types";
import { COLOR_MODE_VALUES, FONT_SIZE_VALUES, RADIUS_VALUES, THEME_VALUES } from "@/stores/settings/normalize";

/** 独立的跨设备协议，绝不序列化完整 SavedSettings。 */
export interface PublicPreferences {
  schemaVersion: 1;
  theme: ThemeId;
  colorMode: ColorMode;
  fontSize: FontSize;
  radius: Radius;
  locale: AppLocale;
}
export interface PreferencesSnapshot {
  revision: string | null;
  deleted: boolean;
  payload: PublicPreferences | null;
}
export interface PreferencesBaseline {
  revision: string;
  payload: PublicPreferences;
}

function record(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("同步偏好格式无效");
  return raw as Record<string, unknown>;
}
function enumValue<T extends string>(value: unknown, values: Record<T, true>): T {
  if (typeof value !== "string" || !Object.hasOwn(values, value)) throw new Error("同步偏好包含无效字段");
  return value as T;
}
export function parsePublicPreferences(raw: unknown): PublicPreferences {
  const value = record(raw);
  if (value.schemaVersion !== 1) throw new Error("同步偏好版本不兼容，请更新客户端");
  return {
    schemaVersion: 1,
    theme: enumValue(value.theme, THEME_VALUES),
    colorMode: enumValue(value.colorMode, COLOR_MODE_VALUES),
    fontSize: enumValue(value.fontSize, FONT_SIZE_VALUES),
    radius: enumValue(value.radius, RADIUS_VALUES),
    locale: enumValue(value.locale, { "zh-CN": true, "en-US": true }),
  };
}
export function publicPreferencesOf(value: Omit<PublicPreferences, "schemaVersion">): PublicPreferences {
  return parsePublicPreferences({
    schemaVersion: 1,
    theme: value.theme,
    colorMode: value.colorMode,
    fontSize: value.fontSize,
    radius: value.radius,
    locale: value.locale,
  });
}
/** Long 全程作为字符串传输/比较，拒绝浏览器已丢精度的数字。 */
export function parseSyncRevision(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^[1-9]\d{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) {
    throw new Error("同步版本号无效，请更新 Java 后端");
  }
  return value;
}
export function parsePreferencesSnapshot(raw: unknown): PreferencesSnapshot {
  const value = record(raw);
  const revision = parseSyncRevision(value.revision);
  if (typeof value.deleted !== "boolean") throw new Error("云端同步状态不完整");
  if (revision === null || value.deleted) {
    if (value.payload !== null || (revision === null && value.deleted)) throw new Error("云端同步状态不完整");
    return { revision, deleted: value.deleted, payload: null };
  }
  return { revision, deleted: false, payload: parsePublicPreferences(value.payload) };
}
export function preferencesFingerprint(value: PublicPreferences): string {
  return JSON.stringify(parsePublicPreferences(value));
}
/** 同步基线按服务器 + 用户隔离；地址中的认证信息不进入本地存储。 */
export function preferencesAccountKey(baseUrl: string | null | undefined, userId: string | undefined): string | null {
  if (!baseUrl || !userId) return null;
  try {
    const url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return `greywork.preferences-sync:${encodeURIComponent(url.toString().replace(/\/+$/, ""))}:${encodeURIComponent(userId)}`;
  } catch {
    return null;
  }
}
