/**
 * 本机模型 agent 回合：让 OpenAI 兼容端点上的模型能用工具，而不必装外部 ACP agent。
 * 移植 crates/greywork-host/src/services/llm/agent/（mod + runner + tools）。
 *
 * 与纯聊天（llm.ts::LlmStreamHost）的关系：大脑是用户自己的模型端点，工具面由宿主
 * 提供**并在自己的授权面内执行** —— 只读三件套（读文件 / 列目录 / 最近提交），
 * 全部复用 WorkspaceAccess 与 gitLog，不存在第二套 allow-list。因此无需交互式
 * 权限确认，循环可以在宿主侧自主推进。
 *
 * 两个必须显式处理的协议细节（与 Rust 同款）：
 * - arguments 可能不是合法 JSON：解析失败就回空对象让 executeTool 报错，模型重发；
 * - 触顶后要收尾回合：追加一次 tool_choice 为 none 的收尾请求，而不是直接掐断。
 */
import { authHeaders, endpointUrl, resolveApiKey, truncate, type LlmChatMessage } from "./llm.js";
import path from "node:path";

import type { AgentMcpServer, McpToolBinding } from "./agent-mcp.js";
import { callMcpTool, mcpToolSchemas, resolveMcpTools } from "./agent-mcp.js";
import { listSkills, readSkill, skillIndexPrompt } from "./agent-skills.js";
import { gitDiff, gitLog, gitStatus } from "./git.js";
import { shellRun } from "./shell-run.js";
import type { EventBus } from "./events.js";
import type { WorkspaceAccess } from "./workspace-access.js";

/** 连接挂着但长时间无字节，按错误终止（与纯聊天路径同源的空闲超时）。 */
const IDLE_TIMEOUT_MS = 60_000;

/** 写操作确认窗口（ms）：与 ACP 权限卡同一 120s，超时按拒绝处理。 */
const PERMISSION_CONFIRM_TIMEOUT_MS = 120_000;

/** 工具回合的默认上限（12 轮覆盖典型的「摸现状 → 定位 → 交叉验证」长路径）。 */
export const DEFAULT_MAX_ROUNDS = 12;

/** 回合硬上限：调用方可传更大的值，但不能没有。 */
export const HARD_MAX_ROUNDS = 32;

/** 单次工具输出送进模型上下文的字符上限（12k 字符 ≈ 3-4k token）。 */
const MAX_TOOL_OUTPUT_CHARS = 12_000;

/** 上下文预算：默认 32k tokens（多数本地/云模型的常用窗口），可由 contextTokens 覆盖。 */
const DEFAULT_CONTEXT_TOKENS = 32_000;
const MIN_CONTEXT_TOKENS = 4_000;
/**
 * 保留最近的**工具结果**条数不变（不是最近的 N 条消息）。
 * 按消息条数保护会被 tool/assistant 成对结构稀释：三次读文件就占满 6 条，
 * 结果一条都折不了，预算形同虚设。
 */
const KEEP_RECENT_TOOL_MESSAGES = 2;
/** 折叠后保留的开头字符数（够模型认出「这是哪次调用的结果」）。 */
const FOLDED_PREFIX_CHARS = 300;
/** 折叠标记：重复折叠时据此跳过，避免把占位符再折一次。 */
const FOLDED_MARK = "[较早的工具结果已折叠]";
/** git_log 默认返回条数。 */
const DEFAULT_GIT_LOG_LIMIT = 20;
/** 目录列举的条目数上限。 */
const MAX_DIR_ENTRIES = 200;

/** search_text：跳过的目录（依赖/产物/版本库，扫它们只会烧上下文）。 */
const SEARCH_IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  ".turbo",
  ".cache",
]);
/** 单次搜索扫过的文件数上限与命中数上限。 */
const MAX_SEARCH_FILES = 2000;
const MAX_SEARCH_MATCHES = 80;
/** 跳过超大文件（生成的 JSON / 压缩包对定位没帮助）。 */
const MAX_SEARCH_FILE_BYTES = 512 * 1024;

/** 一个可尝试的供应商（多供应商配置里的单个元素）。 */
export interface AgentProviderTarget {
  baseUrl: string;
  model: string;
  apiKeyEnv?: string | null;
  headers?: Record<string, string> | null;
  temperature?: number | null;
  maxTokens?: number | null;
  reasoningEffort?: string | null;
  /** 该供应商的上下文窗口（tokens）；缺省沿用全局预算。 */
  contextTokens?: number | null;
}

/** 内部用的归一化供应商（字段都已落成非空/显式 null）。 */
interface ProviderTarget {
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  headers: Record<string, string>;
  temperature: number | null;
  maxTokens: number | null;
  reasoningEffort: string;
  contextTokens: number | null;
}

/**
 * 这些失败值得换供应商再试一次：网络错误、鉴权（可能只有主供应商的 key 过期）、
 * 限流、5xx。400（请求体不合法，常见是端点不支持 tool calling）不切换 —— 换一家
 * 只会用同样的 payload 再撞一次。
 */
export function canFailover(status: number): boolean {
  if (status === 0) return true;
  return status === 401 || status === 403 || status === 408 || status === 425 || status === 429 || status >= 500;
}

export interface AgentStartArgs {
  baseUrl: string;
  model: string;
  apiKeyEnv?: string | null;
  messages: LlmChatMessage[];
  reasoningEffort?: string | null;
  headers?: Record<string, string> | null;
  temperature?: number | null;
  maxTokens?: number | null;
  maxRounds?: number | null;
  clientToken?: string | null;
  /**
   * 本轮的工作区根（绝对路径）。缺省 = 授权面默认根（~/.greyWork）。
   * 传了就必须在授权面内 —— 宿主不会因为「是模型要求的」就放宽。
   */
  cwd?: string | null;
  /**
   * 权限档位（read-only / workspace / full）：决定写工具是否暴露、是否弹确认。
   * 缺省 = read-only（宿主不替用户放宽）。
   */
  permissionTier?: string | null;
  /** 已启用的 MCP 服务器（与 ACP 会话用的是同一份配置）。 */
  mcpServers?: AgentMcpServer[] | null;
  /** 上下文预算（tokens）；缺省 32000，低于 4000 按 4000 兜底。 */
  contextTokens?: number | null;
  /**
   * 多供应商：按顺序尝试，主供应商失败（网络/401/429/5xx）时自动切下一个。
   * 给了就以它为准（第一项视为主供应商）；没给则退化成单供应商（baseUrl/model 那套字段）。
   */
  providers?: AgentProviderTarget[] | null;
}

