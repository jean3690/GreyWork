import { AGENT_ROLES, MOCK_AGENTS } from "@greywork/agents";
import { createAcpClient, desktopHomeDir, type AcpPermissionRequestPayload, type AcpSessionConfigOption } from "@greywork/acp";
import { createAgentProviderRegistry, type AgentProviderConfig } from "@greywork/shell";
import { createAcpAgentAdapter } from "@greywork/integrations";
import { defineStore } from "pinia";
import { ref } from "vue";
import { useChatStore } from "./chat";
import { useSettingsStore } from "./settings";
import type { ThreadMessage } from "../types";

export interface WorkflowStep {
  id: string;
  label: string;
  status: "wait" | "active" | "done";
  desc: string;
}

const acpAdapter = createAcpAgentAdapter(createAcpClient());

/** Agent 编排：编队 / 流水线 / 循环策略 / ACP 后端派发（AgentsView 与 Chat·Cowork 数据源）。 */
export const useAgentStore = defineStore("agent", () => {
  const settings = useSettingsStore();
  const chat = useChatStore();
  const agents = ref(MOCK_AGENTS.map((agent) => ({ ...agent })));
  const roles = ref(AGENT_ROLES);
  const workflowSteps = ref<WorkflowStep[]>([
    { id: "collect", label: "数据采集", status: "done", desc: "多源并行抓取与清洗" },
    { id: "analyze", label: "空间分析", status: "active", desc: "DuckDB-WASM 空间 SQL 聚合" },
    { id: "report", label: "报告生成", status: "wait", desc: "汇总结论与交付物" },
    { id: "review", label: "交叉审查", status: "wait", desc: "第二 Agent 复核结论" },
  ]);

  /* ===== ACP 后端（工作台接入） ===== */
  const agentProviderRegistry = createAgentProviderRegistry();
  const agentProviders = ref<AgentProviderConfig[]>(agentProviderRegistry.list());
  const selectedProviderId = ref<string>(agentProviders.value[0]?.id ?? "");
  /** 派发开关：开 = 意图发给选中 ACP 后端；关 = 内部 LLM / mock 管线 */
  const routeToAcp = ref(false);
  const acpBusy = ref(false);
  const acpHandle = ref<number | null>(null);
  const acpSessionId = ref<string | null>(null);
  /** 待前端裁决的权限请求；null = 无待决项（auto 决策只进通知流） */
  const pendingPermission = ref<AcpPermissionRequestPayload | null>(null);
  /** 当前 ACP 回合写入中的 assistant 支架（chat.threads 内），流式续写目标。 */
  let acpStream: ThreadMessage | null = null;
  /** 事件监听只挂一次 */
  let listening = false;
  /** 连接中标记：connectAcp 防重入。 */
  const acpConnecting = ref(false);
  /** 当前会话的配置选择器（模型 / 推理力度 / 会话模式等）；空 = agent 未暴露。 */
  const acpConfigOptions = ref<AcpSessionConfigOption[]>([]);

  async function ensureListener(): Promise<void> {
    if (listening) return;
    listening = true;
    await acpAdapter.onEvent((event) => {
      if (event.kind === "session-update") {
        const payload = event.payload as { update?: { sessionUpdate?: string; content?: { text?: string } } };
        if (payload.update?.sessionUpdate === "agent_message_chunk" && acpStream) {
          const text = payload.update.content?.text ?? "";
          if (text) chat.appendMessageContent(acpStream.id, text);
        }
      } else if (event.kind === "permission-auto") {
        // 宿主按档位自动决策（daily 只读 / auto 直通）：追加一行通知，不打断流
        const payload = event.payload as AcpPermissionRequestPayload;
        if (acpStream) chat.appendMessageContent(acpStream.id, `\n\n> 宿主自动批准 · ${payload.title ?? payload.kind} → ${payload.chosen ?? ""}`);
      } else if (event.kind === "permission-request") {
        // cautious / daily 非只读：转发到确认卡片（ChatView 内联渲染）
        pendingPermission.value = event.payload as AcpPermissionRequestPayload;
      } else if (event.kind === "prompt-done") {
        if (acpStream) {
          const message = chat.threads[chat.activeThreadId]?.find((candidate) => candidate.id === acpStream?.id);
          if (message && !message.content.trim()) chat.setMessageContent(message.id, "（本次回合无文本输出）");
        }
        acpStream = null;
        acpBusy.value = false;
      } else if (event.kind === "stopped") {
        if (acpStream) {
          chat.appendMessageContent(acpStream.id, "\n\n[已停止]");
          acpStream = null;
        }
        acpHandle.value = null;
        acpSessionId.value = null;
        acpConfigOptions.value = [];
        acpBusy.value = false;
        pendingPermission.value = null;
      }
    });
  }

  /** 工作区目录：设置项优先，否则取桌面主目录；宿主侧仍会做绝对路径/非根校验。 */
  async function resolveWorkspace(): Promise<string> {
    const configured = settings.workspaceDir.trim();
    if (configured) return configured;
    const home = await desktopHomeDir();
    if (!home) throw new Error("无法解析工作区目录：请在设置中配置 workspaceDir");
    return home;
  }

  /** 启动 ACP 后端会话；返回错误文案（null = 成功）。 */
  async function startAcpSession(): Promise<string | null> {
    const provider = agentProviders.value.find((provider) => provider.id === selectedProviderId.value);
    if (!provider) return "未选择 ACP 后端";
    if (!acpAdapter.isAvailable()) return "当前未配置可用 ACP 传输：本地 ACP 需桌面端（Tauri），远程 ACP 需配置 WebSocket endpoint。";
    let workspace: string;
    try {
      workspace = await resolveWorkspace();
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    await ensureListener();
    try {
      acpHandle.value = await acpAdapter.startAgent(provider.command, settings.permissionTier);
      const opened = await acpAdapter.openSession(acpHandle.value, workspace);
      acpSessionId.value = opened.sessionId;
      acpConfigOptions.value = opened.configOptions;
      return null;
    } catch (error) {
      acpHandle.value = null;
      acpSessionId.value = null;
      acpConfigOptions.value = [];
      return `启动失败：${String(error)}`;
    }
  }

  /**
   * 派发意图到选中 ACP 后端：user/assistant 消息先入当前线程，
   * 宿主事件（chunk / 权限 / 停止）驱动支架消息流式续写。
   */
  async function dispatchToAcp(text: string): Promise<void> {
    if (acpBusy.value) return;
    const message = chat.startAcpTurn(
      text,
      agentProviders.value.find((provider) => provider.id === selectedProviderId.value)?.name ?? "ACP",
    );
    acpStream = message;
    if (acpHandle.value === null || acpSessionId.value === null) {
      const failure = await startAcpSession();
      if (failure) {
        chat.setMessageContent(message.id, `[ACP 启动失败] ${failure}`);
        acpStream = null;
        return;
      }
    }
    acpBusy.value = true;
    try {
      await acpAdapter.prompt(acpHandle.value as number, text);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const current = chat.threads[chat.activeThreadId]?.find((candidate) => candidate.id === message.id);
      chat.setMessageContent(message.id, current?.content ? `${current.content}\n\n[ACP 派发失败] ${detail}` : `[ACP 派发失败] ${detail}`);
    } finally {
      acpStream = null;
      acpBusy.value = false;
    }
  }

  /** 设置会话配置选项（模型 / 推理力度等）；返回错误文案（null = 成功）。 */
  async function setAcpConfig(configId: string, value: string | boolean): Promise<string | null> {
    if (acpHandle.value === null || !acpSessionId.value) return "会话未启动";
    try {
      acpConfigOptions.value = await acpAdapter.setSessionConfig(acpHandle.value, configId, value);
      return null;
    } catch (error) {
      return `配置失败：${String(error)}`;
    }
  }

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
    if (acpHandle.value === null) return;
    try {
      await acpAdapter.stop(acpHandle.value);
    } catch (error) {
      if (acpStream) chat.appendMessageContent(acpStream.id, `\n\n[停止失败] ${String(error)}`);
    }
  }

  /** 切换首页 ACP CLI 入口。切换已有连接时先释放旧 agent，避免跨 provider 复用 session。 */
  async function activateAcpProvider(id: string): Promise<string | null> {
    const provider = agentProviders.value.find((candidate) => candidate.id === id);
    if (!provider) return "未选择 ACP 后端";
    if (!provider.enabled) return provider.name + " 尚未启用";
    if (selectedProviderId.value !== id && acpHandle.value !== null) {
      try {
        await acpAdapter.stop(acpHandle.value);
      } catch (error) {
        return "停止当前 ACP 会话失败：" + String(error);
      }
      acpHandle.value = null;
      acpSessionId.value = null;
      acpConfigOptions.value = [];
      pendingPermission.value = null;
    }
    selectedProviderId.value = id;
    routeToAcp.value = true;
    return null;
  }

  /** 权限裁决回传宿主；optionId=null 表示拒绝该次操作。 */
  async function respondPermission(optionId: string | null): Promise<void> {
    const pending = pendingPermission.value;
    if (!pending) return;
    pendingPermission.value = null;
    const choice = optionId ? (pending.options.find((option) => option.optionId === optionId)?.name ?? optionId) : "拒绝";
    try {
      await acpAdapter.respondPermission(pending.requestId, optionId);
      if (acpStream) chat.appendMessageContent(acpStream.id, `\n\n[权限] ${choice} · ${pending.title ?? pending.kind}`);
    } catch (error) {
      if (acpStream) chat.appendMessageContent(acpStream.id, `\n\n[权限回传失败] ${String(error)}`);
    }
  }

  function selectProvider(id: string): void {
    selectedProviderId.value = id;
  }

  function toggleRouteToAcp(): void {
    routeToAcp.value = !routeToAcp.value;
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
    setAcpConfig,
    connectAcp,
    activateAcpProvider,
    acpAvailable: acpAdapter.isAvailable(),
    selectProvider,
    toggleRouteToAcp,
    dispatchToAcp,
    stopAcp,
    respondPermission,
  };
});
