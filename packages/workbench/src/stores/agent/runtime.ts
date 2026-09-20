/**
 * ACP 运行态切片：agent 进程 / 会话的建立与拆解、宿主事件监听（chunk / 权限 /
 * 配置 / 收尾）、权限卡片裁决、会话配置与 MCP 探活。
 *
 * 与 turn 切片的关系：turn 负责「派发一个回合」，本切片负责「这条会话还活着、
 * 事件怎么进、怎么停」。事件监听里对回合支架的续写/收尾经 locals（acpStream）
 * 与 getTurn().writeTurnError 完成。
 */
import type { AcpPermissionRequestPayload, AcpSessionConfigOption, AcpSessionOpened, McpProbeReport, McpServerConfig } from "@greywork/acp";
// 走 ./permissions 子路径而不是包根：那是无依赖的纯分类层。包根会连带拉起 client.ts
// （@tauri-apps/api / ACP SDK），而权限分类在测试里必须能独立于传输层加载。
import { classifyAcpPermission, safeAllowOnceId } from "@greywork/acp/permissions";
import { basename } from "@greywork/core";
import { watch } from "vue";
import { acp } from "../../lib/acp-client";
import { normalizeAcpCommands } from "../../lib/slash-commands";
import { formatDuration, parseToolActivityPayload } from "../../lib/tool-activity";
import { permissionCommand } from "../../lib/permission-detail";
import { activeConversationFolder } from "../../lib/conversation-folder";
import { isolateForRun, resolveWorkspaceDir } from "../../lib/workspace-dir";
import { parseScheduleFences } from "../../lib/schedule-fence";
import { appEvents } from "../../events";
import { notify } from "../notice";
import { CONNECT_ABORTED, t, looksLikeMissingBinary } from "./shared";
import type { AgentStoreState } from "./state";
import type { TurnApi } from "./turn";
import type { PermissionTrace } from "../../types";

export interface RuntimeDeps {
  state: AgentStoreState;
  getTurn: () => TurnApi;
}

export interface RuntimeApi {
  startAcpSession(threadId?: string | null): Promise<string | null>;
  setAcpConfig(configId: string, value: string | boolean): Promise<string | null>;
  applyPermissionTier(): Promise<string | null>;
  setTempReadOnly(on: boolean): Promise<string | null>;
  connectAcp(): Promise<string | null>;
  stopAcp(): Promise<void>;
  restartAcpRuntime(): Promise<string | null>;
  respondPermission(optionId: string | null): Promise<void>;
  probeMcpServer(config: McpServerConfig): Promise<{ report?: McpProbeReport; error?: string }>;
  dismissPendingPermission(): void;
}