interface AgentTurn {
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  messages: Record<string, unknown>[];
  reasoningEffort: string;
  headers: Record<string, string>;
  temperature: number | null;
  maxTokens: number | null;
  maxRounds: number;
  clientToken: string;
  cwd: string;
  /** 本回合的写操作策略（由权限档位映射）。 */
  policy: ToolPolicy;
  /** 本回合要接入的 MCP 服务器（来自渲染端的已启用清单）。 */
  mcpServers: AgentMcpServer[];
  /** 探测到的 MCP 工具（drive 开始时解析，toolSchemas 与调用都读它）。 */
  mcpTools: McpToolBinding[];
  /** 本回合**当前生效**的上下文预算（tokens）：切换供应商时跟着换。 */
  contextTokens: number;
  /** 全局预算（供应商没单独给时用它）。 */
  defaultContextTokens: number;
  /** 本回合可尝试的供应商（有序），以及当前正在用的下标。 */
  providers: ProviderTarget[];
  activeProvider: number;
  /** 本回合还没裁决的写请求，回合中止时统一按拒绝收场。 */
  pendingPermissions: Set<number>;
}

interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface ToolOutput {
  content: string;
  error: string | null;
  summary: string;
  path: string | null;
}

/* ===== 工具的 openai function schema ===== */

/** 写/执行操作的放行策略：由权限档位决定（read-only / workspace / full）。 */
export interface ToolPolicy {
  write: "deny" | "ask" | "auto";
  /**
   * 命令执行：只在本机可信宿主 + full 档位给 "ask"（每次都要确认），
   * 其它情况一律 "deny" —— 与 shell_run 的 TRUSTED_HOST_ONLY 同口径。
   */
  shell: "deny" | "ask";
  /** MCP 工具：read-only 不暴露，workspace 每次确认，full 直接放行。 */
  mcp: "deny" | "ask" | "auto";
  /** 询问用户是否允许这次写入/执行；拒绝或超时都返回 false。 */
  confirm(request: {
    title: string;
    paths: string[];
    diff: string;
    command?: string;
    kind?: "edit" | "execute" | "tool";
  }): Promise<boolean>;
}

/** 缺省策略：不允许写也不允许执行（其它调用方与单测拿到的都是这个安全默认）。 */
export const DEFAULT_TOOL_POLICY: ToolPolicy = {
  write: "deny",
  shell: "deny",
  mcp: "deny",
  confirm: async () => false,
};

/**
 * 粗略 token 估算：ASCII 约 4 字符/token，非 ASCII（中文等）约 1 字符/token。
 * 不用真 tokenizer —— 这里只做「预算护栏」，估偏 20% 不影响正确性，只影响折叠的早晚。
 */
export function estimateContextTokens(value: string): number {
  let ascii = 0;
  let other = 0;
  for (const char of value) {
    if (char.charCodeAt(0) < 128) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 4) + other;
}

function messageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  return JSON.stringify(content);
}

/**
 * 超预算时就地折叠较早的工具结果（返回折叠条数）。
 *
 * 三条硬约束：
 * - **只折叠、不删除**：tool_call 与 tool 消息必须成对，删一条就会被端点判 400；
 * - 只动 role=tool 的内容：assistant 的 tool_calls、system、user 一律不碰；
 * - 最近的 KEEP_RECENT_MESSAGES 条保持原样，当前推理链不被截断。
 */
export function compactHistory(history: Record<string, unknown>[], budgetTokens: number): number {
  const budget = Math.max(budgetTokens, MIN_CONTEXT_TOKENS);
  let total = 0;
  for (const message of history) total += estimateContextTokens(messageText(message)) + 8;
  if (total <= budget) return 0;
  let folded = 0;
  const toolIndexes = history.map((message, index) => (message.role === "tool" ? index : -1)).filter((index) => index >= 0);
  const protectedIndexes = new Set(toolIndexes.slice(-KEEP_RECENT_TOOL_MESSAGES));
  for (let index = 0; index < history.length && total > budget; index += 1) {
    const message = history[index];
    if (message.role !== "tool" || protectedIndexes.has(index)) continue;
    const text = messageText(message);
    if (text.startsWith(FOLDED_MARK)) continue;
    const head = [...text].slice(0, FOLDED_PREFIX_CHARS).join("");
    const replacement = FOLDED_MARK + " " + head + (head.length < text.length ? " …" : "");
    const saved = estimateContextTokens(text) - estimateContextTokens(replacement);
    message.content = replacement;
    total -= saved;
    folded += 1;
  }
  return folded;
}

/** 行级 diff（公共前后缀裁剪）：够给用户看清改了哪几行，不做完整 LCS。 */
export function lineDiff(before: string, after: string): string {
  if (before === after) return "（内容无变化）";
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  const budget = 40;
  const rows: string[] = [];
  if (prefix > 0) rows.push("  … 前 " + prefix + " 行未变");
  for (const line of removed.slice(0, budget)) rows.push("- " + line);
  for (const line of added.slice(0, budget)) rows.push("+ " + line);
  if (removed.length > budget || added.length > budget) rows.push("  … 改动过长，已截断");
  return rows.join("\n");
}

/** 权限档位 → 写策略。缺省（没传/不认识）按只读处理，宿主不替用户放宽。 */
function resolvePermission(tier: string | null | undefined): "deny" | "ask" | "auto" {
  const value = (tier ?? "").trim();
  if (value === "full") return "auto";
  if (value === "workspace") return "ask";
  return "deny";
}

