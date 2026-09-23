/**
 * agent store 的纯工具与数据层：存储适配器、常量、不依赖 store 实例的纯函数。
 *
 * 归入本文件的判据：不触碰 store 闭包状态（refs / 其它 store 实例）——
 * 需要其它 store 的地方由调用方以参数传入。
 */
import type { AcpPromptUnit } from "@greywork/acp";
import { createJsonStorage, basename } from "@greywork/core";
import type { AgentProviderConfig } from "@greywork/shell";
import { ref } from "vue";
import { i18n } from "../../i18n";
import { inlineFileAttachment, inlineTextAttachment } from "../../lib/attachments";
import { readAttachmentBase64, readAttachmentText } from "../../state/attachment-library";
import type { Attachment, ThreadMessage } from "../../types";
import { notify } from "../notice";

export const t = i18n.global.t;

/** 连接在途被停止的哨兵：startAcpSession 返回它，调用方按「已停止」收尾而非报错。 */
export const CONNECT_ABORTED = "__gw_aborted_connect__";

/** 判读 spawn 类错误（缺 CLI / 命令不存在），UI 据此给安装指引而不是原文。 */
export function looksLikeMissingBinary(message: string): boolean {
  return /ENOENT|No such file|not found|command not found|spawn\b.*fail/i.test(message);
}

/** 用户自配 ACP 后端 id 前缀：mergeProviders 据此把自配项保留过加载（预设合并丢弃注册表外残留）。 */
export const CUSTOM_AGENT_PROVIDER_ID_PREFIX = "custom-";

/** 是否为用户自配后端（预设项不可编辑/删除，合并时也不会被丢弃）。 */
export function isCustomAgentProvider(id: string): boolean {
  return id.startsWith(CUSTOM_AGENT_PROVIDER_ID_PREFIX);
}

/** 自配后端 id：时间戳 + 随机后缀，跨重启唯一。 */
export function newCustomProviderId(): string {
  return `${CUSTOM_AGENT_PROVIDER_ID_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 环境变量名：POSIX 标识符（与宿主 acp_host::is_valid_env_name 同一规则）。 */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 环境变量文本（每行 `KEY=VALUE`，`#` 开头与空行忽略）→ 映射。
 * 非法行**整体拒绝**而不是跳过：少注入一个 API key 会变成「agent 莫名其妙没权限」，
 * 比当场报错难查得多。
 */
export function parseEnvText(text: string): { env: Record<string, string>; error: string | null } {
  const env: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) return { env: {}, error: t("errors.agentProviderEnvLine", { line }) };
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!ENV_NAME_PATTERN.test(key)) return { env: {}, error: t("errors.agentProviderEnvName", { key }) };
    env[key] = value;
  }
  return { env, error: null };
}

/** 映射 → 编辑用文本（每行 `KEY=VALUE`；空映射 → 空串）。 */
export function formatEnvText(env: Record<string, string> | undefined): string {
  return Object.entries(env ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

/**
 * 请求头文本（每行 `Key: Value`，`#` 开头与空行忽略）→ 映射。
 * 与 parseEnvText 同款「非法行整体拒绝」语义：少带一个鉴权头会变成
 * 「网关莫名 401」，比当场报错难查得多。值可含冒号（只在首个 `:` 处切分）。
 */
export function parseHeaderText(text: string): { headers: Record<string, string>; error: string | null } {
  const headers: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) return { headers: {}, error: t("errors.agentProviderHeaderLine", { line }) };
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!key || !value) return { headers: {}, error: t("errors.agentProviderHeaderLine", { line }) };
    headers[key] = value;
  }
  return { headers, error: null };
}

