import { AGENT_ROLES, type Agent } from "@greywork/agents";
import type {
  AcpPermissionRequestPayload,
  AcpSessionConfigOption,
  AcpSessionOpened,
  McpProbeReport,
  McpServerConfig,
  McpSkippedServer,
} from "@greywork/acp";
import { createJsonStorage } from "@greywork/core";
import { createAgentProviderRegistry, type AgentProviderConfig } from "@greywork/shell";
import { agentsBackend, type AgentProgramProbe, type AgentProviderRow } from "../lib/agents-backend";
import { defineStore } from "pinia";
import { ref, watch } from "vue";
import { useChatStore } from "./chat";
import { useSettingsStore } from "./settings";
import { useWorkspaceStore } from "./workspace";
import { i18n } from "../i18n";
import { parseToolActivityPayload } from "../lib/tool-activity";
import type { ThreadMessage } from "../types";
import { resolveWorkspaceDir } from "../lib/workspace-dir";
import { activeConversationFolder } from "../lib/conversation-folder";
import { acp } from "../lib/acp-client";
import { notify } from "./notice";

const t = i18n.global.t;

/** 连接在途被停止的哨兵：startAcpSession 返回它，调用方按「已停止」收尾而非报错。 */
const CONNECT_ABORTED = "__gw_aborted_connect__";

/** 判读 spawn 类错误（缺 CLI / 命令不存在），UI 据此给安装指引而不是原文。 */
function looksLikeMissingBinary(message: string): boolean {
  return /ENOENT|No such file|not found|command not found|spawn\b.*fail/i.test(message);
}

export interface WorkflowStep {
  id: string;
  label: string;
  status: "wait" | "active" | "done";
  desc: string;
}

