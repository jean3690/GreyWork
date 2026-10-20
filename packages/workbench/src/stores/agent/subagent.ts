/**
 * 协议层子代理切片：消费 ACP 的 `subagent_update` / `session_message` /
 * `session_message_chunk`（RFD: Subagent Sessions），维护 agent 内部子会话的
 * 归属树、当前工作状态与会话间消息，并在子代理收工时给出通知。
 *
 * 与应用层「编排子任务」（stores/runs.ts 里 planner 拆解出的并行任务）是两回事：
 *  - 编排子任务：UI 主动 `startAgent` + `openSession`，每个子任务一条独立 handle；
 *  - 协议层子代理：同一个 ACP 连接内，agent 自己创建子会话并用 `subagent_update` 宣告，
 *    父子关系与子会话流量都走同一条连接。
 * 两者靠 sessionId 归属区分：先问 runs 的 runBridge（子任务），未命中再落到本切片。
 *
 * 事件路由（在 runtime 的 session-update 分支里按序调用）：
 *  1. `subagent_update` → 建立/更新归属与状态；
 *  2. `session_message` / `session_message_chunk` → 记入会话间消息（不当作对用户的回答）；
 *  3. 其它 update 且 outer `sessionId` 命中已宣告的子代理 → 归属该子代理（消费掉，
 *     不再写主会话支架）；命中从未宣告过的 session → 先缓冲，等宣告到达再回放
 *     （RFD 允许 SDK 缓冲早到流量；缓冲溢出则整批回落到主会话，宁可展示错位也不丢事件）。
 *
 * 所有处理都是防御式的：字段缺失 / 形状异常 / 循环引用 / 超深嵌套都不抛错，
 * 最坏情况是「不展示这条子代理事件」，绝不影响主会话流。
 */
import { formatDuration, parseToolActivityPayload } from "../../lib/tool-activity";
import { notify } from "../notice";
import { t } from "./shared";
import type { AgentStoreState, SubagentMessage, SubagentState, SubagentTranscript } from "./state";

/** 早到事件缓冲上限（每个未知 session）：超出即整批回落到主会话。 */
const MAX_EARLY_BUFFER = 100;
/**
 * 早到缓冲的回落时限：宣告迟迟不来（例如桌面宿主因 SDK 未纳入草案变体而丢弃了
 * `subagent_update`）时，缓冲里的子会话流量不能无限期扣住 —— 到点整批交回主会话，
 * 宁可展示错位也不静默吞事件。
 */
const EARLY_BUFFER_FALLBACK_MS = 2000;
/** 嵌套深度上限：超出后仍记账、仍消费事件，仅 UI 标注「层级过深」。 */
export const MAX_SUBAGENT_DEPTH = 10;
/** 每个 transcript 保留的会话间消息条数上限（防长跑会话内存膨胀）。 */
const MAX_MESSAGES_PER_SESSION = 200;

/* ===== 载荷形状（宿主经 serde 透传，字段为 camelCase） ===== */

interface SubagentUpdateFields {
  sessionUpdate: "subagent_update";
  /** 子会话 id（outer sessionId 才是父）。 */
  sessionId: string;
  title?: string | null;
  description?: string | null;
  capabilities?: { cancel?: Record<string, never> | null } | null;
  state?: {
    state?: string;
    stopReason?: string | null;
    error?: unknown;
  } | null;
}

interface SessionMessageFields {
  sessionUpdate: "session_message" | "session_message_chunk";
  messageId: string;
  senderSessionId?: string | null;
  recipientSessionId?: string | null;
  /** ContentBlock（chunk）或 ContentBlock[]（whole message）。 */
  content?: unknown;
}

export interface SubagentDeps {
  state: AgentStoreState;
  /** 取消一个子代理会话的当前工作（发 ACP `session/cancel`）；未接线时 cancel 返回 false。 */
  cancelSession?: (handle: number, sessionId: string) => Promise<void>;
  /** 取当前 agent handle（cancel 用）。 */
  getHandle: () => number | null;
  /**
   * 缓冲溢出时的回落：把一条疑似子代理事件交回主会话处理。
   * 由 runtime 注入，避免本切片反向依赖 runtime 的主会话续写逻辑。
   */
  routeToMain: (payload: unknown) => void;
}