/** 文件不存在/不是文本时给 null（写操作会整体覆盖，不关心旧内容）。 */
function readTextOrNull(access: WorkspaceAccess, target: string): string | null {
  try {
    return access.readTextFile(target);
  } catch {
    return null;
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function diffStat(before: string, after: string): string {
  let added = 0;
  let removed = 0;
  for (const row of lineDiff(before, after).split("\n")) {
    if (row.startsWith("+ ")) added += 1;
    else if (row.startsWith("- ")) removed += 1;
  }
  return "（+" + added + "/-" + removed + " 行）";
}

/** 写之前的闸门：deny 直接拒，ask 弹确认卡，auto 放行。返回非 null = 这次调用失败。 */
async function gateWrite(policy: ToolPolicy, relative: string, before: string, after: string, target: string): Promise<ToolOutput | null> {
  if (policy.write === "deny") {
    return failed("当前权限档位是只读，不能写文件（设置 → 运行模式 可调整）。把改动写进回复，让用户自己应用。", target);
  }
  if (policy.write === "auto") {
    return null;
  }
  const allowed = await policy.confirm({
    title: "写入 " + relative,
    paths: [relative],
    diff: lineDiff(before, after),
  });
  return allowed ? null : failed("用户拒绝了这次写入：" + relative, target);
}

function toolSchemas(allowWrite: boolean, allowShell: boolean, mcpSchemas: Record<string, unknown>[]): Record<string, unknown>[] {
  return [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "读取工作区内一个文本文件的全文。用于查看源码、配置、文档。路径相对于工作区根，也可给绝对路径。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "文件路径，相对工作区根或绝对路径。必须是文本文件。" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_dir",
        description: "列出工作区内一个目录的直接子项（文件与子目录）。用于先摸清结构再决定读哪个文件。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "目录路径，省略时列工作区根目录。" },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "git_log",
        description: "读取工作区的最近提交历史（哈希、作者、时间、标题）。用于了解近期改了什么。",
        parameters: {
          type: "object",
          properties: {
            limit: { type: "integer", description: "返回条数，默认 20。" },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_text",
        description:
          "在工作区里按关键字搜索文本，返回「文件:行号: 内容」。这是定位代码的第一手段：先用它找到出处，再 read_file 读全文。默认跳过 node_modules / dist / target 等目录。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "要搜的文本；默认按字面量匹配（不区分大小写）。" },
            path: { type: "string", description: "限定搜索的子目录，省略时搜整个工作区。" },
            regex: { type: "boolean", description: "为 true 时把 query 当正则表达式解析。" },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_skill",
        description: "读取工作区里一份技能的完整说明（SKILL.md）。系统提示里只列了技能名与一句话说明，需要按某个技能做事时先读它。",
        parameters: {
          type: "object",
          properties: {
            skill_id: { type: "string", description: "技能 id（即 .agents/skills 下的目录名）。" },
          },
          required: ["skill_id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "git_status",
        description: "列出工作区未提交的改动（新增 / 修改 / 删除 / 未跟踪）。先看它再决定 diff 哪个文件。",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    {
      type: "function",
      function: {
        name: "git_diff",
        description: "读取工作区未提交改动的 diff 文本。可只取一个文件，也可看已暂存（staged）的版本。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "只看这个文件（相对工作区根）。" },
            staged: { type: "boolean", description: "为 true 时看暂存区（--cached）。" },
          },
          required: [],
        },
      },
    },
    ...(allowWrite ? writeToolSchemas() : []),
    ...(allowShell ? shellToolSchemas() : []),
    ...mcpSchemas,
  ];
}

/** 命令执行：只在「本机可信宿主 + full 档位」暴露，且每次都要用户点头。 */
function shellToolSchemas(): Record<string, unknown>[] {
  return [
    {
      type: "function",
      function: {
        name: "run_shell",
        description:
          "在工作区目录里执行一条命令（跑测试、看构建输出、查 git 状态等）。非交互：不要用它开 vim/top 这类 TUI。每次执行都要用户确认。",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "要执行的命令（整条传给 shell）。" },
            timeout_secs: { type: "integer", description: "超时秒数，默认 120，上限 900。" },
          },
          required: ["command"],
        },
      },
    },
  ];
}

/**
 * 写工具只在非只读档位下暴露：模型看不到就不会去试。
 * 真正落盘前还要过 {@link ToolPolicy}（ask 档位会弹确认卡）。
 */
function writeToolSchemas(): Record<string, unknown>[] {
  return [
    {
      type: "function",
      function: {
        name: "write_file",
        description:
          "把内容写入工作区里的文件（不存在则新建，存在则整体覆盖）。适合新建文件；改已有文件优先用 edit_file，避免把没读过的内容覆盖掉。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "文件路径（相对工作区根）。" },
            content: { type: "string", description: "完整文件内容。" },
          },
          required: ["path", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "edit_file",
        description: "按文本替换修改一个已存在的文件：old_text 必须在文件里唯一出现（否则用 replace_all）。改之前先 read_file 看清原文。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "文件路径（相对工作区根）。" },
            old_text: { type: "string", description: "要被替换的原文，必须逐字匹配（含缩进）。" },
            new_text: { type: "string", description: "替换后的内容；空串表示删除这段。" },
            replace_all: { type: "boolean", description: "为 true 时替换所有出现位置。" },
          },
          required: ["path", "old_text", "new_text"],
        },
      },
    },
  ];
}

/** 按字符截断并**显式标注**省略了多少：静默截断会让模型基于残缺内容自信出错。 */
function clampOutput(value: string): string {
  const chars = [...value];
  if (chars.length <= MAX_TOOL_OUTPUT_CHARS) return value;
  return (
    chars.slice(0, MAX_TOOL_OUTPUT_CHARS).join("") +
    "\n\n[已截断：共 " +
    chars.length +
    " 字符，只保留前 " +
    MAX_TOOL_OUTPUT_CHARS +
    " 字符。需要更多内容请用更小的范围重读]"
  );
}

function failed(error: string, path: string | null): ToolOutput {
  return {
    content: "工具执行失败：" + error,
    error,
    summary: "执行失败",
    path,
  };
}

function argStr(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string") throw new Error("参数 " + key + " 必须是字符串");
  if (value.trim() === "") throw new Error("参数 " + key + " 是空字符串，请给出实际路径");
  return value;
}

/** 把模型给的路径锚成绝对路径：相对的挂在工作区根下（.. 交给 resolveExisting 拦）。 */
function anchorToRoot(cwd: string, raw: string): string {
  if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) return raw;
  return path.join(cwd, raw.replace(/^[\\/]+/, ""));
}

/**
 * 解析本轮工作区根：给了就必须是**已授权且存在**的目录（listDir 走 resolveExisting，
 * 越界或不存在直接抛错）；没给回落到授权面默认根。
 */
/** 归一化供应商列表：给了 providers 就用它，否则退化成单供应商。 */
function normalizeProviders(args: AgentStartArgs): ProviderTarget[] {
  const raw = (args.providers ?? []).filter(
    (item) =>
      item !== null &&
      typeof item === "object" &&
      typeof item.baseUrl === "string" &&
      item.baseUrl.trim() !== "" &&
      typeof item.model === "string" &&
      item.model.trim() !== "",
  );
  const source: AgentProviderTarget[] =
    raw.length > 0
      ? raw
      : [
          {
            baseUrl: args.baseUrl,
            model: args.model,
            apiKeyEnv: args.apiKeyEnv,
            headers: args.headers,
            temperature: args.temperature,
            maxTokens: args.maxTokens,
            reasoningEffort: args.reasoningEffort,
          },
        ];
  return source.map((item) => ({
    baseUrl: item.baseUrl.trim(),
    model: item.model.trim(),
    apiKeyEnv: item.apiKeyEnv ?? "",
    headers: item.headers ?? {},
    temperature: typeof item.temperature === "number" ? item.temperature : null,
    maxTokens: typeof item.maxTokens === "number" ? item.maxTokens : null,
    reasoningEffort: item.reasoningEffort ?? "",
    contextTokens: typeof item.contextTokens === "number" ? item.contextTokens : null,
  }));
}