export function createRuntimeSlice({ state, getTurn }: RuntimeDeps): RuntimeApi {
  const locals = state.locals;

  /** 待前端裁决的权限请求；null = 无待决项（auto 决策只进通知流）。 */
  const pendingPermission = state.pendingPermission;
  /** 权限确认截止（epoch ms，卡片倒计时用）；与宿主 PERMISSION_CONFIRM_TIMEOUT 同一 120s 窗口。 */
  const permissionDeadline = state.permissionDeadline;
  let permissionTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 本次 ACP 会话内已被「始终允许」的工具类别。
   *
   * 按 kind 记而不是按 optionId：optionId 是各 agent 自定的（opencode 用 "always"，
   * 别的后端可能是 "allow-always"），存下来换个后端就是一堆废键。类别语义跨后端一致。
   */
  const alwaysAllowedKinds = new Set<string>();

  /** 事件监听只挂一次。 */
  let listening = false;
  /**
   * 恢复会话的回放抑制窗口。
   *
   * `session/load` 之后 agent 可能把历史以 `session/update` 重放一遍，而历史已经在
   * `messages` 里，再贴一遍会重复。置位期间只丢「内容类」update（正文 / thinking / 工具），
   * 权限 / 配置 / usage / prompt-done 照常处理。窗口在「连续 300ms 无内容 update」或
   * 硬上限 1s 时解除；stop / 切会话 / handle 变更也清位。agent 不重放时唯一成本 ≤300ms。
   */
  let replayGuard: { sessionId: string; lastContentAt: number } | null = null;
  /** 连接中标记：connectAcp 防重入。 */
  const acpConnecting = state.acpConnecting;
  /** spawn 在途收到停止：startAcpSession 在检查点自行收尾（spawn 无法精确取消）。 */
  let abortConnecting = false;

  /** 清回放抑制窗口（stop / 切会话 / handle 变更 / 超时都走这里）。 */
  function clearReplayGuard(): void {
    replayGuard = null;
  }
  /**
   * 进入回放抑制窗口后等待「连续 300ms 无内容 update」或硬上限 1s，然后解除。
   * agent 不重放时成本仅 ≤300ms；用 rAF 之外的 setTimeout 轮询（测试可 fake timers）。
   */
  async function settleReplay(sessionId: string): Promise<void> {
    replayGuard = { sessionId, lastContentAt: Date.now() };
    const startedAt = Date.now();
    const QUIET_MS = 300;
    const HARD_MS = 1000;
    // 轮询式静默检测：事件处理里会刷新 lastContentAt，这里只判断窗口何时结束。
    await new Promise<void>((resolve) => {
      const tick = (): void => {
        if (replayGuard === null) return resolve(); // 已被外部清位
        const quietEnough = Date.now() - replayGuard.lastContentAt >= QUIET_MS;
        const overtime = Date.now() - startedAt >= HARD_MS;
        if (quietEnough || overtime) return resolve();
        setTimeout(tick, 50);
      };
      tick();
    });
    // 到时有可能是内容仍在刷（overtime 触发），但只要没被外部清，就解除——下游新内容已不属重放。
    clearReplayGuard();
  }

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
      const pending = pendingPermission.value;
      if (!pending) return;
      pendingPermission.value = null;
      permissionDeadline.value = null;
      writePermissionTrace(permissionTrace(pending, null, "timeout"));
      notify({ kind: "warning", key: "permission-timeout", title: t("errors.permissionTimedOut") });
    }, 120_000);
  }

  /** 统一清场（respondPermission / 断开 / 切后端 / 重启）。 */
  function dismissPendingPermission(): void {
    clearPermissionTimer();
    pendingPermission.value = null;
  }

  /** 权限载荷 + 裁决结果 → 留痕记录（消息流里那条只读卡）。 */
  function permissionTrace(
    payload: AcpPermissionRequestPayload,
    choice: string | null,
    source: PermissionTrace["source"],
  ): PermissionTrace {
    return {
      toolCallId: payload.toolCallId,
      title: payload.title ?? null,
      kind: payload.kind,
      paths: payload.locations ?? [],
      command: permissionCommand(payload.rawInput),
      choice,
      source,
      decidedAt: Date.now(),
    };
  }

  /** 留痕写进当前 ACP 支架消息；无支架时丢弃（设置页主动连接这类场景本来就没有消息可挂）。 */
  function writePermissionTrace(trace: PermissionTrace): void {
    if (!locals.acpStream || !locals.acpThreadId) return;
    state.chat.setPermissionTrace(trace, locals.acpStream.id, locals.acpThreadId);
  }

  /**
   * 免问直答：用户此前对该类别选过「始终允许」，替他答掉这条请求。
   *
   * 走这里而不是 respondPermission：那条路径要先弹卡再收卡，视觉上会闪一下，
   * 而用户的本意恰恰是「别再问我」。留痕照写，回看时能解释清「这次为什么没问」。
   */
  async function autoRespondPermission(payload: AcpPermissionRequestPayload, optionId: string): Promise<void> {
    const choice = payload.options.find((option) => option.optionId === optionId)?.name ?? optionId;
    // 先留痕再回传：回传失败也不该把「发生过的事」丢掉。
    writePermissionTrace(permissionTrace(payload, choice, "auto"));
    try {
      await acp.respondPermission(payload.requestId, optionId);
    } catch (error) {
      if (locals.acpStream && locals.acpThreadId) {
        state.chat.appendMessageContent(
          locals.acpStream.id,
          `\n\n${t("errors.permissionFailed", { detail: String(error) })}`,
          locals.acpThreadId,
        );
      }
    }
  }

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
        if (typeof payload.sessionId === "string" && locals.runBridge?.routeSessionUpdate?.(event.payload) === true) return;
        // 恢复会话的回放抑制：窗口期内只丢「内容类」update（工具 / 正文），避免历史重复渲染。
        // 匹配规则：事件带 sessionId 时须等于恢复出的 session；缺失则按 handle 级窗口（本会话）。
        const suppressed = replayGuard !== null && (payload.sessionId === undefined || payload.sessionId === replayGuard.sessionId);
        if (!suppressed) {
          // 解析 agent_message 中携带的工具调用部分（read/edit/bash/search …），
          // 并入支架消息的 tools 时间线 —— 前端「工具聚合时间线」数据源。
          const toolActivities = parseToolActivityPayload(event.payload);
          if (toolActivities.length > 0 && locals.acpStream && locals.acpThreadId) {
            state.chat.appendTools(toolActivities, locals.acpStream.id, locals.acpThreadId);
          }
          if (payload.update?.sessionUpdate === "agent_message_chunk") {
            const text = payload.update.content?.text ?? "";
            if (!text) return;
            if (locals.acpStream && locals.acpThreadId) {
              state.chat.appendMessageContent(locals.acpStream.id, text, locals.acpThreadId);
            }
          }
        } else {
          // 被抑制的内容类 update 仍在推进「静默」计时：只要有内容到达就把窗口往后挪，
          // 直到连续 300ms 无内容为止（见 settleReplay）。
          if (replayGuard) replayGuard.lastContentAt = Date.now();
        }
      } else if (event.kind === "thought") {
        // 思考流（AgentThoughtChunk）：聚合到 store 快照，并续写支架消息的 thinking
        // 字段（ThinkingBlock 数据源），不打断正文流。
        if (replayGuard) return; // 回放抑制：恢复窗口内的思考流同样不写（历史已在 messages）。
        const payload = event.payload as { text?: string };
        if (!payload.text) return;
        state.acpThoughtText.value += payload.text;
        if (locals.acpStream && locals.acpThreadId) {
          state.chat.appendMessageThinking(locals.acpStream.id, payload.text, locals.acpThreadId);
        }
      } else if (event.kind === "usage") {
        // token 用量快照（UsageUpdate）。
        const payload = event.payload as { used?: number; size?: number; cost?: { amount: number; currency: string } };
        if (typeof payload.used === "number") {
          state.acpUsage.value = { used: payload.used, size: payload.size ?? 0, cost: payload.cost };
        }
      } else if (event.kind === "commands") {
        // slash 命令目录更新（AvailableCommandsUpdate）：脏条目逐条丢弃后入目录。
        const payload = event.payload as { availableCommands?: unknown };
        state.acpCommands.value = normalizeAcpCommands(payload.availableCommands);
      } else if (event.kind === "permission-auto") {
        // 宿主按档位自动决策（daily 只读 / auto 直通）：追加一行通知，不打断流
        const payload = event.payload as AcpPermissionRequestPayload;
        if (locals.acpStream && locals.acpThreadId) {
          state.chat.appendMessageContent(
            locals.acpStream.id,
            t("errors.autoApproved", { title: payload.title ?? payload.kind, choice: payload.chosen ?? "" }),
            locals.acpThreadId,
          );
        }
      } else if (event.kind === "permission-blocked") {
        // 宿主权限拦截（只读档 / 工作区越界）：通知流记录，不打断流
        const payload = event.payload as { title?: string | null; kind?: string; reason?: string; locations?: string[] };
        if (locals.acpStream && locals.acpThreadId) {
          const detail =
            payload.reason === "read-only"
              ? t("errors.readOnlyBlocked", { title: payload.title ?? payload.kind ?? "write" })
              : t("errors.blockedOutsideWorkspace", {
                  title: payload.title ?? payload.kind ?? "write",
                  paths: (payload.locations ?? []).join("、"),
                });
          state.chat.appendMessageContent(locals.acpStream.id, detail, locals.acpThreadId);
        }
      } else if (event.kind === "config-options") {
        // 后端确认后的全量配置快照（set_config_option 响应 / ConfigOptionUpdate 通知）：
        // 回填选择器控件——对齐 GreyWork useAcpConfigOptions 的 snapshot 观测。
        const payload = event.payload as { configOptions?: AcpSessionConfigOption[] };
        if (Array.isArray(payload.configOptions) && payload.configOptions.length > 0) {
          state.acpConfigOptions.value = payload.configOptions;
        }
      } else if (event.kind === "permission-request") {
        // 用户此前选过「始终允许」的类别：直接答掉，不再第二次打扰。
        const payload = event.payload as AcpPermissionRequestPayload;
        const remembered = alwaysAllowedKinds.has(payload.kind)
          ? (safeAllowOnceId(payload.options) ??
            payload.options.find((option) => classifyAcpPermission(option.kind) === "allow-always")?.optionId)
          : undefined;
        if (remembered) {
          void autoRespondPermission(payload, remembered);
          return;
        }
        // cautious / daily 非只读：转发到确认卡片；同时置 120s 镜像超时
        pendingPermission.value = payload;
        armPermissionTimer();
      } else if (event.kind === "prompt-done") {
        state.chat.flushPendingContent();
        const payload = event.payload as { handle?: number; response?: unknown; error?: unknown; files?: unknown };
        // 回合失败原因（prompt 层错误 / 宿主超时 / agent JSON-RPC 错误）。有值 = 失败回合：
        // 落失败文案而非「无文本输出」，且不发「完成」脚标/通知——否则挂掉的后端会被当成成功。
        const errorText = typeof payload.error === "string" && payload.error.trim() ? payload.error.trim() : "";
        // 1) 子任务完成：按 handle 经桥路由到编排域（finishSubtask + 解除回执）
        if (payload.handle !== undefined && locals.runBridge?.routeSubtaskDone?.(payload.handle, errorText) === true) return;
        // 2) hooked 全局回合（编排 planner 阶段）：脚手架收尾后回调编排域解析计划。
        //    镜像旧 planner 分支：只清 stream/busy，不清 activeTurnId/turnStartedAtMs（那是普通回合收尾才做）。
        if (locals.turnHooks && locals.acpStream && locals.acpThreadId) {
          const hooks = locals.turnHooks;
          const threadId = locals.acpThreadId;
          const messageId = locals.acpStream.id;
          const message = state.chat.threads[threadId]?.find((candidate) => candidate.id === messageId);
          if (message && errorText) {
            // 失败回合：编排钩子可自写错误文案（返回 true）；否则落失败行，
            // onPromptDone 照常收尾（planner 解析失败会转 run failed，不会假装成功）。
            if (hooks.onPromptError?.({ threadId, messageId, error: errorText }) !== true) {
              getTurn().writeTurnError(messageId, errorText, threadId);
            }
          } else if (message && !message.content.trim()) {
            state.chat.setMessageContent(messageId, t("chat.noOutput"), threadId);
          }
          locals.acpStream = null;
          locals.acpThreadId = null;
          state.acpStreamId.value = null;
          state.acpBusy.value = false;
          state.chat.runningSessionId = null;
          locals.turnHooks = null;
          hooks.onPromptDone?.({ threadId, messageId });
          return;
        }
        // 3) 普通全局回合（既有逻辑）
        const turnStart = state.turnStartedAtMs.value;
        if (locals.acpStream && locals.acpThreadId) {
          const message = state.chat.threads[locals.acpThreadId]?.find((candidate) => candidate.id === locals.acpStream?.id);
          if (message && errorText) {
            getTurn().writeTurnError(message.id, errorText, locals.acpThreadId);
          } else if (message && !message.content.trim()) {
            state.chat.setMessageContent(message.id, t("chat.noOutput"), locals.acpThreadId);
          } else if (message && turnStart != null) {
            // 回合收尾脚标：真实 ACP 路径原本只有状态翻转（无任何显式「完成」文本），
            // 加一行完成脚标让用户确认响应已结束——否则以为还在生成而去按停止。
            state.chat.appendMessageContent(
              message.id,
              t("chat.completedFooter", { duration: formatDuration(Date.now() - turnStart) }),
              locals.acpThreadId,
            );
            state.chat.flushPendingContent();
          }
        }
        // ```schedule 围栏解析（AI 提议定时任务）：只在成功回合、支架还在、且未挂过
        // 草稿时做一次；只取第一条（多围栏多半是幻觉，少即是多）。挂上后由
        // ScheduleConfirmCard 走用户确认，不会静默创建。
        const scaffold = locals.acpStream;
        if (!errorText && scaffold && !scaffold.scheduleDraft && scaffold.content.trim()) {
          const fence = parseScheduleFences(scaffold.content)[0];
          if (fence) {
            scaffold.scheduleDraft = fence;
            state.session.markDirty();
          }
        }
        locals.acpStream = null;
        locals.acpThreadId = null;
        state.acpStreamId.value = null;
        state.acpBusy.value = false;
        state.chat.runningSessionId = null;
        state.activeTurnId.value = null;
        state.turnStartedAtMs.value = null;
        // 成功回合的磁盘产物自动开右栏预览：宿主只在成功回合把工作区内本回合修改过的
        // 文档类文件（md/html/csv/xlsx/docx/pptx/pdf）随 prompt-done 带回 files；
        // 失败回合不带，这里也不弹。走 preview:request 事件而非直调 preview store：
        // store 不依赖 store（面板自会接线），与 run:status 的解耦先例一致。
        // open 天然幂等（同路径聚焦），多文件按序开。
        if (!errorText && Array.isArray(payload.files)) {
          for (const raw of payload.files) {
            if (typeof raw !== "string" || !raw.trim()) continue;
            const path = raw.trim();
            appEvents.emit("preview:request", { path, name: basename(path) || path, source: "disk" });
          }
        }
        // 完成通知（success toast，自动消失）：回合结束是低频事件，值得一个明确的「完成」反馈，
        // 用户不必盯着输入框从「处理中…」翻成「就绪」才知道干完了。
        // 失败回合不发：错误已在气泡里，成功 toast 会把挂掉的后端演成「完成」。
        if (!errorText && turnStart != null) {
          const duration = formatDuration(Date.now() - turnStart);
          notify({
            kind: "success",
            key: "acp-turn-done",
            title: t("chat.completedToast"),
            detail: t("chat.completedDetail", { duration }),
          });
        }
      } else if (event.kind === "stopped") {
        state.chat.flushPendingContent();
        if (locals.acpStream && locals.acpThreadId) {
          state.chat.appendMessageContent(locals.acpStream.id, `\n\n${t("chat.stopped")}`, locals.acpThreadId);
          state.chat.flushPendingContent();
          locals.acpStream = null;
          locals.acpThreadId = null;
        }
        state.acpStreamId.value = null;
        state.acpConnected.value = false;
        state.acpHandle.value = null;
        state.acpSessionId.value = null;
        locals.acpSessionThreadId = null;
        state.acpConfigOptions.value = [];
        state.acpImageSupport.value = null;
        state.acpBusy.value = false;
        state.chat.runningSessionId = null;
        dismissPendingPermission();
        state.activeTurnId.value = null;
        state.turnStartedAtMs.value = null;
        state.acpStatus.value = "disconnected";
      }
    });
  }

  /** 采纳 session/new 的结果（两条建会话路径共用，避免字段回填漂移）。 */
  function adoptOpenedSession(opened: AcpSessionOpened, threadId: string | null): void {
    state.acpSessionId.value = opened.sessionId;
    locals.acpSessionThreadId = threadId;
    // 新会话没有上下文：schedule 围栏说明需要随下个回合重新注入一次
    locals.scheduleHintInjectedFor = null;
    state.acpConfigOptions.value = opened.configOptions;
    state.acpMcpServers.value = opened.mcpServers ?? [];
    state.acpMcpSkipped.value = opened.skippedMcpServers ?? [];
    state.acpImageSupport.value = opened.imagePrompts === true;
    state.acpStatus.value = opened.configOptions.length > 0 ? "session_active" : "connected";
    state.acpConnected.value = true;
  }

  /** 连接在途被停止：释放刚建出的进程/会话并复位；返回哨兵让调用方走「已停止」文案。 */
  async function abortInFlightStart(): Promise<string> {
    abortConnecting = false;
    dismissPendingPermission();
    acpConnecting.value = false;
    state.acpBusy.value = false;
    state.chat.runningSessionId = null;
    if (state.acpHandle.value !== null) {
      try {
        await acp.stop(state.acpHandle.value);
      } catch {
        // 尽力释放：失败不影响状态复位，下次派发会重建。
      }
    }
    state.acpConnected.value = false;
    state.acpHandle.value = null;
    state.acpSessionId.value = null;
    locals.acpSessionThreadId = null;
    state.acpConfigOptions.value = [];
    state.acpImageSupport.value = null;
    state.acpStreamId.value = null;
    state.acpStatus.value = "disconnected";
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
  async function startAcpSession(threadId: string | null = state.chat.activeThreadId): Promise<string | null> {
    const provider = state.agentProviders.value.find((provider) => provider.id === state.selectedProviderId.value);
    if (!provider) return t("errors.acpNotSelected");
    if (!acp.isAvailable()) return t("errors.acpTransportUnavailable");
    let workspace: string;
    try {
      // 当前会话绑定带磁盘文件夹的工作区 → 以该文件夹为 ACP 工作区（权限锚定基准）；
      // 否则回落设置项 workspaceDir 或宿主私有 ~/.greyWork。
      // runMode=worktree 时再由宿主把这套工作区派生为隔离快照。
      workspace = await isolateForRun(activeConversationFolder() ?? (await resolveWorkspaceDir()));
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    await ensureListener();
    const reusedProcess = state.acpHandle.value !== null;
    if (!reusedProcess) state.acpStatus.value = "connecting";
    try {
      // 已有进程就只在它上面另开会话，不再 spawn 第二个 CLI。
      state.acpHandle.value ??= await acp.startAgent(
        provider.command,
        state.settings.effectivePermissionTier,
        state.settings.sandboxMode,
        workspace,
        provider.env,
      );
      if (abortConnecting) return await abortInFlightStart();

      // 惰性恢复：当前对话若落盘了 ACP 绑定、且 provider/cwd 仍一致，先尝试 session/load
      // 接回旧上下文；失败（agent 不支持 / 会话失效）静默回落新建。任何路径都不发错误通知，
      // 保证「发送必达」。
      const binding = threadId !== null ? (state.session.getSession(threadId)?.acp ?? null) : null;
      const canRestore = binding !== null && binding.providerId === provider.id && binding.cwd === workspace;
      let restoredSessionId: string | null = null;
      if (canRestore) {
        try {
          const opened = await acp.loadSession(state.acpHandle.value, workspace, binding.sessionId, state.settings.enabledMcpServers);
          adoptOpenedSession(opened, threadId);
          restoredSessionId = opened.sessionId;
          await settleReplay(opened.sessionId);
        } catch {
          // 回落：清掉恢复标记，下面还是走 session/new（保持孤立分支可读）。
          restoredSessionId = null;
        }
      }
      if (restoredSessionId === null) {
        // 建会话时把启用的 MCP 服务器声明给 agent；宿主按后端能力过滤，
        // 被跳过的原因回灌到 acpMcpSkipped 供设置页明示（不静默丢配置）。
        adoptOpenedSession(await acp.openSession(state.acpHandle.value, workspace, state.settings.enabledMcpServers), threadId);
      }
      if (abortConnecting) return await abortInFlightStart();

      // 落盘绑定（新建或恢复都记，便于下次重启接回）。threadId 为 null 时不绑定具体对话。
      if (threadId !== null) {
        state.session.setAcpBinding(threadId, {
          sessionId: state.acpSessionId.value as string,
          providerId: provider.id,
          cwd: workspace,
          savedAt: Date.now(),
        });
      }
      return null;
    } catch (error) {
      state.acpStatus.value = "error";
      state.acpSessionId.value = null;
      locals.acpSessionThreadId = null;
      // 复用的进程还活着：只清会话、保留 handle，下一次派发能直接重试 session/new。
      // 若进程是本次刚 spawn 的，则连 handle 一起丢弃（与既有恢复语义一致：整条 runtime 重来）。
      if (!reusedProcess) {
        state.acpConnected.value = false;
        state.acpHandle.value = null;
        state.acpConfigOptions.value = [];
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

  /** 设置会话配置选项（模型 / 推理力度等）；返回错误文案（null = 成功）。 */
  async function setAcpConfig(configId: string, value: string | boolean): Promise<string | null> {
    if (state.acpHandle.value === null || !state.acpSessionId.value) return t("errors.sessionNotStarted");
    try {
      // setSessionConfig 返回全量最新快照（含后端确认后的 currentValue）——覆盖本地
      // 控件状态，保证「选择 → 后端确认 → 回填」闭环（对齐 useAcpConfigOptions）。
      const updated = await acp.setSessionConfig(state.acpHandle.value, configId, value);
      if (updated.length > 0) state.acpConfigOptions.value = updated;
      // 记忆到当前工作区：模型 / 思考强度这类选择是「这个项目怎么干活」的一部分，
      // 切回来应当还是它。回放期间不记（见 replayingConfig），否则回放会把自己再写一遍。
      if (!locals.replayingConfig && typeof value === "string" && state.workspace.activeWorkspaceId) {
        state.workspace.setAgentConfig(state.workspace.activeWorkspaceId, { configValues: { [configId]: value } });
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
    const handles = state.acpHandle.value === null ? [] : [state.acpHandle.value];
    for (const handle of locals.runBridge?.collectActiveHandles?.() ?? []) handles.push(handle);
    for (const handle of handles) {
      try {
        await acp.setPermissionTier(handle, state.settings.effectivePermissionTier);
      } catch (error) {
        return t("errors.configFailed", { detail: String(error) });
      }
    }
    return null;
  }

  /** 一键临时降级/回升；返回错误文案（null = 成功）。 */
  async function setTempReadOnly(on: boolean): Promise<string | null> {
    state.settings.tempReadOnly = on;
    return applyPermissionTier();
  }

  /** 主动连接当前 ACP 后端并加载会话配置（幂等：已连接直接返回）。 */
  async function connectAcp(): Promise<string | null> {
    if (state.acpHandle.value !== null && state.acpSessionId.value) return null;
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
    if (acpConnecting.value || state.acpStatus.value === "connecting") {
      abortConnecting = true;
      return;
    }
    clearReplayGuard(); // 停会话即终止回放抑制窗口（如有）。
    if (state.acpHandle.value === null) return;
    try {
      // 有在途回合：精确取消该回合（agent 进程与会话保留，可继续对话）。
      if (state.activeTurnId.value !== null) {
        const turnId = state.activeTurnId.value;
        state.activeTurnId.value = null;
        state.turnStartedAtMs.value = null;
        await acp.stop(state.acpHandle.value, turnId);
      } else {
        await acp.stop(state.acpHandle.value);
        state.acpStatus.value = "disconnected";
        state.acpConnected.value = false;
      }
    } catch (error) {
      if (locals.acpStream && locals.acpThreadId) {
        state.chat.appendMessageContent(
          locals.acpStream.id,
          `\n\n${t("errors.stopFailed", { detail: String(error) })}`,
          locals.acpThreadId,
        );
      }
    }
  }

  /** 重启当前 ACP runtime：停 agent 进程 → 重新 spawn + session/new（重新探测模型/config options）。
   *  对齐 GreyWork AcpRuntimeRestartButton——runtime 卡死/模型探测失败后的恢复路径。 */
  async function restartAcpRuntime(): Promise<string | null> {
    if (state.acpHandle.value === null) return null;
    try {
      await acp.stop(state.acpHandle.value);
    } catch (error) {
      return t("errors.stopCurrentFailed", { detail: String(error) });
    }
    state.acpConnected.value = false;
    state.acpHandle.value = null;
    state.acpSessionId.value = null;
    locals.acpSessionThreadId = null;
    state.acpConfigOptions.value = [];
    dismissPendingPermission();
    state.acpStreamId.value = null;
    state.chat.runningSessionId = null;
    state.activeTurnId.value = null;
    state.turnStartedAtMs.value = null;
    state.acpStatus.value = "disconnected";
    return startAcpSession();
  }

  /** 权限裁决回传宿主；optionId=null 表示拒绝该次操作。 */
  async function respondPermission(optionId: string | null): Promise<void> {
    const pending = pendingPermission.value;
    if (!pending) return;
    dismissPendingPermission();
    const option = optionId ? pending.options.find((candidate) => candidate.optionId === optionId) : undefined;
    // 「始终允许」记进本次会话：同类工具后续免问（消费点在 permission-request 分支）。
    if (option && classifyAcpPermission(option.kind) === "allow-always") alwaysAllowedKinds.add(pending.kind);
    // 留痕替掉原先往正文里追加的 "[权限] xxx" 纯文本：同样的信息做成只读卡片，
    // 且不会把 markdown 流切断。
    writePermissionTrace(permissionTrace(pending, optionId ? (option?.name ?? optionId) : null, "user"));
    try {
      await acp.respondPermission(pending.requestId, optionId);
    } catch (error) {
      if (locals.acpStream && locals.acpThreadId) {
        state.chat.appendMessageContent(
          locals.acpStream.id,
          `\n\n${t("errors.permissionFailed", { detail: String(error) })}`,
          locals.acpThreadId,
        );
      }
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

  // 命令目录跟着会话走：新建 / 恢复 / 停止 / 断开都会改 acpSessionId，旧目录一律作废，
  // 由 agent 在新会话里重新上报（不按事件 sessionId 过滤，避免建会话竞态丢首条目录）。
  // 权限记忆同理由此清空：会话都没了，「本次会话内始终允许」自然失效——所有拆会话的
  // 路径（stop / 切后端 / 切回 Local / 重启 runtime）都会把 acpSessionId 置回 null。
  watch(state.acpSessionId, () => {
    state.acpCommands.value = [];
    alwaysAllowedKinds.clear();
  });

  return {
    startAcpSession,
    setAcpConfig,
    applyPermissionTier,
    setTempReadOnly,
    connectAcp,
    stopAcp,
    restartAcpRuntime,
    respondPermission,
    probeMcpServer,
    dismissPendingPermission,
  };
}