export interface SubagentApi {
  /**
   * 尝试消费一条 ACP session-update 载荷（子代理相关）。
   * 返回 true = 已被本切片消费，调用方不要再按主会话处理。
   */
  handleSessionUpdate(payload: unknown): boolean;
  /**
   * 未知 session 的疑似子代理流量：先缓冲，等 `subagent_update` 到达再归属。
   * 返回 true = 已缓冲（调用方不应再按主会话处理）。
   */
  bufferIfSubagentTraffic(payload: unknown): boolean;
  /** 某子代理的树深度（根的子代理 = 1）；未知 session 返回 0。 */
  depthOf(sessionId: string): number;
  /** 某 transcript 的会话间消息（session_message 累积）。 */
  messagesOf(sessionId: string): SubagentMessage[];
  /** 某子代理自身的转录（正文 + 工具）。 */
  transcriptOf(sessionId: string): SubagentTranscript | undefined;
  /** 取消一个子代理的当前工作（需要其宣告了 capabilities.cancel）。返回是否已发出。 */
  cancel(sessionId: string): Promise<boolean>;
  /** 清空全部子代理状态（断连 / 停会话 / 切会话时调用）。 */
  reset(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 从 ACP 载荷里取 `subagent_update` 字段；不是该类型返回 null。 */
export function parseSubagentUpdate(payload: unknown): { parentSessionId: string; fields: SubagentUpdateFields } | null {
  if (!isRecord(payload)) return null;
  const parentSessionId = typeof payload.sessionId === "string" ? payload.sessionId : null;
  const update = payload.update;
  if (!parentSessionId || !isRecord(update)) return null;
  if (update.sessionUpdate !== "subagent_update") return null;
  const childSessionId = typeof update.sessionId === "string" ? update.sessionId : null;
  if (!childSessionId) return null; // RFD：update.sessionId 必需
  return { parentSessionId, fields: update as unknown as SubagentUpdateFields };
}

/** 从 ACP 载荷里取会话间消息字段；不是该类型返回 null。 */
export function parseSessionMessage(payload: unknown): { outerSessionId: string; fields: SessionMessageFields } | null {
  if (!isRecord(payload)) return null;
  const outerSessionId = typeof payload.sessionId === "string" ? payload.sessionId : null;
  const update = payload.update;
  if (!outerSessionId || !isRecord(update)) return null;
  const kind = update.sessionUpdate;
  if (kind !== "session_message" && kind !== "session_message_chunk") return null;
  const messageId = typeof update.messageId === "string" ? update.messageId : null;
  if (!messageId) return null; // RFD：messageId 必需
  return { outerSessionId, fields: update as unknown as SessionMessageFields };
}

/** 把 ContentBlock / ContentBlock[] 里的可读文本抽出来（非文本块给类型占位）。 */
export function textFromContent(content: unknown): string {
  const blocks = Array.isArray(content) ? content : content === undefined || content === null ? [] : [content];
  const parts: string[] = [];
  for (const block of blocks) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (!isRecord(block)) continue;
    if (typeof block.text === "string") parts.push(block.text);
    else if (isRecord(block.resource) && typeof block.resource.text === "string") parts.push(block.resource.text);
    else if (block.type === "image" || block.type === "audio") {
      parts.push(typeof block.mimeType === "string" ? `[${block.type} ${block.mimeType}]` : `[${block.type}]`);
    }
  }
  return parts.join("");
}

/** 归一化工作状态；未识别保留 `unknown`（RFD：未知值不表示完成，仅记账）。 */
function normalizeState(raw: string | undefined | null): NonNullable<SubagentState["state"]> {
  switch (raw) {
    case "running":
      return { state: "running" };
    case "requires_action":
      return { state: "requires_action" };
    case "idle":
      return { state: "idle" };
    default:
      return { state: "unknown" };
  }
}

export function createSubagentSlice({ state, cancelSession, getHandle, routeToMain }: SubagentDeps): SubagentApi {
  const locals = state.locals;

  /** 重建响应式列表（Map 本身不触发 Vue；列表是 UI 的读取面）。 */
  function syncList(): void {
    state.protocolSubagents.value = [...locals.subagentsById.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  function linkChild(parentSessionId: string, childSessionId: string): void {
    let children = locals.childrenByParent.get(parentSessionId);
    if (!children) {
      children = new Set();
      locals.childrenByParent.set(parentSessionId, children);
    }
    children.add(childSessionId);
  }

  /** 应用状态快照（替换语义）+ 收工通知。 */
  function applyState(target: SubagentState, raw: NonNullable<SubagentUpdateFields["state"]>): NonNullable<SubagentState["state"]> {
    const previous = target.state;
    const next = normalizeState(raw.state);
    if (next.state === "idle") {
      next.stopReason = typeof raw.stopReason === "string" ? raw.stopReason : undefined;
      next.error = raw.error ?? undefined;
    }
    if (next.state === "idle" && previous && previous.state !== "idle") {
      announceIdle(target, next);
      locals.subagentNotifiedIdle.add(target.sessionId);
    } else if (next.state === "running" || next.state === "requires_action") {
      // 重新开工：允许下一次 idle 再次通知。
      locals.subagentNotifiedIdle.delete(target.sessionId);
    }
    return next;
  }

  /** 子代理从运行态转入 idle：按 stopReason 给一次非侵入式通知。 */
  function announceIdle(target: SubagentState, next: NonNullable<SubagentState["state"]>): void {
    const title = target.title || t("subagent.fallbackTitle");
    if (next.state !== "idle") return;
    if (next.stopReason === "error") {
      const detail = typeof next.error === "string" ? next.error : undefined;
      notify({ kind: "error", key: `subagent-${target.sessionId}`, title: t("subagent.failed", { title }), detail });
      return;
    }
    if (next.stopReason === "cancelled") {
      notify({ kind: "info", key: `subagent-${target.sessionId}`, title: t("subagent.cancelled", { title }) });
      return;
    }
    notify({
      kind: "success",
      key: `subagent-${target.sessionId}`,
      title: t("subagent.completed", { title }),
      detail: t("subagent.completedDetail", { duration: formatDuration(Date.now() - target.createdAt) }),
    });
  }

  /** 处理 `subagent_update`：首见建立归属、后续 patch 元数据 / 状态。 */
  function handleSubagentUpdate(parentSessionId: string, fields: SubagentUpdateFields): void {
    const childSessionId = fields.sessionId;
    // 防御：不能自引用（RFD：association 不得 refer to itself / 建环）。
    if (childSessionId === parentSessionId) return;

    const now = Date.now();
    const existing = locals.subagentsById.get(childSessionId);
    if (existing) {
      // 已宣告过：patch 语义（省略 = 不变；null = 清空；具体值 = 替换）。
      if (fields.title !== undefined) existing.title = fields.title;
      if (fields.description !== undefined) existing.description = fields.description;
      if (fields.capabilities !== undefined) existing.capabilities = fields.capabilities ?? undefined;
      if (fields.state !== undefined) existing.state = fields.state === null ? undefined : applyState(existing, fields.state);
      existing.updatedAt = now;
      syncList();
      return;
    }

    const child: SubagentState = {
      sessionId: childSessionId,
      parentSessionId,
      title: fields.title ?? null,
      description: fields.description ?? null,
      capabilities: fields.capabilities ?? undefined,
      createdAt: now,
      updatedAt: now,
      toolCount: 0,
      lastText: "",
    };
    if (fields.state !== undefined && fields.state !== null) child.state = applyState(child, fields.state);
    locals.subagentsById.set(childSessionId, child);
    linkChild(parentSessionId, childSessionId);
    syncList();

    // 早到流量回放：宣告前的子代理事件先攒着，现在归属确定，逐条消费。
    const buffered = locals.subagentEarlyBuffer.get(childSessionId);
    if (buffered?.length) {
      locals.subagentEarlyBuffer.delete(childSessionId);
      clearEarlyTimer(childSessionId);
      for (const event of buffered) handleSessionUpdate(event);
    }
  }

  /** 记录一条会话间消息（chunk 追加，whole message 以整体替换语义覆盖 content）。 */
  function handleSessionMessage(outerSessionId: string, fields: SessionMessageFields): void {
    let list = locals.subagentMessages.get(outerSessionId);
    if (!list) {
      list = [];
      locals.subagentMessages.set(outerSessionId, list);
    }
    const text = textFromContent(fields.content);
    const existing = list.find((message) => message.messageId === fields.messageId);
    const isChunk = fields.sessionUpdate === "session_message_chunk";
    if (existing) {
      // chunk 追加；whole message（content 有值）整体替换，无 content 则只补参与者。
      if (isChunk) existing.text += text;
      else if (fields.content !== undefined) existing.text = text;
      if (fields.senderSessionId !== undefined) existing.senderSessionId = fields.senderSessionId;
      if (fields.recipientSessionId !== undefined) existing.recipientSessionId = fields.recipientSessionId;
      existing.updatedAt = Date.now();
    } else {
      list.push({
        messageId: fields.messageId,
        outerSessionId,
        senderSessionId: fields.senderSessionId ?? null,
        recipientSessionId: fields.recipientSessionId ?? null,
        text,
        updatedAt: Date.now(),
      });
    }
    if (list.length > MAX_MESSAGES_PER_SESSION) list.splice(0, list.length - MAX_MESSAGES_PER_SESSION);
  }

  /** 缓冲一条无法归属的疑似子代理事件。 */
  function bufferEarly(sessionId: string, payload: unknown): void {
    let buffer = locals.subagentEarlyBuffer.get(sessionId);
    if (!buffer) {
      buffer = [];
      locals.subagentEarlyBuffer.set(sessionId, buffer);
      // 首次缓冲即起回落定时器：宣告不来则到点交回主会话（见 EARLY_BUFFER_FALLBACK_MS）。
      const timer = setTimeout(() => {
        locals.subagentEarlyTimers.delete(sessionId);
        flushEarlyToMain(sessionId);
      }, EARLY_BUFFER_FALLBACK_MS);
      locals.subagentEarlyTimers.set(sessionId, timer);
    }
    buffer.push(payload);
    if (buffer.length > MAX_EARLY_BUFFER) {
      // 宣告迟迟不来：整批交回主会话处理，宁可展示错位也不吞事件。
      flushEarlyToMain(sessionId);
    }
  }

  /** 把某 session 的早到缓冲整批交回主会话（清缓冲 + 清定时器）。 */
  function flushEarlyToMain(sessionId: string): void {
    const buffer = locals.subagentEarlyBuffer.get(sessionId);
    if (!buffer) return;
    locals.subagentEarlyBuffer.delete(sessionId);
    clearEarlyTimer(sessionId);
    for (const event of buffer) routeToMain(event);
  }

  /** 清掉某 session 的早到回落定时器（宣告到达 / reset 时调用）。 */
  function clearEarlyTimer(sessionId: string): void {
    const timer = locals.subagentEarlyTimers.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    locals.subagentEarlyTimers.delete(sessionId);
  }

  /** 归属一个已知子代理的自身流量（工具 / 正文 / 思考）：消费掉并累积转录，不泄漏进主会话。 */
  function consumeChildContent(sessionId: string, payload: unknown): void {
    const child = locals.subagentsById.get(sessionId);
    if (!child) return;
    let transcript = locals.subagentTranscripts.get(sessionId);
    if (!transcript) {
      transcript = { text: "", tools: [] };
      locals.subagentTranscripts.set(sessionId, transcript);
    }
    const toolActivities = parseToolActivityPayload(payload);
    if (toolActivities.length > 0) {
      transcript.tools.push(...toolActivities);
      child.toolCount = transcript.tools.length;
    }
    const update = isRecord(payload) && isRecord(payload.update) ? payload.update : null;
    const kind = update && typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
      const text = isRecord(update?.content) && typeof update.content.text === "string" ? update.content.text : "";
      if (text) {
        transcript.text += text;
        child.lastText = text.slice(-200);
      }
    }
    child.updatedAt = Date.now();
    syncList();
  }

  function handleSessionUpdate(payload: unknown): boolean {
    const association = parseSubagentUpdate(payload);
    if (association) {
      handleSubagentUpdate(association.parentSessionId, association.fields);
      return true;
    }
    const message = parseSessionMessage(payload);
    if (message) {
      handleSessionMessage(message.outerSessionId, message.fields);
      return true;
    }
    // 已知子代理的自身流量：归属该子代理（消费，不进主会话支架）。
    const outer = isRecord(payload) && typeof payload.sessionId === "string" ? payload.sessionId : null;
    if (outer && locals.subagentsById.has(outer)) {
      consumeChildContent(outer, payload);
      return true;
    }
    return false;
  }

  function bufferIfSubagentTraffic(payload: unknown): boolean {
    const outer = isRecord(payload) && typeof payload.sessionId === "string" ? payload.sessionId : null;
    if (!outer) return false;
    if (locals.subagentsById.has(outer)) return false; // 已知子代理：交上层消费
    bufferEarly(outer, payload);
    return true;
  }

  function depthOf(sessionId: string): number {
    let depth = 0;
    const seen = new Set<string>([sessionId]);
    let cursor = locals.subagentsById.get(sessionId)?.parentSessionId;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      depth += 1;
      if (depth > MAX_SUBAGENT_DEPTH + 1) break; // 环 / 超深防御
      cursor = locals.subagentsById.get(cursor)?.parentSessionId;
    }
    return depth;
  }

  async function cancel(sessionId: string): Promise<boolean> {
    const child = locals.subagentsById.get(sessionId);
    if (!child?.capabilities?.cancel) return false;
    const handle = getHandle();
    if (handle === null || !cancelSession) return false;
    try {
      await cancelSession(handle, sessionId);
      return true;
    } catch {
      return false;
    }
  }

  function reset(): void {
    for (const timer of locals.subagentEarlyTimers.values()) clearTimeout(timer);
    locals.subagentEarlyTimers.clear();
    locals.subagentsById.clear();
    locals.childrenByParent.clear();
    locals.subagentEarlyBuffer.clear();
    locals.subagentNotifiedIdle.clear();
    locals.subagentMessages.clear();
    locals.subagentTranscripts.clear();
    syncList();
  }

  return {
    handleSessionUpdate,
    bufferIfSubagentTraffic,
    depthOf,
    messagesOf: (sessionId) => locals.subagentMessages.get(sessionId) ?? [],
    transcriptOf: (sessionId) => locals.subagentTranscripts.get(sessionId),
    cancel,
    reset,
  };
}