/** 把第 index 个供应商的字段摊到 turn 上（后续请求体/鉴权都读这些字段）。 */
function applyProvider(turn: AgentTurn, index: number): void {
  const target = turn.providers[index];
  turn.activeProvider = index;
  turn.baseUrl = target.baseUrl;
  turn.model = target.model;
  turn.apiKeyEnv = target.apiKeyEnv;
  turn.headers = target.headers;
  turn.temperature = target.temperature;
  turn.maxTokens = target.maxTokens;
  turn.reasoningEffort = target.reasoningEffort;
  // 上下文窗口按模型走：切换供应商时预算跟着换，别用小模型的额度去压大模型。
  turn.contextTokens = Math.max(target.contextTokens ?? turn.defaultContextTokens, MIN_CONTEXT_TOKENS);
}

function resolveCwd(access: WorkspaceAccess, raw: string | null | undefined): string {
  const candidate = (raw ?? "").trim();
  if (candidate === "") return access.root;
  access.listDir(candidate);
  return candidate.replace(/[\\/]+$/, "");
}

function optionalLimit(input: Record<string, unknown>): number | null {
  const value = input.limit;
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error("参数 limit 必须是正整数");
  }
  return value;
}

/** 执行一次工具调用。未知工具名返回错误而不是崩掉回合：模型经常编造工具名。 */
interface SearchResult {
  lines: string[];
  files: number;
  hits: number;
  truncated: boolean;
}

/**
 * 在工作区里逐文件扫关键字。返回「相对路径:行号: 内容」——
 * 模型拿到这种行能直接定位，不用再猜文件名。
 *
 * 三个防爆走样的闸门：跳过依赖/产物目录、单文件 ≤512KB、命中与文件数都有上限。
 * 另用 visited 挡住软链接成环（目录项已解析过链接，环会表现为重复路径）。
 */
