/**
 * ACP 权限门：待裁决请求的卡片状态、120s 镜像超时、留痕、免问直答与用户裁决。
 *
 * 从 `runtime.ts` 拆出（P5 大文件拆分）：权限裁决是一个内聚单元 —— 事件监听把
 * `permission-request` 交给它弹卡，用户点选 / 超时后它回传宿主并留痕；runtime 只
 * 保留会话生命周期与事件路由。
 */
import type { AcpPermissionRequestPayload } from "@greywork/acp";
// 走 ./permissions 子路径而不是包根：那是无依赖的纯分类层。包根会连带拉起 client.ts
// （@tauri-apps/api / ACP SDK），而权限分类在测试里必须能独立于传输层加载。
import { classifyAcpPermission, safeAllowOnceId } from "@greywork/acp/permissions";
import { acp } from "../../lib/acp-client";
import { permissionCommand } from "../../lib/permission-detail";
import { notify } from "../notice";
import { t } from "./shared";
import type { AgentStoreState } from "./state";
import type { PermissionTrace } from "../../types";

/** 权限确认截止窗口（ms）：与宿主 PERMISSION_CONFIRM_TIMEOUT 同一 120s。 */
const PERMISSION_TIMEOUT_MS = 120_000;

export interface PermissionGateApi {
  /** 用户此前对该类别选过「始终允许」时返回免问直答的 optionId；undefined = 未记住，照常弹卡。 */
  rememberedOptionId(payload: AcpPermissionRequestPayload): string | undefined;
  /** 免问直答：留痕 + 回传宿主（不弹卡）。 */
  autoRespond(payload: AcpPermissionRequestPayload, optionId: string): Promise<void>;
  /** 弹卡：置待决请求并起 120s 镜像超时。 */
  arm(payload: AcpPermissionRequestPayload): void;
  /** 统一清场（respondPermission / 断开 / 切后端 / 重启）。 */
  dismiss(): void;
  /** 用户裁决回传宿主；optionId=null 表示拒绝该次操作。 */
  respond(optionId: string | null): Promise<void>;
  /** 会话切换时清空「本次会话内始终允许」记忆。 */
  clearRemembered(): void;
}

export function createPermissionGate(state: AgentStoreState): PermissionGateApi {
  const pendingPermission = state.pendingPermission;
  const permissionDeadline = state.permissionDeadline;
  let permissionTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 本次 ACP 会话内已被「始终允许」的工具类别。
   *
   * 按 kind 记而不是按 optionId：optionId 是各 agent 自定的（opencode 用 "always"，
   * 别的后端可能是 "allow-always"），存下来换个后端就是一堆废键。类别语义跨后端一致。
   */
  const alwaysAllowedKinds = new Set<string>();

  /** 清权限定时器：任何清 pending 的路径都必须先走这里，否则定时器会打在已删除的通知上。 */
  function clearPermissionTimer(): void {
    if (permissionTimer !== null) {
      clearTimeout(permissionTimer);
      permissionTimer = null;
    }
    permissionDeadline.value = null;
  }

  /** 置起 120s 超时窗口：宿主到时取消工具调用，前端镜像同一时刻收卡并通知。 */
  function armTimer(): void {
    clearPermissionTimer();
    if (!pendingPermission.value) return;
    permissionDeadline.value = Date.now() + PERMISSION_TIMEOUT_MS;
    permissionTimer = setTimeout(() => {
      permissionTimer = null;
      const pending = pendingPermission.value;
      if (!pending) return;
      pendingPermission.value = null;
      permissionDeadline.value = null;
      writePermissionTrace(permissionTrace(pending, null, "timeout"));
      notify({ kind: "warning", key: "permission-timeout", title: t("errors.permissionTimedOut") });
    }, PERMISSION_TIMEOUT_MS);
  }

  function dismiss(): void {
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
    if (!state.locals.acpStream || !state.locals.acpThreadId) return;
    state.chat.setPermissionTrace(trace, state.locals.acpStream.id, state.locals.acpThreadId);
  }

  /**
   * 免问直答：用户此前对该类别选过「始终允许」，替他答掉这条请求。
   *
   * 走这里而不是 respond：那条路径要先弹卡再收卡，视觉上会闪一下，
   * 而用户的本意恰恰是「别再问我」。留痕照写，回看时能解释清「这次为什么没问」。
   */
  async function autoRespond(payload: AcpPermissionRequestPayload, optionId: string): Promise<void> {
    const choice = payload.options.find((option) => option.optionId === optionId)?.name ?? optionId;
    // 先留痕再回传：回传失败也不该把「发生过的事」丢掉。
    writePermissionTrace(permissionTrace(payload, choice, "auto"));
    try {
      await acp.respondPermission(payload.requestId, optionId);
    } catch (error) {
      if (state.locals.acpStream && state.locals.acpThreadId) {
        state.chat.appendMessageContent(
          state.locals.acpStream.id,
          `\n\n${t("errors.permissionFailed", { detail: String(error) })}`,
          state.locals.acpThreadId,
        );
      }
    }
  }

  async function respond(optionId: string | null): Promise<void> {
    const pending = pendingPermission.value;
    if (!pending) return;
    dismiss();
    const option = optionId ? pending.options.find((candidate) => candidate.optionId === optionId) : undefined;
    // 「始终允许」记进本次会话：同类工具后续免问（消费点在 rememberedOptionId）。
    if (option && classifyAcpPermission(option.kind) === "allow-always") alwaysAllowedKinds.add(pending.kind);
    // 留痕替掉原先往正文里追加的 "[权限] xxx" 纯文本：同样的信息做成只读卡片，
    // 且不会把 markdown 流切断。
    writePermissionTrace(permissionTrace(pending, optionId ? (option?.name ?? optionId) : null, "user"));
    try {
      await acp.respondPermission(pending.requestId, optionId);
    } catch (error) {
      if (state.locals.acpStream && state.locals.acpThreadId) {
        state.chat.appendMessageContent(
          state.locals.acpStream.id,
          `\n\n${t("errors.permissionFailed", { detail: String(error) })}`,
          state.locals.acpThreadId,
        );
      }
    }
  }

  /** 用户此前对该类别选过「始终允许」时，免问直答用的 optionId（否则 undefined）。 */
  function rememberedOptionId(payload: AcpPermissionRequestPayload): string | undefined {
    if (!alwaysAllowedKinds.has(payload.kind)) return undefined;
    return (
      safeAllowOnceId(payload.options) ?? payload.options.find((option) => classifyAcpPermission(option.kind) === "allow-always")?.optionId
    );
  }

  function clearRemembered(): void {
    alwaysAllowedKinds.clear();
  }

  return {
    rememberedOptionId,
    autoRespond,
    arm: (payload) => {
      pendingPermission.value = payload;
      armTimer();
    },
    dismiss,
    respond,
    clearRemembered,
  };
}
