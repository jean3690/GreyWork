/**
 * 设置的**读入归一化**：把任意（旧版 / 手改 / 损坏）快照字段收敛成合法值。
 *
 * 从 `settings.ts` 拆出（P5 大文件拆分）：全部是无副作用的纯函数 —— 输入 unknown、
 * 输出合法值或 undefined/null，不碰 store、不发通知。store 的 `applySaved` 消费它们。
 */
import {
  SERVICE_FAMILIES,
  SERVICE_KINDS,
  type OfficeProviderConfig,
  type ReasoningEffort,
  type ServiceProviderConfig,
} from "@greywork/shell";
import {
  DEFAULT_LOCAL_AI,
  LOCAL_AI_TOP_K_RANGE,
  type ColorMode,
  type FontSize,
  type LocalAiPrefs,
  type McpServerEntry,
  type Radius,
  type RunMode,
  type SandboxMode,
  type SkillSourceEntry,
  type ThemeId,
} from "./types";

/** 推理等级合法值（shell REASONING_EFFORTS 的 value 集）。 */
const REASONING_EFFORT_VALUES: Record<string, true> = { auto: true, low: true, medium: true, high: true, max: true };

export function normalizeReasoningEffort(value: unknown): ReasoningEffort {
  return typeof value === "string" && REASONING_EFFORT_VALUES[value] ? (value as ReasoningEffort) : "auto";
}

/** 自定义请求头归一化：只留 string→string 非空项；形状不合法按「无附加头」处理（脏数据不拦启动）。 */
export function normalizeHeaders(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(value)) {
    if (typeof headerValue === "string" && headerValue !== "" && key.trim() !== "") headers[key] = headerValue;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/** 采样温度归一：仅接受 [0, 2] 的有限数；其余按「不传」处理。 */
export function normalizeTemperature(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 2 ? value : undefined;
}

/** 最大输出 token 归一：仅接受正整数；其余按「不传」处理。 */
export function normalizeMaxTokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * 服务族清单的合法值（从共享表取，避免两处各写一份）。
 * 直接查 `SERVICE_FAMILIES` 而不是复制字面量：将来加族时这里自动跟上。
 */
function isServiceFamily(value: unknown): value is ServiceProviderConfig["family"] {
  return typeof value === "string" && (SERVICE_FAMILIES as readonly string[]).includes(value);
}

/**
 * kind 必须属于该族的清单。
 *
 * 只查「非空字符串」会放行 `kind: "wpss365"` 这种拼错的值：设置页下拉选不出它、宿主也不认，
 * 表现是「列表里有这条、预览却永远不走云端」，所以按 `SERVICE_KINDS` 逐族校验。
 */
function isServiceKind(family: ServiceProviderConfig["family"], value: unknown): value is string {
  return typeof value === "string" && SERVICE_KINDS[family].includes(value);
}

/**
 * 归一化一条服务配置：形状不对就丢弃（返回 null），而不是让脏数据进快照。
 *
 * 与 `normalizeChannel` 同思路 —— 旧快照/手改 JSON 都可能带缺字段的条目，
 * 拼装完整的默认值比在每个消费点各防一次省事得多。
 *
 * `recipe` 只做「字段类型对不对」的形状校验，**不校验语义**：配方是否真能用得跑一次才知道，
 * 而宿主侧（`office::validate_recipe`）已经会在调用时给出明确报错。这里拦的是
 * 「设置页表单写错类型」这种在渲染端就能发现的问题。
 */
export function normalizeServiceProvider(raw: unknown): ServiceProviderConfig | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.trim() === "") return null;
  if (!isServiceFamily(record.family)) return null;
  if (!isServiceKind(record.family, record.kind)) return null;

  const base = {
    id: record.id,
    // 名称缺失时回落 id：设置页上至少还能认出是哪一条，而不是一片空白。
    name: typeof record.name === "string" && record.name !== "" ? record.name : record.id,
    family: record.family,
    kind: record.kind,
    enabled: record.enabled === true,
    ...(typeof record.baseUrl === "string" && record.baseUrl !== "" ? { baseUrl: record.baseUrl } : {}),
    ...(typeof record.credentialEnv === "string" && record.credentialEnv !== "" ? { credentialEnv: record.credentialEnv } : {}),
    ...(normalizeHeaders(record.headers) ? { headers: normalizeHeaders(record.headers) } : {}),
    ...(typeof record.frameOrigin === "string" && record.frameOrigin !== "" ? { frameOrigin: record.frameOrigin } : {}),
  };

  if (record.family === "office") {
    const office = base as OfficeProviderConfig;
    if (typeof record.docsUrl === "string" && record.docsUrl !== "") office.docsUrl = record.docsUrl;
    const recipe = normalizeOfficeRecipe(record.recipe);
    if (recipe) office.recipe = recipe;
    return office;
  }
  // 其余三族本期只有信封字段，原样返回（各自的专属字段在后面加族时补齐）。
  return base as ServiceProviderConfig;
}