function searchWorkspace(
  access: WorkspaceAccess,
  root: string,
  query: string,
  options: { regex: boolean; maxMatches: number },
): SearchResult {
  let matcher: RegExp;
  try {
    matcher = new RegExp(options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  } catch (error) {
    throw new Error("正则表达式不合法：" + (error as Error).message, { cause: error });
  }
  const lines: string[] = [];
  const visited = new Set<string>();
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  visited.add(root);
  let files = 0;
  let hits = 0;
  let truncated = false;
  while (queue.length > 0 && !truncated) {
    const current = queue.shift();
    if (!current) break;
    const entries = access.listDir(current.dir);
    for (const entry of entries) {
      if (truncated) break;
      if (entry.kind === "directory") {
        if (SEARCH_IGNORED_DIRS.has(entry.name) || current.depth >= 24 || visited.has(entry.path)) continue;
        visited.add(entry.path);
        queue.push({ dir: entry.path, depth: current.depth + 1 });
        continue;
      }
      if (entry.size === null || entry.size > MAX_SEARCH_FILE_BYTES) continue;
      if (files >= MAX_SEARCH_FILES) {
        truncated = true;
        break;
      }
      files += 1;
      let text: string;
      try {
        text = access.readTextFile(entry.path);
      } catch {
        // 二进制 / 无权限 / 编码不合法：按「不是文本」跳过，不打断整次搜索。
        continue;
      }
      const relative = path.relative(root, entry.path) || entry.name;
      const rows = text.split("\n");
      for (let index = 0; index < rows.length; index += 1) {
        if (!matcher.test(rows[index])) continue;
        hits += 1;
        lines.push(relative + ":" + (index + 1) + ": " + rows[index].trim().slice(0, 200));
        if (hits >= options.maxMatches) {
          truncated = true;
          break;
        }
      }
    }
  }
  return { lines, files, hits, truncated };
}

/**
 * 工具执行入口。导出是为了单测能直接喂工具名/入参，
 * 不用起一个假模型端点绕整圈（整圈的协议细节另有覆盖）。
 */
export async function executeTool(
  access: WorkspaceAccess,
  cwd: string,
  name: string,
  input: Record<string, unknown>,
  policy: ToolPolicy = DEFAULT_TOOL_POLICY,
  mcpTools: McpToolBinding[] = [],
): Promise<ToolOutput> {
  try {
    if (name === "read_file") {
      const path = anchorToRoot(cwd, argStr(input, "path"));
      const text = access.readTextFile(path);
      return {
        content: clampOutput(text),
        error: null,
        summary: "读取 " + path + "（" + [...text].length + " 字符）",
        path,
      };
    }
    if (name === "list_dir") {
      const path = input.path === undefined || input.path === null ? cwd : anchorToRoot(cwd, argStr(input, "path"));
      const entries = access.listDir(path);
      const total = entries.length;
      const shown = Math.min(total, MAX_DIR_ENTRIES);
      let text = "";
      for (const entry of entries.slice(0, shown)) {
        // 目录带尾斜杠：模型据此区分「这是个能进去的目录」还是「同名文件」。
        text += entry.kind === "directory" ? entry.name + "/\n" : entry.name + "\n";
      }
      if (total > shown) {
        text += "\n[已截断：共 " + total + " 项，只列前 " + shown + " 项。缩小 path 再看剩余部分]";
      }
      return { content: text, error: null, summary: "列出 " + path + "（" + total + " 项）", path };
    }
    if (name === "git_log") {
      const limit = optionalLimit(input) ?? DEFAULT_GIT_LOG_LIMIT;
      const root = cwd;
      const commits = await gitLog(access, root, limit, null);
      if (commits.length === 0) {
        return {
          content: "这个工作区没有提交历史（可能不是 git 仓库，或仓库还没有任何提交）。",
          error: null,
          summary: "读取提交历史（空）",
          path: root,
        };
      }
      let text = "";
      for (const commit of commits) {
        // 一行一提交：哈希 / 相对时间 / 作者 / 主题。refs 带上是因为「这条提交在哪个分支上」常常就是线索。
        const refs = commit.refs === "" ? "" : " (" + commit.refs + ")";
        text += commit.shortHash + " " + commit.timestamp + refs + " " + commit.author + " — " + commit.subject + "\n";
      }
      return { content: text, error: null, summary: "读取最近 " + limit + " 条提交（" + commits.length + " 条）", path: root };
    }
    if (name === "search_text") {
      const query = argStr(input, "query");
      if (query.trim() === "") {
        return failed("search_text 需要非空的 query", null);
      }
      const base = input.path === undefined || input.path === null || input.path === "" ? cwd : anchorToRoot(cwd, argStr(input, "path"));
      // 先探一下目录：路径不存在要报错，而不是「搜到 0 条」让模型误以为文件里没有。
      access.listDir(base);
      const found = searchWorkspace(access, base, query, {
        regex: input.regex === true,
        maxMatches: MAX_SEARCH_MATCHES,
      });
      if (found.hits === 0) {
        return {
          content: `没有命中。已扫 ${found.files} 个文件（跳过依赖/产物目录）。可以换关键字，或先用 list_dir 摸结构。`,
          error: null,
          summary: '搜索 "' + query + '"（0 条 / ' + found.files + " 个文件）",
          path: base,
        };
      }
      let text = found.lines.join("\n");
      if (found.truncated) {
        text += "\n\n[已截断：命中数达到上限 " + MAX_SEARCH_MATCHES + " 条。缩小 path 或换更具体的关键字]";
      }
      return {
        content: clampOutput(text),
        error: null,
        summary: '搜索 "' + query + '"（' + found.hits + " 条 / " + found.files + " 个文件）",
        path: base,
      };
    }
    if (name === "read_skill") {
      const id = argStr(input, "skill_id");
      const skill = readSkill(access, cwd, id);
      const files = skill.files.length > 0 ? "\n\n（该技能目录下的文件：" + skill.files.join("、") + "）" : "";
      return {
        content: clampOutput(skill.text + files),
        error: null,
        summary: "读取技能 " + id,
        path: path.join(cwd, ".agents", "skills", id),
      };
    }
    if (name === "git_status") {
      const items = await gitStatus(access, cwd);
      if (items.length === 0) {
        return {
          content: "工作区没有未提交的改动。",
          error: null,
          summary: "读取改动清单（干净）",
          path: cwd,
        };
      }
      const shown = items.slice(0, MAX_DIR_ENTRIES);
      const text = shown.map((item) => item.status + " " + (item.staged ? "[已暂存] " : "") + item.path).join("\n");
      return {
        content: clampOutput(text),
        error: null,
        summary: "读取改动清单（" + items.length + " 项）",
        path: cwd,
      };
    }
    if (name === "git_diff") {
      const filePath = input.path === undefined || input.path === null || input.path === "" ? null : argStr(input, "path");
      const staged = input.staged === true;
      const text = await gitDiff(access, cwd, filePath, staged);
      if (text.trim() === "") {
        return {
          content: "没有可显示的 diff（未跟踪的新文件不会出现在 git diff 里；已暂存的改动需要 staged=true）。",
          error: null,
          summary: "读取 diff（空）",
          path: filePath === null ? cwd : filePath,
        };
      }
      return {
        content: clampOutput(text),
        error: null,
        summary: "读取 diff（" + [...text].length + " 字符" + (staged ? "，暂存区" : "") + "）",
        path: filePath === null ? cwd : filePath,
      };
    }
    if (name === "write_file") {
      const target = anchorToRoot(cwd, argStr(input, "path"));
      const content = typeof input.content === "string" ? input.content : "";
      const relative = path.relative(cwd, target) || target;
      const before = readTextOrNull(access, target);
      const verdict = await gateWrite(policy, relative, before ?? "", content, target);
      if (verdict !== null) {
        return verdict;
      }
      access.writeTextFile(target, content);
      const diff = lineDiff(before ?? "", content);
      return {
        content: "已写入 " + relative + "\n\n" + diff,
        error: null,
        summary: "写入 " + relative + diffStat(before ?? "", content),
        path: target,
      };
    }
    if (name === "edit_file") {
      const target = anchorToRoot(cwd, argStr(input, "path"));
      const oldText = argStr(input, "old_text");
      const newText = typeof input.new_text === "string" ? input.new_text : "";
      const replaceAll = input.replace_all === true;
      const relative = path.relative(cwd, target) || target;
      if (oldText === "") {
        return failed("edit_file 的 old_text 不能为空；要新建文件用 write_file", target);
      }
      const before = access.readTextFile(target);
      const occurrences = countOccurrences(before, oldText);
      if (occurrences === 0) {
        return failed("old_text 在文件里逐字匹配不到（注意缩进、换行与全角半角）。先 read_file 看清原文再改。", target);
      }
      if (occurrences > 1 && !replaceAll) {
        return failed("old_text 在文件里出现了 " + occurrences + " 次，无法确定改哪一处；扩大上下文，或显式传 replace_all。", target);
      }
      const after = replaceAll ? before.split(oldText).join(newText) : before.replace(oldText, newText);
      const verdict = await gateWrite(policy, relative, before, after, target);
      if (verdict !== null) {
        return verdict;
      }
      access.writeTextFile(target, after);
      const diff = lineDiff(before, after);
      return {
        content: "已修改 " + relative + "\n\n" + diff,
        error: null,
        summary: "修改 " + relative + diffStat(before, after),
        path: target,
      };
    }
    if (name === "run_shell") {
      if (policy.shell === "deny") {
        return failed("当前不允许执行命令：需要 设置 → 运行模式 的 full 档位，且必须是本机可信宿主（服务端模式不开放）。", cwd);
      }
      const command = argStr(input, "command").trim();
      if (command === "") {
        return failed("run_shell 需要非空 command", cwd);
      }
      if (command.length > 2000) {
        return failed("命令过长（上限 2000 字符）；把它写成脚本文件再用 run_shell 执行", cwd);
      }
      const rawTimeout = input.timeout_secs;
      const timeoutSecs =
        typeof rawTimeout === "number" && Number.isFinite(rawTimeout) ? Math.min(Math.max(Math.floor(rawTimeout), 5), 900) : 120;
      const allowed = await policy.confirm({
        title: "执行命令",
        paths: [cwd],
        diff: "",
        command,
        kind: "execute",
      });
      if (!allowed) {
        return failed("用户拒绝了这条命令：" + command, cwd);
      }
      const result = await shellRun(command, cwd, timeoutSecs * 1000);
      const footer = result.timedOut ? "已超时（" + timeoutSecs + "s）" : "退出码 " + String(result.exitCode);
      const header = "$ " + command + "\n（" + footer + "，" + (result.durationMs / 1000).toFixed(1) + "s）";
      const body = result.output.trim() === "" ? "（无输出）" : result.output;
      return {
        content: clampOutput(header + "\n\n" + body + (result.truncated ? "\n\n[输出已截断]" : "")),
        error: result.timedOut ? "命令超时" : result.exitCode === 0 ? null : "命令退出码 " + String(result.exitCode),
        summary: "执行命令（" + footer + "）：" + truncate(command, 60),
        path: cwd,
      };
    }
    const binding = mcpTools.find((candidate) => candidate.toolName === name);
    if (binding) {
      if (policy.mcp === "deny") {
        return failed("当前档位不允许调用 MCP 工具（只读档位）。需要时让用户切到 workspace / full。", cwd);
      }
      if (policy.mcp === "ask") {
        const allowed = await policy.confirm({
          title: "调用 " + binding.server.name + " / " + binding.tool,
          paths: [],
          diff: "",
          command: binding.tool + " " + JSON.stringify(input),
          kind: "tool",
        });
        if (!allowed) {
          return failed("用户拒绝了这次 MCP 调用：" + binding.server.name + "/" + binding.tool, cwd);
        }
      }
      try {
        const report = await callMcpTool(binding, input);
        return {
          content: clampOutput(report.text.trim() === "" ? "（工具没有返回文本）" : report.text),
          error: report.isError ? "MCP 工具返回错误" : null,
          summary: "调用 " + binding.server.name + "/" + binding.tool,
          path: cwd,
        };
      } catch (error) {
        return failed("MCP 调用失败：" + (error as Error).message, cwd);
      }
    }
    if (name === "") {
      return failed("这次调用没有工具名（name 为空），请重新发起并指明要用哪个工具", null);
    }
    return failed(
      "没有名为 " +
        name +
        " 的工具。可用工具：read_file（读文本文件）、list_dir（列目录）、search_text（搜关键字）、read_skill（读技能说明）、git_log（最近提交）、git_status（改动清单）、git_diff（改动内容）",
      null,
    );
  } catch (error) {
    return failed((error as Error).message, null);
  }
}

/* ===== SSE 增量与工具调用分片 ===== */

interface SseDelta {
  content: string | null;
  reasoning: string | null;
  toolCallChunks: { index: number; id: string | null; name: string | null; arguments: string | null }[];
}

function parseSseDelta(data: string): SseDelta | null {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
  const choices = value.choices as Record<string, unknown>[] | undefined;
  const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;
  if (!delta) return null;
  const pick = (key: string): string | null => {
    const text = delta[key];
    return typeof text === "string" && text !== "" ? text : null;
  };
  const rawCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
  const toolCallChunks = rawCalls
    .map((chunk) => {
      const record = chunk as { index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } };
      if (typeof record.index !== "number") return null;
      const fn = record.function ?? {};
      return {
        index: record.index,
        id: typeof record.id === "string" && record.id !== "" ? record.id : null,
        name: typeof fn.name === "string" && fn.name !== "" ? fn.name : null,
        arguments: typeof fn.arguments === "string" && fn.arguments !== "" ? fn.arguments : null,
      };
    })
    .filter((chunk): chunk is { index: number; id: string | null; name: string | null; arguments: string | null } => chunk !== null);
  return {
    content: pick("content"),
    reasoning: pick("reasoning_content") ?? pick("reasoning"),
    toolCallChunks,
  };
}