/** 编排域（runs store）经此桥消费 ACP 事件：子任务 chunk/完成按 sessionId/handle 归属路由。 */
export interface RunEventBridge {
  /** session-update 载荷；sessionId 命中子任务会话即写子任务支架，返回 true 表示已消费。 */
  routeSessionUpdate?(payload: unknown): boolean;
  /** prompt-done 按 handle 完成子任务（finishSubtask + 解除回执）；true = 已消费。 */
  routeSubtaskDone?(handle: number): boolean;
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

const PROVIDERS_STORAGE_KEY = "greywork.agent-providers";
const providersStorage = createJsonStorage<{ providers: AgentProviderConfig[] }>(
  PROVIDERS_STORAGE_KEY,
  (value): value is { providers: AgentProviderConfig[] } =>
    typeof value === "object" && value !== null && Array.isArray((value as { providers?: unknown }).providers),
);

/** 后端选择偏好（场景一 Guid 预选持久化）：provider id；null = Local LLM。 */
interface ProviderPreference {
  providerId: string | null;
}
const providerPrefStorage = createJsonStorage<ProviderPreference>(
  "greywork.acp-provider",
  (value): value is ProviderPreference => typeof value === "object" && value !== null && "providerId" in value,
);

/** Agent 编排：编队 / 流水线 / 循环策略 / ACP 后端派发（AgentsView 与 Chat·Cowork 数据源）。 */
export const useAgentStore = defineStore("agent", () => {
  const settings = useSettingsStore();
  const chat = useChatStore();
  const workspaceStore = useWorkspaceStore();
  /**
   * 助手库成员（真实注册表接入前的诚实形态）：初始为空。
   * 早期版本用 MOCK_AGENTS 填充并展示冻结的假进度 —— 用户看到「正在跑 64%」实则无事发生。
   * 等真实 agent 注册/运行接入后再回填。
   */
  const agents = ref<Agent[]>([]);
  const roles = ref(AGENT_ROLES);
  const workflowSteps = ref<WorkflowStep[]>([
    { id: "collect", label: "agents.pipeline.collect.label", status: "done", desc: "agents.pipeline.collect.desc" },
    { id: "analyze", label: "agents.pipeline.analyze.label", status: "active", desc: "agents.pipeline.analyze.desc" },
    { id: "report", label: "agents.pipeline.report.label", status: "wait", desc: "agents.pipeline.report.desc" },
    { id: "review", label: "agents.pipeline.review.label", status: "wait", desc: "agents.pipeline.review.desc" },
  ]);

  /* ===== ACP 后端（工作台接入） ===== */
  const agentProviderRegistry = createAgentProviderRegistry();
  const cachedProviders = providersStorage.read()?.providers;
  const agentProviders = ref<AgentProviderConfig[]>(cachedProviders ?? agentProviderRegistry.list());
  const savedPref = providerPrefStorage.read();
  const savedProvider = savedPref?.providerId ? agentProviders.value.find((provider) => provider.id === savedPref?.providerId) : undefined;
  const selectedProviderId = ref<string>(savedProvider?.id ?? agentProviders.value[0]?.id ?? "");
  /** 恢复上次选择：偏好 ACP agent → 预选但不连接（发送时才起 runtime）；Local → 默认。 */
  const routeToAcp = ref(Boolean(savedProvider?.enabled));

  const acpBusy = ref(false);
  const acpHandle = ref<number | null>(null);
  const acpSessionId = ref<string | null>(null);
  /**
   * 当前 ACP 会话服务的对话 id（null = 尚未绑定到具体对话，如设置页主动连接时建的会话）。
   *
   * 不是渲染状态，所以用普通变量而不是 ref。它存在的唯一理由：ACP 的上下文属于 session，
   * 派发时必须能判断「这条 session 是不是当前这条对话的」，否则会拿着上一条对话的上下文继续答。
   */
  let acpSessionThreadId: string | null = null;
  /** 待前端裁决的权限请求；null = 无待决项（auto 决策只进通知流） */
  const pendingPermission = ref<AcpPermissionRequestPayload | null>(null);
  /** 权限确认截止（epoch ms，卡片倒计时用）；与宿主 PERMISSION_CONFIRM_TIMEOUT 同一 120s 窗口。 */
  const permissionDeadline = ref<number | null>(null);
  let permissionTimer: ReturnType<typeof setTimeout> | null = null;

  /** 清权限定时器：任何清 pending 的路径都必须先走这里，否则定时器会打在已删除的通知上。 */
  function clearPermissionTimer(): void {
    if (permissionTimer !== null) {
      clearTimeout(permissionTimer);
      permissionTimer = null;
    }
    permissionDeadline.value = null;
  }

  /** 置起 120s 超时窗口：宿主到时取消工具调用，前端镜像同一时刻收卡并通知。 */
  function armPermissionTimer(): void {
    clearPermissionTimer();
    if (!pendingPermission.value) return;
    permissionDeadline.value = Date.now() + 120_000;
    permissionTimer = setTimeout(() => {
      permissionTimer = null;
      if (!pendingPermission.value) return;
      pendingPermission.value = null;
      permissionDeadline.value = null;
      notify({ kind: "warning", key: "permission-timeout", title: t("errors.permissionTimedOut") });
    }, 120_000);
  }

  /** 统一清场（respondPermission / 断开 / 切后端 / 重启）。 */
  function dismissPendingPermission(): void {
    clearPermissionTimer();
    pendingPermission.value = null;
  }
  /** 当前 ACP 回合写入中的 assistant 支架（chat.threads 内），流式续写目标。 */
  let acpStream: ThreadMessage | null = null;
  /** 当前 ACP 回合所在线程 id（与 acpStream 成对；流式续写不依赖 activeThreadId）。 */
  let acpThreadId: string | null = null;
  /** 流式支架的 message id（ChatView 据此切换 StreamText 渲染）。 */
  const acpStreamId = ref<string | null>(null);
  /** 事件监听只挂一次 */
  let listening = false;
  /** 连接中标记：connectAcp 防重入。 */
  const acpConnecting = ref(false);
  /** spawn 在途收到停止：startAcpSession 在检查点自行收尾（spawn 无法精确取消）。 */
  let abortConnecting = false;
  /** 当前会话的配置选择器（模型 / 推理力度 / 会话模式等）；空 = agent 未暴露。 */
  const acpConfigOptions = ref<AcpSessionConfigOption[]>([]);
  /** 上次建会话时实际声明给 agent 的 MCP 服务器名。 */
  const acpMcpServers = ref<string[]>([]);
  /** 上次建会话时被跳过的 MCP 服务器（能力不匹配 / 配置不全），设置页据此明示原因。 */
  const acpMcpSkipped = ref<McpSkippedServer[]>([]);
  /** ACP runtime 已连接（有 agent 进程 + 会话）；供 UI 显示重启/选择器。 */
  const acpConnected = ref(false);

  /** ACP 连接状态机（对齐 GreyWork acpStatus）：null=未启动 → connecting → connected → session_active → disconnected | error。 */
  const acpStatus = ref<"connecting" | "connected" | "session_active" | "disconnected" | "error" | null>(null);
  /** 在途回合 id：acp.prompt 立即返回，stop 时按 turnId 精确取消单回合（进程保留）。 */
  const activeTurnId = ref<number | null>(null);
  /** 在途回合起点（epoch ms）；跨会话切换存活（模块级时钟，对齐 GreyWork conversationTurnClock）。 */
  const turnStartedAtMs = ref<number | null>(null);
  /** 最近一次 usage 快照（usage 事件）；null = agent 未上报。 */
  const acpUsage = ref<{ used: number; size: number; cost?: { amount: number; currency: string } } | null>(null);
  /** 最近一次 thinking 流文本（thought 事件聚合）；回合结束保留供检查。 */
  const acpThoughtText = ref("");
  /** slash 命令目录（commands 事件）；当前无 UI 消费，仅透传。 */
  const acpCommands = ref<unknown[]>([]);

  /* ===== 编排桥与全局回合钩子（runs 域经此路由/收尾；不在则按纯会话域运行） ===== */
  /** runs 编排域注册的事件消费桥（子任务会话/句柄归属只存在编排侧，会话域不静态依赖编排域）。 */
  let runBridge: RunEventBridge | null = null;
  /** 在途全局回合的收尾钩子（sendGlobalTurn 置入；prompt-done/异常清空，stopped 不清——编排 plannerPending 悬置语义保真）。 */
  let turnHooks: GlobalTurnHooks | null = null;

  async function ensureListener(): Promise<void> {
    if (listening) return;
    listening = true;
    await acp.onEvent((event) => {
      if (event.kind === "session-update") {
        const payload = event.payload as {
          sessionId?: string;
          update?: { sessionUpdate?: string; content?: { text?: string } };
        };
        // 子任务会话事件（sessionId 命中编排域注册的会话）由桥直接写子任务支架并消费；
        // 宿主发出的是 camelCase sessionId（ACP schema 的 serde 约定）。
        if (typeof payload.sessionId === "string" && runBridge?.routeSessionUpdate?.(event.payload) === true) return;
        // 解析 agent_message 中携带的工具调用部分（read/edit/bash/search …），
        // 并入支架消息的 tools 时间线 —— 前端「工具聚合时间线」数据源。
        const toolActivities = parseToolActivityPayload(event.payload);
        if (toolActivities.length > 0 && acpStream && acpThreadId) {
          chat.appendTools(toolActivities, acpStream.id, acpThreadId);
        }
        if (payload.update?.sessionUpdate === "agent_message_chunk") {
          const text = payload.update.content?.text ?? "";
          if (!text) return;
          if (acpStream && acpThreadId) chat.appendMessageContent(acpStream.id, text, acpThreadId);
        }
      } else if (event.kind === "thought") {
        // 思考流（AgentThoughtChunk）：聚合到 store 快照，并续写支架消息的 thinking
        // 字段（ThinkingBlock 数据源），不打断正文流。
        const payload = event.payload as { text?: string };
        if (!payload.text) return;
        acpThoughtText.value += payload.text;
        if (acpStream && acpThreadId) chat.appendMessageThinking(acpStream.id, payload.text, acpThreadId);
      } else if (event.kind === "usage") {
        // token 用量快照（UsageUpdate）。
        const payload = event.payload as { used?: number; size?: number; cost?: { amount: number; currency: string } };
        if (typeof payload.used === "number") {
          acpUsage.value = { used: payload.used, size: payload.size ?? 0, cost: payload.cost };
        }
      } else if (event.kind === "commands") {
        // slash 命令目录更新（AvailableCommandsUpdate）：当前无 UI 消费，仅透传状态。
        const payload = event.payload as { availableCommands?: unknown[] };
        if (payload.availableCommands) acpCommands.value = payload.availableCommands;
      } else if (event.kind === "permission-auto") {
        // 宿主按档位自动决策（daily 只读 / auto 直通）：追加一行通知，不打断流
        const payload = event.payload as AcpPermissionRequestPayload;
        if (acpStream && acpThreadId)
          chat.appendMessageContent(
            acpStream.id,
            t("errors.autoApproved", { title: payload.title ?? payload.kind, choice: payload.chosen ?? "" }),
            acpThreadId,
          );
      } else if (event.kind === "permission-blocked") {
        // 宿主权限拦截（只读档 / 工作区越界）：通知流记录，不打断流
        const payload = event.payload as { title?: string | null; kind?: string; reason?: string; paths?: string[] };
        if (acpStream && acpThreadId) {
          const detail =
            payload.reason === "read-only"
              ? t("errors.readOnlyBlocked", { title: payload.title ?? payload.kind ?? "write" })
              : t("errors.blockedOutsideWorkspace", {
                  title: payload.title ?? payload.kind ?? "write",
                  paths: (payload.paths ?? []).join("、"),
                });
          chat.appendMessageContent(acpStream.id, detail, acpThreadId);
        }
      } else if (event.kind === "config-options") {
        // 后端确认后的全量配置快照（set_config_option 响应 / ConfigOptionUpdate 通知）：
        // 回填选择器控件——对齐 GreyWork useAcpConfigOptions 的 snapshot 观测。
        const payload = event.payload as { configOptions?: AcpSessionConfigOption[] };
        if (Array.isArray(payload.configOptions) && payload.configOptions.length > 0) {
          acpConfigOptions.value = payload.configOptions;
        }
      } else if (event.kind === "permission-request") {
        // cautious / daily 非只读：转发到确认卡片（ChatView 内联渲染）；同时置 120s 镜像超时
        pendingPermission.value = event.payload as AcpPermissionRequestPayload;
        armPermissionTimer();
      } else if (event.kind === "prompt-done") {
        chat.flushPendingContent();
        const payload = event.payload as { handle?: number; response?: unknown };
        // 1) 子任务完成：按 handle 经桥路由到编排域（finishSubtask + 解除回执）
        if (payload.handle !== undefined && runBridge?.routeSubtaskDone?.(payload.handle) === true) return;
        // 2) hooked 全局回合（编排 planner 阶段）：脚手架收尾后回调编排域解析计划。
        //    镜像旧 planner 分支：只清 stream/busy，不清 activeTurnId/turnStartedAtMs（那是普通回合收尾才做）。
        if (turnHooks && acpStream && acpThreadId) {
          const threadId = acpThreadId;
          const messageId = acpStream.id;
          const message = chat.threads[threadId]?.find((candidate) => candidate.id === messageId);
          if (message && !message.content.trim()) chat.setMessageContent(messageId, t("chat.noOutput"), threadId);
          acpStream = null;
          acpThreadId = null;
          acpStreamId.value = null;
          acpBusy.value = false;
          const hooks = turnHooks;
          turnHooks = null;
          hooks.onPromptDone?.({ threadId, messageId });
          return;
        }
        // 3) 普通全局回合（既有逻辑）
        if (acpStream && acpThreadId) {
          const message = chat.threads[acpThreadId]?.find((candidate) => candidate.id === acpStream?.id);
          if (message && !message.content.trim()) chat.setMessageContent(message.id, t("chat.noOutput"), acpThreadId);
        }
        acpStream = null;
        acpThreadId = null;
        acpStreamId.value = null;
        acpBusy.value = false;
        activeTurnId.value = null;
        turnStartedAtMs.value = null;
      } else if (event.kind === "stopped") {
        chat.flushPendingContent();
        if (acpStream && acpThreadId) {
          chat.appendMessageContent(acpStream.id, `\n\n${t("chat.stopped")}`, acpThreadId);
          chat.flushPendingContent();
          acpStream = null;
          acpThreadId = null;
        }
        acpStreamId.value = null;
        acpConnected.value = false;
        acpHandle.value = null;
        acpSessionId.value = null;
        acpSessionThreadId = null;
        acpConfigOptions.value = [];
        acpBusy.value = false;
        dismissPendingPermission();
        activeTurnId.value = null;
        turnStartedAtMs.value = null;
        acpStatus.value = "disconnected";
      }
    });
  }

  /** 采纳 session/new 的结果（两条建会话路径共用，避免字段回填漂移）。 */
  function adoptOpenedSession(opened: AcpSessionOpened, threadId: string | null): void {
    acpSessionId.value = opened.sessionId;
    acpSessionThreadId = threadId;
    acpConfigOptions.value = opened.configOptions;
    acpMcpServers.value = opened.mcpServers ?? [];
    acpMcpSkipped.value = opened.skippedMcpServers ?? [];
    acpStatus.value = opened.configOptions.length > 0 ? "session_active" : "connected";
    acpConnected.value = true;
  }

  /** 连接在途被停止：释放刚建出的进程/会话并复位；返回哨兵让调用方走「已停止」文案。 */
  async function abortInFlightStart(): Promise<string> {
    abortConnecting = false;
    dismissPendingPermission();
    acpConnecting.value = false;
    acpBusy.value = false;
    if (acpHandle.value !== null) {
      try {
        await acp.stop(acpHandle.value);
      } catch {
        // 尽力释放：失败不影响状态复位，下次派发会重建。
      }
    }
    acpConnected.value = false;
    acpHandle.value = null;
    acpSessionId.value = null;
    acpSessionThreadId = null;
    acpConfigOptions.value = [];
    acpStreamId.value = null;
    acpStatus.value = "disconnected";
    return CONNECT_ABORTED;
  }

  /**
   * 建一条 ACP 会话并绑定到 `threadId`（null = 尚未落到具体对话，如设置页主动连接）。
   * 返回错误文案（null = 成功）。
   *
   * **agent 进程可复用，会话必须一对话一条**：ACP 的上下文属于 session，不属于进程。
   * 整个 app 共用一条 session 时，新建对话后 agent 仍带着上一条对话的上下文，
   * 回答会接着上一轮往下讲 —— 对话之间根本不隔离。
   * 反过来也不能靠重启进程来换会话：重启要重新 spawn CLI 并重新探测 config options
   * （模型 / 思考强度），那些是用户按工作区记住的选择，不该因为新建一次对话就丢掉。
   */
  async function startAcpSession(threadId: string | null = chat.activeThreadId): Promise<string | null> {
    const provider = agentProviders.value.find((provider) => provider.id === selectedProviderId.value);
    if (!provider) return t("errors.acpNotSelected");
    if (!acp.isAvailable()) return t("errors.acpTransportUnavailable");
    let workspace: string;
    try {
      // 当前会话绑定带磁盘文件夹的工作区 → 以该文件夹为 ACP 工作区（权限锚定基准）；
      // 否则回落既有解析（设置项 workspaceDir → 桌面主目录）。
      workspace = activeConversationFolder() ?? (await resolveWorkspaceDir());
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    await ensureListener();
    const reusedProcess = acpHandle.value !== null;
    if (!reusedProcess) acpStatus.value = "connecting";
    try {
      // 已有进程就只在它上面另开会话，不再 spawn 第二个 CLI。
      acpHandle.value ??= await acp.startAgent(provider.command, settings.effectivePermissionTier, settings.sandboxMode, workspace);
      if (abortConnecting) return await abortInFlightStart();
      // 建会话时把启用的 MCP 服务器声明给 agent；宿主按后端能力过滤，
      // 被跳过的原因回灌到 acpMcpSkipped 供设置页明示（不静默丢配置）。
      adoptOpenedSession(await acp.openSession(acpHandle.value, workspace, settings.enabledMcpServers), threadId);
      if (abortConnecting) return await abortInFlightStart();
      return null;
    } catch (error) {
      acpStatus.value = "error";
      acpSessionId.value = null;
      acpSessionThreadId = null;
      // 复用的进程还活着：只清会话、保留 handle，下一次派发能直接重试 session/new。
      // 若进程是本次刚 spawn 的，则连 handle 一起丢弃（与既有恢复语义一致：整条 runtime 重来）。
      if (!reusedProcess) {
        acpConnected.value = false;
        acpHandle.value = null;
        acpConfigOptions.value = [];
      }
      const detail = String(error);
      const missing = looksLikeMissingBinary(detail);
      notify({
        kind: "error",
        key: `acp-start-${provider.id}`,
        title: missing
          ? t("errors.acpBinaryMissing", { command: provider.command })
          : t("errors.startFailed", { detail: detail.length > 120 ? detail.slice(0, 120) + "…" : detail }),
        detail: missing ? (provider.installHint ?? t("errors.acpBinaryMissingHint")) : detail,
      });
      return t("errors.startFailed", { detail });
    }
  }

  /**
   * 全局回合统一入口（普通对话派发与编排 planner 共用）：支架消息先入当前线程，
   * 宿主事件（chunk / 权限 / 停止）驱动支架流式续写，回合终局（prompt-done / prompt 层异常）统一收尾。
   *
   * `reuseGlobalSession: true` 时信任调用方已 connectAcp（planner 路径与旧 dispatchRun 一致：
   * 先 connect 后建回合，不做「会话是否属于本线程」的隔离检查）；默认做隔离检查。
   */
  async function sendGlobalTurn(
    text: string,
    providerName: string,
    options: { hooks?: GlobalTurnHooks; reuseGlobalSession?: boolean } = {},
  ): Promise<void> {
    if (acpBusy.value || acpConnecting.value) return;
    const { threadId, message } = chat.startAcpTurn(text, providerName);
    acpStream = message;
    acpThreadId = threadId;
    acpStreamId.value = message.id;
    // 会话隔离：没有进程/会话，或现有会话属于**另一条对话** → 都要建新会话（进程照旧复用）。
    // 少了最后一个条件，新建对话后 agent 还带着上一条对话的上下文，回答会接着上一轮讲。
    if (!options.reuseGlobalSession && (acpHandle.value === null || acpSessionId.value === null || acpSessionThreadId !== threadId)) {
      const failure = await startAcpSession(threadId);
      if (failure) {
        if (failure === CONNECT_ABORTED) {
          // 用户在连接期点了停止：按「回合已停止」收尾，别当错误报。
          chat.appendMessageContent(message.id, `\n\n${t("chat.stopped")}`, acpThreadId);
          chat.flushPendingContent();
        } else {
          chat.setMessageContent(message.id, t("errors.acpStartFailed", { detail: failure }), acpThreadId);
        }
        acpStream = null;
        acpThreadId = null;
        acpStreamId.value = null;
        return;
      }
    }
    acpBusy.value = true;
    turnStartedAtMs.value = Date.now();
    if (!options.hooks?.preserveThought) acpThoughtText.value = "";
    if (options.hooks) turnHooks = options.hooks;
    try {
      const { turnId } = await acp.prompt(acpHandle.value as number, text);
      activeTurnId.value = turnId;
      // 注意：成功后不清 acpStream —— prompt 只是 ack，回合增量经事件异步回流，
      // 支架必须活到 prompt-done / stopped。
    } catch (error) {
      activeTurnId.value = null;
      turnStartedAtMs.value = null;
      turnHooks = null;
      // 钩子先决：编排路径自行落错误文案并返回 true，跳过默认 [ACP 派发失败]。
      if (options.hooks?.onPromptError?.({ threadId, messageId: message.id, error }) !== true) {
        const detail = error instanceof Error ? error.message : String(error);
        const current = acpThreadId ? chat.threads[acpThreadId]?.find((candidate) => candidate.id === message.id) : undefined;
        chat.setMessageContent(
          message.id,
          current?.content ? `${current.content}\n\n${t("errors.dispatchFailed", { detail })}` : t("errors.dispatchFailed", { detail }),
          acpThreadId,
        );
      }
      acpStream = null;
      acpThreadId = null;
      acpStreamId.value = null;
      acpBusy.value = false;
    }
  }

  /** 派发意图到选中 ACP 后端（普通对话路径：默认带会话隔离与默认错误文案）。 */
  async function dispatchToAcp(text: string): Promise<void> {
    const providerName = agentProviders.value.find((provider) => provider.id === selectedProviderId.value)?.name ?? "ACP";
    await sendGlobalTurn(text, providerName);
  }

  /** 编排域（runs store）注册事件消费桥；null = 解除。 */
  function attachRunBridge(bridge: RunEventBridge | null): void {
    runBridge = bridge;
  }

  /** 设置会话配置选项（模型 / 推理力度等）；返回错误文案（null = 成功）。 */
  async function setAcpConfig(configId: string, value: string | boolean): Promise<string | null> {
    if (acpHandle.value === null || !acpSessionId.value) return t("errors.sessionNotStarted");
    try {
      // setSessionConfig 返回全量最新快照（含后端确认后的 currentValue）——覆盖本地
      // 控件状态，保证「选择 → 后端确认 → 回填」闭环（对齐 useAcpConfigOptions）。
      const updated = await acp.setSessionConfig(acpHandle.value, configId, value);
      if (updated.length > 0) acpConfigOptions.value = updated;
      // 记忆到当前工作区：模型 / 思考强度这类选择是「这个项目怎么干活」的一部分，
      // 切回来应当还是它。回放期间不记（见 replayingConfig），否则回放会把自己再写一遍。
      if (!replayingConfig && typeof value === "string" && workspaceStore.activeWorkspaceId) {
        workspaceStore.setAgentConfig(workspaceStore.activeWorkspaceId, { configValues: { [configId]: value } });
      }
      return null;
    } catch (error) {
      return t("errors.configFailed", { detail: String(error) });
    }
  }

  /**
   * 把当前生效档位推给所有在途 agent。
   *
   * 宿主按 handle 存档位并在每条权限请求上重读，因此这里改完即刻生效，不必重启进程 ——
   * 「降到只读跑完再升」才能保住会话上下文。编排子任务各自一个 handle，一并推。
   */
  async function applyPermissionTier(): Promise<string | null> {
    const handles = acpHandle.value === null ? [] : [acpHandle.value];
    for (const handle of runBridge?.collectActiveHandles?.() ?? []) handles.push(handle);
    for (const handle of handles) {
      try {
        await acp.setPermissionTier(handle, settings.effectivePermissionTier);
      } catch (error) {
        return t("errors.configFailed", { detail: String(error) });
      }
    }
    return null;
  }

  /** 一键临时降级/回升；返回错误文案（null = 成功）。 */
  async function setTempReadOnly(on: boolean): Promise<string | null> {
    settings.tempReadOnly = on;
    return applyPermissionTier();
  }

  /** 回放工作区记忆配置期间置真，抑制 setAcpConfig 的自反写入。 */
  let replayingConfig = false;

  /**
   * 应用某工作区记住的 ACP 后端与会话配置。
   *
   * 无记录时**不动当前状态**（用户可能刚在别处选好后端，切个工作区不该被重置）。
   */
  async function applyWorkspaceAgentConfig(workspaceId: string | null): Promise<void> {
    const remembered = workspaceStore.agentConfigOf(workspaceId);
    if (!remembered) return;
    if (remembered.providerId === null) {
      if (routeToAcp.value) await switchToLocalLlm();
      return;
    }
    if (remembered.providerId && (remembered.providerId !== selectedProviderId.value || !routeToAcp.value)) {
      const failure = await activateAcpProvider(remembered.providerId);
      if (failure) return; // 连不上就停在错误态，别再拿旧 handle 回放配置
    }
    const values = remembered.configValues;
    if (!values || acpHandle.value === null) return;
    replayingConfig = true;
    try {
      for (const [configId, value] of Object.entries(values)) {
        const option = acpConfigOptions.value.find((candidate) => candidate.id === configId && candidate.type === "select");
        if (option) await setAcpConfig(configId, value);
      }
    } finally {
      replayingConfig = false;
    }
  }

  // 切工作区即换「这个项目的干活方式」；immediate 关掉，避免启动就抢着建连接。
  watch(() => workspaceStore.activeWorkspaceId, applyWorkspaceAgentConfig);

  /** 主动连接当前 ACP 后端并加载会话配置（幂等：已连接直接返回）。 */
  async function connectAcp(): Promise<string | null> {
    if (acpHandle.value !== null && acpSessionId.value) return null;
    if (acpConnecting.value) return null;
    acpConnecting.value = true;
    try {
      return await startAcpSession();
    } finally {
      acpConnecting.value = false;
    }
  }

  async function stopAcp(): Promise<void> {
    // spawn / 建会话在途：无法精确取消，置中止标志由 startAcpSession 检查点收尾。
    if (acpConnecting.value || acpStatus.value === "connecting") {
      abortConnecting = true;
      return;
    }
    if (acpHandle.value === null) return;
    try {
      // 有在途回合：精确取消该回合（agent 进程与会话保留，可继续对话）。
      if (activeTurnId.value !== null) {
        const turnId = activeTurnId.value;
        activeTurnId.value = null;
        turnStartedAtMs.value = null;
        await acp.stop(acpHandle.value, turnId);
      } else {
        await acp.stop(acpHandle.value);
        acpStatus.value = "disconnected";
        acpConnected.value = false;
      }
    } catch (error) {
      if (acpStream && acpThreadId)
        chat.appendMessageContent(acpStream.id, `\n\n${t("errors.stopFailed", { detail: String(error) })}`, acpThreadId);
    }
  }

  /** 重启当前 ACP runtime：停 agent 进程 → 重新 spawn + session/new（重新探测模型/config options）。
   *  对齐 GreyWork AcpRuntimeRestartButton——runtime 卡死/模型探测失败后的恢复路径。 */
  async function restartAcpRuntime(): Promise<string | null> {
    if (acpHandle.value === null) return null;
    try {
      await acp.stop(acpHandle.value);
    } catch (error) {
      return t("errors.stopCurrentFailed", { detail: String(error) });
    }
    acpConnected.value = false;
    acpHandle.value = null;
    acpSessionId.value = null;
    acpSessionThreadId = null;
    acpConfigOptions.value = [];
    dismissPendingPermission();
    acpStreamId.value = null;
    activeTurnId.value = null;
    turnStartedAtMs.value = null;
    acpStatus.value = "disconnected";
    return startAcpSession();
  }

  /* ===== 后端目录管理（Agent 管理面：启停持久化，桌面真源 SQLite） ===== */

  function persistProviders(): void {
    providersStorage.write({ providers: agentProviders.value });
    if (agentsBackend.active()) {
      // 显式取字段：detect/installHint 只属于前端预设，不落库
      const rows: AgentProviderRow[] = agentProviders.value.map(({ id, name, kind, command, enabled }) => ({
        id,
        name,
        kind,
        command,
        enabled,
      }));
      void agentsBackend.save(rows).catch((error: unknown) => {
        console.error("[agent] 后端目录同步失败，将下次重试", error);
        notify({ kind: "error", key: "agent-provider-sync", title: t("errors.providerSyncFailed"), detail: String(error) });
      });
    }
  }
  /** detect/installHint 属于前端预设、不落库；从 SQLite 读回时按 id 补回。 */
  function withPresetMeta(provider: AgentProviderConfig): AgentProviderConfig {
    const preset = agentProviderRegistry.get(provider.id);
    return preset ? { ...provider, detect: preset.detect, installHint: preset.installHint } : provider;
  }

  /** 本机 PATH 探测结果（program → 探测结果）；浏览器态恒为空 → UI 不显示安装状态。 */
  const agentDetection = ref<Record<string, AgentProgramProbe>>({});

  /** 探测各后端 CLI 是否安装（桌面态；失败静默 → 状态保持未知）。 */
  async function refreshAgentDetection(): Promise<void> {
    const programs = [...new Set(agentProviders.value.flatMap((provider) => provider.detect ?? []))];
    try {
      const probes = await agentsBackend.detect(programs);
      if (probes) agentDetection.value = Object.fromEntries(probes.map((probe) => [probe.program, probe]));
    } catch (error: unknown) {
      console.error("[agent] CLI 安装探测失败", error);
    }
  }

  /** 后端安装状态：true 已装 / false 未装 / null 未探测（未跑过探测或无探测项）。 */
  function providerInstalled(provider: AgentProviderConfig): boolean | null {
    const programs = provider.detect ?? [];
    if (programs.length === 0 || Object.keys(agentDetection.value).length === 0) return null;
    return programs.some((program) => agentDetection.value[program]?.installed === true);
  }

  /** 设置页状态文案：未装且命令走 npx → 首次启动按需下载，否则直说未安装。 */
  function providerInstallLabel(provider: AgentProviderConfig): string {
    const installed = providerInstalled(provider);
    if (installed === null) return "";
    if (installed) return "已安装";
    return provider.command.startsWith("npx") ? "首次启动下载" : "未安装";
  }

  /** 桌面态启动接管：库目录 → 覆盖（真源）；未接管 → 内置缺省/缓存首落库。 */
  const providersHydrated: Promise<void> | null = (() => {
    if (!agentsBackend.active()) return null;
    return agentsBackend
      .load()
      .then((providers) => {
        if (providers) {
          agentProviders.value = providers.map(withPresetMeta);
          // selected 在新目录中消失时回落首个 id（routeToAcp 状态保持，activate 再校验 enabled）
          if (!agentProviders.value.some((provider) => provider.id === selectedProviderId.value)) {
            selectedProviderId.value = agentProviders.value[0]?.id ?? "";
          }
          if (!routeToAcp.value && !savedProvider?.enabled && selectedProviderId.value === "") {
            selectedProviderId.value = agentProviders.value[0]?.id ?? "";
          }
        } else {
          persistProviders(); // 首启：内置缺省成为库真源
        }
      })
      .catch((error: unknown) => {
        console.error("[agent] 后端目录加载失败，沿用内置缺省", error);
        notify({ kind: "error", key: "agent-provider-load", title: t("errors.providerSyncFailed"), detail: String(error) });
      });
  })();

  /** 启停 ACP 后端：禁用当前选中且正在 ACP 路由时自动切回 Local LLM。 */
  async function setAgentProviderEnabled(id: string, enabled: boolean): Promise<void> {
    const provider = agentProviders.value.find((candidate) => candidate.id === id);
    if (!provider || provider.enabled === enabled) return;
    provider.enabled = enabled;
    persistProviders();
    if (!enabled && id === selectedProviderId.value && routeToAcp.value) {
      await switchToLocalLlm(); // 停用当前后端：完整清理 ACP 状态回 Local
    }
  }

  /** 切换首页 ACP CLI 入口。切换已有连接时先释放旧 agent，避免跨 provider 复用 session。 */
  async function activateAcpProvider(id: string): Promise<string | null> {
    const provider = agentProviders.value.find((candidate) => candidate.id === id);
    if (!provider) return t("errors.acpNotSelected");
    if (!provider.enabled) return t("errors.providerNotEnabled", { name: provider.name });
    if (selectedProviderId.value !== id && acpHandle.value !== null) {
      try {
        await acp.stop(acpHandle.value);
      } catch (error) {
        return t("errors.stopCurrentFailed", { detail: String(error) });
      }
      acpConnected.value = false;
      acpHandle.value = null;
      acpSessionId.value = null;
      acpSessionThreadId = null;
      acpConfigOptions.value = [];
      dismissPendingPermission();
      acpStreamId.value = null;
    }
    selectedProviderId.value = id;
    routeToAcp.value = true;
    providerPrefStorage.write({ providerId: id });
    // 后端选择也按工作区记忆（回放时 replayingConfig 无关：providerId 幂等）
    if (workspaceStore.activeWorkspaceId) workspaceStore.setAgentConfig(workspaceStore.activeWorkspaceId, { providerId: id });
    // 选中即建会话：configOptions（模型 / 思考强度）只有 session/new 之后才有值，
    // 否则选择器要等到首次发送才出现。连接失败不阻塞选择（发送时会重试并落文案）；
    // 失败文案原样返回，调用方（AgentProviderBar）就地展示而非静默吞掉。
    return await connectAcp();
  }

  /** 权限裁决回传宿主；optionId=null 表示拒绝该次操作。 */
  async function respondPermission(optionId: string | null): Promise<void> {
    const pending = pendingPermission.value;
    if (!pending) return;
    dismissPendingPermission();
    const choice = optionId
      ? (pending.options.find((option) => option.optionId === optionId)?.name ?? optionId)
      : t("errors.permissionDenied");
    try {
      await acp.respondPermission(pending.requestId, optionId);
      if (acpStream && acpThreadId)
        chat.appendMessageContent(
          acpStream.id,
          `\n\n${t("errors.permissionLog", { choice, title: pending.title ?? pending.kind })}`,
          acpThreadId,
        );
    } catch (error) {
      if (acpStream && acpThreadId)
        chat.appendMessageContent(acpStream.id, `\n\n${t("errors.permissionFailed", { detail: String(error) })}`, acpThreadId);
    }
  }

  /**
   * 探活一台 MCP 服务器（设置页「测试连接」）：宿主自己走一遍 initialize + tools/list。
   * 这只用于验证配置——真正连接由 agent 在会话里建立。
   */
  async function probeMcpServer(config: McpServerConfig): Promise<{ report?: McpProbeReport; error?: string }> {
    if (!acp.isAvailable()) return { error: t("errors.acpTransportUnavailable") };
    try {
      return { report: await acp.probeMcp(config) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  function selectProvider(id: string): void {
    selectedProviderId.value = id;
  }

  function toggleRouteToAcp(): void {
    routeToAcp.value = !routeToAcp.value;
  }

  /** 切回本地 LLM 管线（关闭 ACP 路由；若已连接 agent 则释放）。 */
  async function switchToLocalLlm(): Promise<void> {
    routeToAcp.value = false;
    providerPrefStorage.write({ providerId: null });
    if (workspaceStore.activeWorkspaceId) workspaceStore.setAgentConfig(workspaceStore.activeWorkspaceId, { providerId: null });
    if (acpHandle.value !== null) {
      try {
        await acp.stop(acpHandle.value);
      } catch {
        // 释放失败不阻塞切换；下次 startAcpSession 会重建。
      }
      acpConnected.value = false;
      acpHandle.value = null;
      acpSessionId.value = null;
      acpSessionThreadId = null;
      acpConfigOptions.value = [];
      dismissPendingPermission();
      acpStreamId.value = null;
      activeTurnId.value = null;
      turnStartedAtMs.value = null;
      acpStatus.value = "disconnected";
    }
  }

  return {
    agents,
    roles,
    workflowSteps,
    agentProviders,
    selectedProviderId,
    routeToAcp,
    acpBusy,
    acpConnecting,
    pendingPermission,
    acpConfigOptions,
    permissionDeadline,
    acpMcpServers,
    acpMcpSkipped,
    acpStreamId,
    acpStatus,
    acpConnected,
    activeTurnId,
    turnStartedAtMs,
    acpUsage,
    acpThoughtText,
    acpCommands,
    /** 后端目录启动接管完成信号（null = 浏览器态无后端）。 */
    providersHydrated,
    agentDetection,
    refreshAgentDetection,
    providerInstalled,
    providerInstallLabel,
    setAgentProviderEnabled,
    setAcpConfig,
    connectAcp,
    activateAcpProvider,
    /** 编排域内部契约：全局回合派发（planner 阶段经 hooks 收尾）与事件消费桥注册。 */
    sendGlobalTurn,
    attachRunBridge,
    setTempReadOnly,
    applyPermissionTier,
    applyWorkspaceAgentConfig,
    acpAvailable: acp.isAvailable(),
    selectProvider,
    toggleRouteToAcp,
    switchToLocalLlm,
    restartAcpRuntime,
    dispatchToAcp,
    stopAcp,
    respondPermission,
    probeMcpServer,
  };
});