/** 归一化上传配方；形状不全一律返回 null（= 该服务商不可用，预览决策会跳过它）。 */
function normalizeOfficeRecipe(raw: unknown): OfficeProviderConfig["recipe"] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.method !== "POST" && record.method !== "PUT") return undefined;
  if (typeof record.url !== "string" || record.url.trim() === "") return undefined;
  if (record.body !== "raw-bytes" && record.body !== "multipart") return undefined;
  if (typeof record.viewUrlPointer !== "string" || record.viewUrlPointer.trim() === "") return undefined;
  const recipe: NonNullable<OfficeProviderConfig["recipe"]> = {
    method: record.method,
    url: record.url,
    body: record.body,
    viewUrlPointer: record.viewUrlPointer,
  };
  if (typeof record.fileField === "string" && record.fileField !== "") recipe.fileField = record.fileField;
  if (typeof record.contentType === "string" && record.contentType !== "") recipe.contentType = record.contentType;
  if (typeof record.credentialHeader === "string" && record.credentialHeader !== "") {
    recipe.credentialHeader = record.credentialHeader;
  }
  return recipe;
}

/** 本地 AI 配置的读入归一：缺字段落默认、非法值丢弃（一条坏配置不该让整份设置失效）。 */
export function normalizeLocalAi(raw: unknown): LocalAiPrefs {
  const source = (typeof raw === "object" && raw !== null ? raw : {}) as {
    rag?: Record<string, unknown>;
    stt?: Record<string, unknown>;
  };
  const rag = source.rag ?? {};
  const stt = source.stt ?? {};
  const rawTopK = typeof rag.topK === "number" && Number.isInteger(rag.topK) ? rag.topK : DEFAULT_LOCAL_AI.rag.topK;
  const topK = Math.min(Math.max(rawTopK, LOCAL_AI_TOP_K_RANGE.min), LOCAL_AI_TOP_K_RANGE.max);
  return {
    rag: {
      enabled: rag.enabled === true,
      providerId: typeof rag.providerId === "string" ? rag.providerId : null,
      embeddingModel: typeof rag.embeddingModel === "string" ? rag.embeddingModel : DEFAULT_LOCAL_AI.rag.embeddingModel,
      topK,
    },
    stt: {
      enabled: stt.enabled === true,
      providerId: typeof stt.providerId === "string" ? stt.providerId : null,
      model: typeof stt.model === "string" ? stt.model : DEFAULT_LOCAL_AI.stt.model,
    },
  };
}

/** 细粒度 ACP 配置覆盖的读入归一：只接受 `string -> string` 的键值对。 */
export function normalizeAcpConfigValues(raw: unknown): Record<string, string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key === "string" && typeof value === "string" && value !== "") out[key] = value;
  }
  return out;
}

/* ===== 枚举合法值查表（applySaved 迁移时用） ===== */

export const SANDBOX_MODE_VALUES: Record<SandboxMode, true> = { auto: true, off: true, fs: true, full: true };
export const THEME_VALUES: Record<ThemeId, true> = {
  greywork: true,
  "night-blue": true,
  "night-green": true,
  github: true,
  fox: true,
  "liquid-glass": true,
};
export const COLOR_MODE_VALUES: Record<ColorMode, true> = { dark: true, light: true, system: true };
export const FONT_SIZE_VALUES: Record<FontSize, true> = { small: true, medium: true, large: true };
export const RADIUS_VALUES: Record<Radius, true> = { none: true, small: true, large: true };
export const RUN_MODE_VALUES: Record<RunMode, true> = { local: true, worktree: true, cloud: true };
export const MCP_TRANSPORTS: Record<McpServerEntry["transport"], true> = { http: true, sse: true, stdio: true };
export const SKILL_SOURCE_TYPES: Record<SkillSourceEntry["type"], true> = { api: true, github: true };