/** 按 index 归位拼接一个回合里的工具调用分片；缺 id / 缺 name 合成兜底。 */
class ToolCallAccumulator {
  private readonly calls = new Map<number, { id: string | null; name: string | null; arguments: string }>();
  private synthSeq = 0;

  push(chunks: { index: number; id: string | null; name: string | null; arguments: string | null }[]): void {
    for (const chunk of chunks) {
      const call = this.calls.get(chunk.index) ?? { id: null, name: null, arguments: "" };
      this.calls.set(chunk.index, call);
      if (chunk.id !== null) call.id = chunk.id;
      if (chunk.name !== null) call.name = chunk.name;
      if (chunk.arguments !== null) call.arguments += chunk.arguments;
    }
  }

  take(): ToolCall[] {
    const indexes = [...this.calls.keys()].sort((a, b) => a - b);
    const out: ToolCall[] = [];
    for (const index of indexes) {
      const call = this.calls.get(index)!;
      this.calls.delete(index);
      const id = call.id ?? "call_synth_" + index + "_" + ++this.synthSeq;
      out.push({ id, name: call.name ?? "", arguments: call.arguments });
    }
    return out;
  }
}

function contentFromCompletion(body: Record<string, unknown>): string {
  const choices = body.choices as Record<string, unknown>[] | undefined;
  const content = (choices?.[0]?.message as Record<string, unknown> | undefined)?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part as { text?: unknown }).text)
      .filter((text): text is string => typeof text === "string")
      .join("");
  }
  return "";
}

function toolCallsFromCompletion(body: Record<string, unknown>): ToolCall[] {
  const choices = body.choices as Record<string, unknown>[] | undefined;
  const items = (choices?.[0]?.message as Record<string, unknown> | undefined)?.tool_calls;
  if (!Array.isArray(items)) return [];
  const accumulator = new ToolCallAccumulator();
  accumulator.push(
    items.map((item, index) => {
      const record = item as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
      const fn = record.function ?? {};
      return {
        index,
        id: typeof record.id === "string" && record.id !== "" ? record.id : null,
        name: typeof fn.name === "string" && fn.name !== "" ? fn.name : null,
        arguments: typeof fn.arguments === "string" && fn.arguments !== "" ? fn.arguments : null,
      };
    }),
  );
  return accumulator.take();
}

/* ===== 宿主状态与回合循环 ===== */

function reasoningEffort(value: string): string | null {
  switch (value.trim().toLowerCase()) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "max":
      return "high";
    default:
      return null;
  }
}

/** 本机 agent 回合的宿主状态：请求 id 分配 + 可中止的任务句柄（与纯聊天流独立）。 */
export class LlmAgentHost {
  private nextId = 0;
  private readonly tasks = new Map<number, AbortController>();
  /** 待裁决的写请求：requestId → 结算函数（respond / 超时 / 中止都走 settle）。 */
  private readonly pendingPermissions = new Map<
    number,
    { resolve: (allow: boolean) => void; timer: ReturnType<typeof setTimeout>; turn: AgentTurn }
  >();
  private nextPermissionId = 1;

  constructor(
    private readonly bus: EventBus,
    private readonly access: WorkspaceAccess,
    /** 本机可信宿主：只有它才允许把 run_shell 暴露给模型（与 shell_run 的门禁同口径）。 */
    private readonly options: { trusted?: boolean } = {},
  ) {}

  private emit(token: string, kind: string, payload: Record<string, unknown>): void {
    if (token !== "") payload.clientToken = token;
    this.bus.broadcast("llm://event", { kind, payload });
  }