/** 映射 → 编辑用文本（每行 `Key: Value`；空映射 → 空串）。 */
export function formatHeaderText(headers: Record<string, string> | undefined): string {
  return Object.entries(headers ?? {})
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

/**
 * 持久化形状 → 映射：库行是 JSON 对象文本、本地缓存是对象本身，两种都认；
 * 形状不合法一律按「没有环境变量」处理（脏数据不该拦住启动）。
 */
export function parseProviderEnv(raw: unknown): Record<string, string> | undefined {
  const source = typeof raw === "string" ? safeJsonObject(raw) : raw;
  if (typeof source !== "object" || source === null || Array.isArray(source)) return undefined;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string" && value !== "") env[key] = value;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

function safeJsonObject(raw: string): unknown {
  if (raw.trim() === "") return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** 映射 → 库字段（JSON 对象文本）；空映射 → null（表示继承宿主环境）。 */
export function serializeProviderEnv(env: Record<string, string> | undefined): string | null {
  const entries = Object.entries(env ?? {});
  return entries.length > 0 ? JSON.stringify(Object.fromEntries(entries)) : null;
}

/** 从命令首 token 派生探测程序（自配后端无预设 detect 元数据，仍能显示安装状态）。 */
export function detectProgramOf(command: string): string[] {
  const program = command.trim().split(/\s+/)[0] ?? "";
  const name = basename(program);
  return name ? [name] : [];
}

const PROVIDERS_STORAGE_KEY = "greywork.agent-providers";
export const providersStorage = createJsonStorage<{ providers: AgentProviderConfig[] }>(
  PROVIDERS_STORAGE_KEY,
  (value): value is { providers: AgentProviderConfig[] } =>
    typeof value === "object" && value !== null && Array.isArray((value as { providers?: unknown }).providers),
);

/**
 * 后端图标的用户覆盖层。
 *
 * 桌面端真源是 SQLite 的 agent_providers 表，那里没有图标列（图标纯展示、且与
 * detect/installHint 一样不属于「能被启动的后端」契约）。而合并流程以表为准重建目录
 * —— 图标只写在 provider 对象上会在每次 hydration 后被冲掉，故单独存一张 id → 图标名
 * 的映射，合并之后再盖回去。预设后端也走这张表，于是「给预设换个图标」同样成立。
 */
const PROVIDER_ICONS_STORAGE_KEY = "greywork.agent-provider-icons";
export const providerIconsStorage = createJsonStorage<{ icons: Record<string, string> }>(
  PROVIDER_ICONS_STORAGE_KEY,
  (value): value is { icons: Record<string, string> } => typeof value === "object" && value !== null && "icons" in value,
);

/** 后端选择偏好（场景一 Guid 预选持久化）：provider id；null = Local LLM。 */
export interface ProviderPreference {
  providerId: string | null;
}
export const providerPrefStorage = createJsonStorage<ProviderPreference>(
  "greywork.acp-provider",
  (value): value is ProviderPreference => typeof value === "object" && value !== null && "providerId" in value,
);

/** ACP 全局默认会话配置的持久化形状。 */
export interface AcpDefaultConfig {
  configValues: Record<string, string>;
}
const acpDefaultConfigStorage = createJsonStorage<AcpDefaultConfig>(
  "greywork.acp-default-config",
  (value): value is AcpDefaultConfig =>
    typeof value === "object" && value !== null && typeof (value as { configValues?: unknown }).configValues === "object",
);

/**
 * ACP 全局默认会话配置（configId → 值；模块级 ref，独立于 pinia 实例）。
 *
 * 层级：工作区记忆 > 全局默认 > 后端出厂值。工作区记忆是「这个项目的干活方式」，
 * 默认是「我没表态时的兜底」——两者分开存，切新工作区不至于完全裸奔。
 * 旧数据无该键 = 无默认，天然兼容。
 */
export const acpDefaultConfigValues = ref<Record<string, string>>(acpDefaultConfigStorage.read()?.configValues ?? {});

function persistAcpDefaultConfig(): void {
  const values = acpDefaultConfigValues.value;
  if (Object.keys(values).length > 0) acpDefaultConfigStorage.write({ configValues: { ...values } });
  else acpDefaultConfigStorage.write({ configValues: {} });
}

/** 整体覆写全局默认（AcpSessionConfig 的「设为全局默认」收集当前 select 型 currentValue）。 */
export function setAcpDefaultConfig(values: Record<string, string>): void {
  acpDefaultConfigValues.value = { ...values };
  persistAcpDefaultConfig();
}

/** 清空全局默认（回到「完全跟随后端出厂值」）。 */
export function clearAcpDefaultConfig(): void {
  acpDefaultConfigValues.value = {};
  persistAcpDefaultConfig();
}

/** 编排域（runs store）经此桥消费 ACP 事件：子任务 chunk/完成按 sessionId/handle 归属路由。 */
export interface RunEventBridge {
  /** session-update 载荷；sessionId 命中子任务会话即写子任务支架，返回 true 表示已消费。 */
  routeSessionUpdate?(payload: unknown): boolean;
  /** prompt-done 按 handle 完成子任务（finishSubtask + 解除回执）；error = 回合失败原因；true = 已消费。 */
  routeSubtaskDone?(handle: number, error?: string): boolean;
  /** 在途子任务句柄（applyPermissionTier 需同步档位到所有 agent 进程）。 */
  collectActiveHandles?(): number[];
}

/** 全局回合结束上下文（threadId/messageId 由 sendGlobalTurn 创建后经参数携带，调用方闭包无法预捕获）。 */
export interface GlobalTurnEndContext {
  threadId: string;
  messageId: string;
  error?: unknown;
}

/** sendGlobalTurn 的回合收尾钩子：编排 planner 回合与普通对话走同一全局回合机制，差异经钩子表达。 */
export interface GlobalTurnHooks {
  /** prompt() 层异常后回调（agent 侧已复位回合状态）；返回 true = 已自写支架错误文案，跳过默认 [ACP 派发失败]。 */
  onPromptError?(ctx: GlobalTurnEndContext): boolean | void;
  /** prompt-done 清场后回调（脚手架收尾已完成，此时读 content 即为终稿）。 */
  onPromptDone?(ctx: GlobalTurnEndContext): void;
  /** true = 回合开始不清 acpThoughtText（planner 路径保持与旧 dispatchRun 一致）。 */
  preserveThought?: boolean;
}

/** sendGlobalTurn 的派发选项。 */
export interface GlobalTurnOptions {
  hooks?: GlobalTurnHooks;
  /** 信任调用方已 connectAcp（planner 路径与旧 dispatchRun 一致：先连接后建回合，不做会话隔离检查）。 */
  reuseGlobalSession?: boolean;
  /** 复用已入流的支架（计划门确认路径：user + assistant 已由 beginAcpPlan 推入，不再重复入流）。 */
  reuseScaffold?: { threadId: string; message: ThreadMessage };
  /** 随本轮 prompt 发出的附件（图片走 image 内容块，文本内联为 text 块）。 */
  attachments?: readonly Attachment[];
}

/**
 * 附件 → ACP prompt 单元：图片读成 base64 走 image 块，文本内联为 text 块。
 *
 * 单条读失败（附件文件被删/移走）只跳过该条并提示，不让整轮派发失败 ——
 * 文字部分照常送达，用户至少知道发生了什么。`imageSupported` 为 false 时过滤图片
 * （agent 未声明图片能力），这是 UI 置灰之外的宿主侧兜底。
 */
export async function toAcpUnits(attachments: readonly Attachment[], imageSupported: boolean): Promise<AcpPromptUnit[]> {
  const units: AcpPromptUnit[] = [];
  let imagesDropped = false;
  for (const item of attachments) {
    try {
      if (item.kind === "image") {
        if (!imageSupported) {
          imagesDropped = true;
          continue;
        }
        units.push({ type: "image", data: await readAttachmentBase64(item), mimeType: item.mime || "image/png" });
      } else if (item.kind === "text") {
        const { text, truncated } = await readAttachmentText(item);
        units.push({ type: "text", text: inlineTextAttachment(item.name, text, truncated) });
      } else {
        // 通用文件：只递路径引用。本机 ACP agent 能按路径直接读，不必把字节塞进 prompt。
        units.push({ type: "text", text: inlineFileAttachment(item.name, item.path) });
      }
    } catch (error) {
      notify({
        kind: "error",
        key: "attachment-read",
        title: t("errors.attachmentReadFailed"),
        detail: error instanceof Error ? `${item.name}：${error.message}` : item.name,
      });
    }
  }
  if (imagesDropped) notify({ kind: "warning", key: "attachment-image-unsupported", title: t("chat.attachImagesUnsupported") });
  return units;
}
