/**
 * agent store 装配入口（文件夹 facade）。
 *
 * 三层切片共享 `createAgentStoreState()` 造的同一份状态注册表；切片间的循环函数依赖
 * （runtime→turn 的 writeTurnError、turn→runtime 的 startAcpSession、providers→runtime
 * 的 connectAcp 等）经 `api` 持有者 + 惰性 getter 解决——任何切片的函数都要到实际
 * 调用时才跨切片取值，因此装配顺序无关紧要。
 *
 * 公开 store API（returns 的键）与原 `stores/agent.ts` 完全一致。
 */
import { defineStore } from "pinia";
import { acp } from "../../lib/acp-client";
import { isCustomAgentProvider } from "./shared";
import type { GlobalTurnEndContext, GlobalTurnHooks, GlobalTurnOptions, RunEventBridge } from "./shared";
import { createProvidersSlice, type ProvidersApi } from "./providers";
import { createRuntimeSlice, type RuntimeApi } from "./runtime";
import { createTurnSlice, type TurnApi } from "./turn";
import { createAgentStoreState } from "./state";

export type { GlobalTurnEndContext, GlobalTurnHooks, GlobalTurnOptions, RunEventBridge };

export const useAgentStore = defineStore("agent", () => {
  const state = createAgentStoreState();

  /** 惰性 api 绑定：切片在此第一时间全部装配，但**互相只经 getter 访问**。 */
  const api: { runtime: RuntimeApi | null; turn: TurnApi | null; providers: ProvidersApi | null } = {
    runtime: null,
    turn: null,
    providers: null,
  };
  const getRuntime = (): RuntimeApi => api.runtime as RuntimeApi;
  const getTurn = (): TurnApi => api.turn as TurnApi;

  api.providers = createProvidersSlice({ state, getRuntime });
  api.runtime = createRuntimeSlice({ state, getTurn });
  api.turn = createTurnSlice({ state, getRuntime });
  const providers = api.providers;
  const runtime = api.runtime;
  const turn = api.turn;

  return {
    agents: state.agents,
    agentProviders: state.agentProviders,
    selectedProviderId: state.selectedProviderId,
    routeToAcp: state.routeToAcp,
    acpBusy: state.acpBusy,
    acpConnecting: state.acpConnecting,
    pendingPermission: state.pendingPermission,
    acpConfigOptions: state.acpConfigOptions,
    permissionDeadline: state.permissionDeadline,
    acpMcpServers: state.acpMcpServers,
    acpMcpSkipped: state.acpMcpSkipped,
    acpImageSupport: state.acpImageSupport,
    acpStreamId: state.acpStreamId,
    acpStatus: state.acpStatus,
    acpConnected: state.acpConnected,
    activeTurnId: state.activeTurnId,
    turnStartedAtMs: state.turnStartedAtMs,
    acpUsage: state.acpUsage,
    acpThoughtText: state.acpThoughtText,
    acpCommands: state.acpCommands,
    /** 后端目录启动接管完成信号（null = 浏览器态无后端）。 */
    providersHydrated: state.providersHydrated,
    agentDetection: state.agentDetection,
    refreshAgentDetection: providers.refreshAgentDetection,
    providerInstalled: providers.providerInstalled,
    providerInstallLabel: providers.providerInstallLabel,
    setAgentProviderEnabled: providers.setAgentProviderEnabled,
    isCustomAgentProvider,
    addAgentProvider: providers.addAgentProvider,
    updateAgentProvider: providers.updateAgentProvider,
    removeAgentProvider: providers.removeAgentProvider,
    setAgentProviderIcon: providers.setAgentProviderIcon,
    setAcpConfig: runtime.setAcpConfig,
    connectAcp: runtime.connectAcp,
    activateAcpProvider: providers.activateAcpProvider,
    /** 编排域内部契约：全局回合派发（planner 阶段经 hooks 收尾）与事件消费桥注册。 */
    sendGlobalTurn: turn.sendGlobalTurn,
    attachRunBridge: turn.attachRunBridge,
    setTempReadOnly: runtime.setTempReadOnly,
    applyPermissionTier: runtime.applyPermissionTier,
    applyWorkspaceAgentConfig: providers.applyWorkspaceAgentConfig,
    acpAvailable: acp.isAvailable(),
    selectProvider: providers.selectProvider,
    toggleRouteToAcp: providers.toggleRouteToAcp,
    switchToLocalLlm: providers.switchToLocalLlm,
    restartAcpRuntime: runtime.restartAcpRuntime,
    dispatchToAcp: turn.dispatchToAcp,
    beginAcpPlan: turn.beginAcpPlan,
    confirmAcpPlan: turn.confirmAcpPlan,
    stopAcp: runtime.stopAcp,
    respondPermission: runtime.respondPermission,
    probeMcpServer: runtime.probeMcpServer,
  };
});
