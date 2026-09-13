/**
 * 斜杠命令目录纯逻辑：触发判定、过滤、ACP 命令归一化、内置 + agent 合并。
 *
 * 输入框菜单是唯一消费方（ConversationView / GuidView 共用 use-slash-commands）。
 * 这里不碰 store / DOM，保持 node 可测；内置命令的文案从 i18n 现成 key 取
 * （chat.commands.<id>.desc / .template），名称就是 id。
 */

import type { AcpAvailableCommand } from "@greywork/acp";

export type SlashCommandSource = "builtin" | "acp";

/** 内置命令语义：toggle = 直接开关本地能力；template = 把模板填进草稿待编辑。 */
export type BuiltinSlashKind = "toggle" | "template";

export interface BuiltinSlashDescriptor {
  id: string;
  kind: BuiltinSlashKind;
  /** 模板命令的文案 key；toggle 无。 */
  templateKey?: string;
}

/** 内置命令清单（顺序即菜单顺序）。名称与 i18n 的 chat.commands.<id> 一一对应。 */
export const BUILTIN_SLASH_COMMANDS: readonly BuiltinSlashDescriptor[] = [
  { id: "plan", kind: "toggle" },
  { id: "speed", kind: "toggle" },
  { id: "test", kind: "template", templateKey: "chat.commands.test.template" },
  { id: "report", kind: "template", templateKey: "chat.commands.report.template" },
  { id: "review", kind: "template", templateKey: "chat.commands.review.template" },
  { id: "search", kind: "template", templateKey: "chat.commands.search.template" },
  { id: "genui", kind: "template", templateKey: "chat.commands.genui.template" },
];

export interface SlashCommandItem {
  /** "builtin:plan" | "acp:<name>"。 */
  id: string;
  /** 展示与发送都不带 "/"。 */
  name: string;
  description: string;
  source: SlashCommandSource;
  builtinKind?: BuiltinSlashKind;
  templateKey?: string;
  /** ACP input.hint：该命令后面要跟一段自由文本参数。 */
  hint?: string;
  requiresInput: boolean;
  /** toggle 命令当前是否已开启（菜单里打勾）。 */
  active?: boolean;
}

/**
 * 触发判定：整段草稿是「/命令词」形态才返回查询串（不含首个 /），否则 null。
 * 只认行首且未输入空格——`hello /pl`、`/a b`、多行文本都不弹菜单，
 * 避免把正文里的路径、竖线误判成命令。
 */
export function matchSlashQuery(draft: string): string | null {
  const match = /^\/(\S*)$/.exec(draft);
  return match ? (match[1] ?? "") : null;
}

/** 名称前缀过滤，大小写不敏感；空查询返回全部。 */
export function filterSlashCommands(items: readonly SlashCommandItem[], query: string): SlashCommandItem[] {
  const needle = query.replace(/^\/+/, "").toLowerCase();
  if (!needle) return [...items];
  return items.filter((item) => item.name.toLowerCase().startsWith(needle));
}

function readHint(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const hint = (input as Record<string, unknown>).hint;
  return typeof hint === "string" && hint.trim() ? hint.trim() : undefined;
}

/**
 * 宿主透传的 availableCommands 防御式归一化：脏条目丢弃而不是整批报废
 * （ACP schema 对非法条目也是 default-on-error）。name 至多剥一个前导 "/"，
 * 兼容「带斜杠 / 不带斜杠」两种自述习惯；含空白或重名的丢弃。
 */
export function normalizeAcpCommands(raw: unknown): AcpAvailableCommand[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const commands: AcpAvailableCommand[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== "string" || typeof record.description !== "string") continue;
    const name = record.name.trim().replace(/^\//, "");
    if (!name || /\s/.test(name) || seen.has(name)) continue;
    seen.add(name);
    const description = record.description.trim();
    const hint = readHint(record.input);
    commands.push(hint ? { name, description, input: { hint } } : { name, description });
  }
  return commands;
}

/**
 * 合并内置命令与 ACP 命令（内置在前）。名称撞车时内置优先：同名时用户意图更可能是
 * 本地动作（如 /plan），agent 的同名命令仍可直接手输发送。
 */
export function buildSlashItems(opts: {
  t: (key: string) => string;
  acpCommands: readonly AcpAvailableCommand[];
  routeToAcp: boolean;
  planMode: boolean;
  speedBoost: boolean;
}): SlashCommandItem[] {
  const items: SlashCommandItem[] = BUILTIN_SLASH_COMMANDS.map((command) => {
    const active = command.id === "plan" ? opts.planMode : command.id === "speed" ? opts.speedBoost : undefined;
    const item: SlashCommandItem = {
      id: `builtin:${command.id}`,
      name: command.id,
      description: opts.t(`chat.commands.${command.id}.desc`),
      source: "builtin",
      builtinKind: command.kind,
      requiresInput: false,
    };
    if (command.templateKey) item.templateKey = command.templateKey;
    if (active !== undefined) item.active = active;
    return item;
  });
  if (!opts.routeToAcp) return items;

  const taken = new Set(items.map((item) => item.name));
  for (const command of opts.acpCommands) {
    if (taken.has(command.name)) continue;
    taken.add(command.name);
    const item: SlashCommandItem = {
      id: `acp:${command.name}`,
      name: command.name,
      description: command.description,
      source: "acp",
      requiresInput: Boolean(command.input?.hint),
    };
    if (command.input?.hint) item.hint = command.input.hint;
    items.push(item);
  }
  return items;
}

/** option 元素的稳定 DOM id（aria-activedescendant 用），非标识字符压成 "-"。 */
export function slashOptionId(item: SlashCommandItem): string {
  return `slash-option-${item.id.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
}