  /** 发起一个 agent 回合；返回请求 id（用于中止）。参数错误早返回，不 spawn 再报。 */
  start(args: AgentStartArgs): number {
    const baseUrl = args.baseUrl.trim();
    const model = args.model.trim();
    if (baseUrl === "" || model === "") throw new Error("base_url and model are required");
    if (!Array.isArray(args.messages) || args.messages.length === 0) {
      throw new Error("messages 不能为空");
    }
    const requestId = this.nextId++;
    const permission = resolvePermission(args.permissionTier);
    const cwd = resolveCwd(this.access, args.cwd);
    // 全局预算；具体供应商若带自己的 contextTokens，applyProvider 会覆盖生效值。
    const defaultBudget = Math.max(
      typeof args.contextTokens === "number" && Number.isFinite(args.contextTokens)
        ? Math.floor(args.contextTokens)
        : DEFAULT_CONTEXT_TOKENS,
      MIN_CONTEXT_TOKENS,
    );
    const messages = args.messages.map((message) => ({ role: message.role, content: message.content }));
    // 技能索引只放系统提示（id + 名称 + 一句话），正文由模型按需 read_skill。
    const skillIndex = skillIndexPrompt(listSkills(this.access, cwd));
    if (skillIndex !== null) messages.unshift({ role: "system", content: skillIndex });
    const turn: AgentTurn = {
      baseUrl,
      model,
      apiKeyEnv: args.apiKeyEnv ?? "",
      messages,
      reasoningEffort: args.reasoningEffort ?? "",
      headers: args.headers ?? {},
      temperature: args.temperature ?? null,
      maxTokens: args.maxTokens ?? null,
      maxRounds: Math.min(Math.max(args.maxRounds ?? DEFAULT_MAX_ROUNDS, 1), HARD_MAX_ROUNDS),
      clientToken: args.clientToken ?? "",
      cwd,
      pendingPermissions: new Set<number>(),
      mcpServers: args.mcpServers ?? [],
      mcpTools: [],
      providers: normalizeProviders(args),
      activeProvider: 0,
      contextTokens: defaultBudget,
      defaultContextTokens: defaultBudget,
      policy: {
        write: permission,
        // 命令执行比写文件危险一档：只在 full 档 + 可信宿主暴露，且永远逐条确认。
        shell: this.options.trusted === true && permission === "auto" ? "ask" : "deny",
        // MCP 工具：只读档位不暴露；workspace 每次确认；full 放行（与写文件同档）。
        mcp: permission === "auto" ? "auto" : permission === "ask" ? "ask" : "deny",
        confirm: (request) => this.confirmPermission(turn, request),
      },
    };
    // 先把主供应商的字段摊到 turn 上；失败切换时再换。
    applyProvider(turn, 0);
    const controller = new AbortController();
    this.tasks.set(requestId, controller);
    void this.run(turn, controller).finally(() => {
      // 回合结束时自己摘掉句柄：长跑会话不会攒下大量已完成句柄。
      this.tasks.delete(requestId);
    });
    return requestId;
  }

  /** 中止进行中的 agent 回合并回收句柄；挂在确认卡上的写请求按拒绝收场。 */
  stop(requestId: number): void {
    const controller = this.tasks.get(requestId);
    if (!controller) throw new Error("unknown llm agent request " + requestId);
    this.tasks.delete(requestId);
    controller.abort();
    for (const [permissionId, entry] of [...this.pendingPermissions]) {
      if (entry.resolve === undefined) continue;
      if (entry.turn.pendingPermissions.has(permissionId)) this.settlePermission(permissionId, false);
    }
  }

  /** 用户对写请求的裁决；optionId=null/deny 表示拒绝。 */
  respondPermission(requestId: number, optionId: string | null): boolean {
    if (!this.pendingPermissions.has(requestId)) return false;
    this.settlePermission(requestId, optionId === "allow");
    return true;
  }

  /** 结算一次写请求：清超时、移出表、回传结果，并通知前端收卡。 */
  private settlePermission(requestId: number, allow: boolean): void {
    const entry = this.pendingPermissions.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pendingPermissions.delete(requestId);
    entry.turn.pendingPermissions.delete(requestId);
    entry.resolve(allow);
    this.emit(entry.turn.clientToken, "permission-resolved", { requestId, allow });
  }

  /** 写操作前的确认：emit 一张与 ACP 同形的卡，等用户点选或超时。 */
  private confirmPermission(
    turn: AgentTurn,
    request: { title: string; paths: string[]; diff: string; command?: string; kind?: "edit" | "execute" | "tool" },
  ): Promise<boolean> {
    const requestId = this.nextPermissionId++;
    turn.pendingPermissions.add(requestId);
    const settled = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.settlePermission(requestId, false), PERMISSION_CONFIRM_TIMEOUT_MS);
      timer.unref?.();
      this.pendingPermissions.set(requestId, { resolve, timer, turn });
    });
    this.emit(turn.clientToken, "permission-request", {
      requestId,
      sessionId: null,
      auto: false,
      chosen: null,
      toolCallId: "local-" + requestId,
      title: request.title,
      kind: request.kind ?? "edit",
      locations: request.paths,
      options: [
        { optionId: "allow", name: "允许本次写入", kind: "allow_once" },
        { optionId: "deny", name: "拒绝", kind: "reject_once" },
      ],
      // 渲染端据此判断该走 llm_agent_permission_respond 还是 acp_permission_respond。
      source: "llm",
      diff: request.diff,
      // rawInput.command 让卡片能显示「要跑什么」；写入类没有命令，留 diff。
      rawInput: request.command === undefined ? { diff: request.diff } : { command: request.command },
    });
    return settled;
  }

  /** 跑完一个 agent 回合。所有出口都保证发出 llm-done 或 llm-error。 */
  private async run(turn: AgentTurn, controller: AbortController): Promise<void> {
    try {
      await this.drive(turn, controller);
    } catch (error) {
      if (controller.signal.aborted) return;
      this.emit(turn.clientToken, "llm-error", { message: (error as Error).message });
      return;
    }
    if (!controller.signal.aborted) this.emit(turn.clientToken, "llm-done", {});
  }

  /**
   * 发一轮请求，失败时按供应商列表顺序切换重试。
   *
   * 只对「换一家可能就好」的失败切换（见 canFailover）：400 一般是 payload 问题，
   * 换一家会用同样的 body 再撞一次。切换是**粘性**的：本回合后续轮次继续用新供应商。
   */
  private async sendRound(turn: AgentTurn, controller: AbortController, buildBody: () => Record<string, unknown>): Promise<Response> {
    let lastError = "";
    while (true) {
      const body = buildBody();
      let response: Response | null = null;
      try {
        response = await fetch(endpointUrl(turn.baseUrl, "chat/completions"), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...authHeaders(resolveApiKey(turn.apiKeyEnv, turn.baseUrl), turn.headers),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) throw error;
        lastError = "llm request failed: " + (error as Error).message;
      }
      if (response !== null) {
        if (response.ok) return response;
        const text = await response.text().catch(() => "");
        lastError =
          "llm endpoint returned " + response.status + ": " + truncate(text, 200) + "（检查 Base URL 是否正确、本地服务是否在运行）";
        if (!canFailover(response.status)) throw new Error(lastError);
      }
      const next = turn.activeProvider + 1;
      if (next >= turn.providers.length) {
        throw new Error(turn.providers.length > 1 ? lastError + "（已尝试完 " + turn.providers.length + " 个供应商）" : lastError);
      }
      const from = turn.model;
      applyProvider(turn, next);
      console.log("[agent] 供应商 " + from + " 调用失败，切到 " + turn.model + "：" + lastError);
      this.emit(turn.clientToken, "llm-provider-switch", {
        from,
        to: turn.model,
        reason: truncate(lastError, 200),
      });
    }
  }

  private async drive(turn: AgentTurn, controller: AbortController): Promise<void> {
    // MCP 工具要探一次 tools/list（stdio 服务器冷启动会拉起 npx/uvx），结果按配置缓存 10 分钟。
    turn.mcpTools = turn.policy.mcp === "deny" ? [] : await resolveMcpTools(turn.mcpServers);
    const schemas = toolSchemas(turn.policy.write !== "deny", turn.policy.shell !== "deny", mcpToolSchemas(turn.mcpTools));
    const history: Record<string, unknown>[] = [...turn.messages];
    const accumulator = new ToolCallAccumulator();

    // round < maxRounds 是工具回合；最后一轮是收尾回合（tool_choice: none）。
    for (let round = 0; round <= turn.maxRounds; round += 1) {
      // 每轮请求前压一次：工具结果越滚越多，等到撞 400 再处理就来不及了。
      const folded = compactHistory(history, turn.contextTokens);
      if (folded > 0) {
        console.log(`[agent] 上下文超预算，折叠了 ${folded} 条较早的工具结果`);
      }
      // 请求体随「当前供应商」变化：失败切换后要按新供应商的模型/参数重建。
      const buildBody = (): Record<string, unknown> => {
        const body: Record<string, unknown> = {
          model: turn.model,
          stream: true,
          messages: history,
        };
        const effort = reasoningEffort(turn.reasoningEffort);
        if (effort !== null) body.reasoning_effort = effort;
        if (turn.temperature !== null) body.temperature = turn.temperature;
        if (turn.maxTokens !== null) body.max_tokens = turn.maxTokens;
        body.tools = schemas;
        body.tool_choice = round < turn.maxRounds ? "auto" : "none";
        return body;
      };

      const response = await this.sendRound(turn, controller, buildBody);
      const outcome = await this.drainRound(response, turn, controller, accumulator);

      // 没有工具调用 = 模型给出了最终答复，收尾。
      if (outcome.calls.length === 0) {
        if (round === turn.maxRounds && outcome.content.trim() === "") {
          throw new Error("工具回合用了满 " + turn.maxRounds + " 轮仍未给出结论；可提高回合上限或缩小问题范围");
        }
        return;
      }
      if (round === turn.maxRounds) {
        // 收尾回合不该再拿到调用：拿到了说明端点不认 tool_choice=none，再执行只会死循环。
        throw new Error("端点未遵守 tool_choice=none，第 " + turn.maxRounds + " 轮后仍在请求工具；已中止该回合");
      }

      // assistant 消息：正文用空串而非 null —— 部分端点对 content:null 直接 400。
      history.push({
        role: "assistant",
        content: outcome.content,
        tool_calls: outcome.calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      });

      for (const call of outcome.calls) {
        const input = parseArguments(call.arguments);
        this.emit(turn.clientToken, "llm-tool-call", { id: call.id, name: call.name, input, round });
        const output = await executeTool(this.access, turn.cwd, call.name, input, turn.policy, turn.mcpTools);
        this.emit(turn.clientToken, "llm-tool-result", {
          id: call.id,
          ok: output.error === null,
          error: output.error,
          summary: output.summary,
          path: output.path,
          // 只送预览：完整输出可能上万字符，前端时间线不需要，而事件是全局广播的。
          preview: truncate(output.content, 400),
        });
        history.push({
          role: "tool",
          tool_call_id: call.id,
          content: output.content,
        });
      }
    }
  }

  /** 消费一个回合的流，边下发正文 / 思考边把工具调用分片喂给累积器。 */
  private async drainRound(
    response: Response,
    turn: AgentTurn,
    controller: AbortController,
    accumulator: ToolCallAccumulator,
  ): Promise<{ content: string; calls: ToolCall[] }> {
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      // 非流式：一次性拿全文与全部调用（端点忽略 stream 时）。
      const text = await response.text();
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new Error("响应不是合法 JSON: " + truncate(text, 200));
      }
      const content = contentFromCompletion(body);
      if (content !== "") this.emit(turn.clientToken, "llm-delta", { delta: content });
      return { content, calls: toolCallsFromCompletion(body) };
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("响应没有可读流");
    const decoder = new TextDecoder();
    let content = "";
    let contentBatch = "";
    let thinkingBatch = "";
    let flushTimer: NodeJS.Timeout | null = null;
    let idleTimer: NodeJS.Timeout | null = null;
    let idleMessage: string | null = null;
    const armIdle = () => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      // 空闲超时：拿不到新字节就主动断流（以错误收场，循环会把错误上报）。
      idleTimer = setTimeout(() => {
        idleMessage = "llm endpoint idle timeout (" + IDLE_TIMEOUT_MS / 1000 + "s)";
        controller.abort();
      }, IDLE_TIMEOUT_MS);
    };
    const flush = () => {
      if (contentBatch !== "") {
        this.emit(turn.clientToken, "llm-delta", { delta: contentBatch });
        contentBatch = "";
      }
      if (thinkingBatch !== "") {
        this.emit(turn.clientToken, "llm-thinking-delta", { delta: thinkingBatch });
        thinkingBatch = "";
      }
    };
    const schedule = () => {
      if (flushTimer !== null) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flush();
      }, 30);
    };
    armIdle();

    let buffer = "";
    let streamError: Error | null = null;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        armIdle();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") {
            if (idleTimer !== null) clearTimeout(idleTimer);
            if (flushTimer !== null) clearTimeout(flushTimer);
            flush();
            return { content, calls: accumulator.take() };
          }
          let parsed: { error?: { message?: unknown } } & Record<string, unknown>;
          try {
            parsed = JSON.parse(payload) as { error?: { message?: unknown } } & Record<string, unknown>;
          } catch {
            continue;
          }
          if (typeof parsed.error?.message === "string") throw new Error(parsed.error.message);
          const delta = parseSseDelta(payload);
          if (delta === null) continue;
          if (delta.content !== null) {
            content += delta.content;
            contentBatch += delta.content;
            schedule();
          }
          if (delta.reasoning !== null) {
            thinkingBatch += delta.reasoning;
            schedule();
          }
          if (delta.toolCallChunks.length > 0) accumulator.push(delta.toolCallChunks);
        }
      }
    } catch (error) {
      streamError = error as Error;
    } finally {
      if (idleTimer !== null) clearTimeout(idleTimer);
      if (flushTimer !== null) clearTimeout(flushTimer);
      // 终止之前必须把缓冲发出去，否则本轮最后一段正文会丢。
      flush();
    }
    if (idleMessage !== null) throw new Error(idleMessage);
    if (streamError !== null) throw streamError;
    return { content, calls: accumulator.take() };
  }
}

/** 解析模型的 arguments。非法 JSON 不是致命错误：回空对象让 executeTool 报「缺少参数」。 */
function parseArguments(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (trimmed === "") return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
