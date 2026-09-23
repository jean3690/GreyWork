/**
 * agent store 的共享状态注册表：所有切片（providers / runtime / turn）在此登记状态，
 * 切片间通过 `state` 读写同一份 refs 与 `locals`（非响应式可变值）。
 *
 * 为什么要有这份注册表：agent store 的 provider 目录、ACP 运行态、全局回合三块
 * 高度互耦（如 switchToLocalLlm 既改目录选择又清运行态），拆成独立文件后必须
 * 有一处把状态集中起来，切片只交换函数不交换状态。
 */
import type { Agent } from "@greywork/agents";
import type { AcpAvailableCommand, AcpPermissionRequestPayload, AcpSessionConfigOption, McpSkippedServer } from "@greywork/acp";
import { createAgentProviderRegistry, type AgentProviderConfig } from "@greywork/shell";
import { ref, type Ref } from "vue";
import type { AgentProgramProbe } from "../../lib/agents-backend";
import type { ThreadMessage } from "../../types";
import { useChatStore } from "../chat";
import { useSessionStore } from "../session";
import { useSettingsStore } from "../settings";
import { useWorkspaceStore } from "../workspace";
import { providerIconsStorage } from "./shared";
import type { RunEventBridge, GlobalTurnHooks } from "./shared";

/** 非响应式但需跨切片共享的可变状态：放进这里，闭包里用 `let` 声明的同款状态归各切片私有。 */
export interface AgentStoreLocals {
  /** 当前 ACP 回合写入中的 assistant 支架（chat.threads 内），流式续写目标。 */
  acpStream: ThreadMessage | null;
  /** 当前 ACP 回合所在线程 id（与 acpStream 成对；流式续写不依赖 activeThreadId）。 */
  acpThreadId: string | null;
  /** 当前 ACP 会话服务的对话 id（null = 尚未绑定到具体对话）。 */
  acpSessionThreadId: string | null;
  /** 回放工作区记忆配置期间置真，抑制 setAcpConfig 的自反写入。 */
  replayingConfig: boolean;
  /** 已注入 schedule 围栏说明的 ACP 会话 id（每会话一次；adoptOpenedSession 重置）。 */
  scheduleHintInjectedFor: string | null;
  /** 已注入调用方宿主能力提示（如远程文件发送）的 ACP 会话 id（每会话一次；adoptOpenedSession 重置）。 */
  hostHintInjectedFor: string | null;
  /** runs 编排域注册的事件消费桥（子任务会话/句柄归属只存在编排侧，会话域不静态依赖编排域）。 */
  runBridge: RunEventBridge | null;
  /** 在途全局回合的收尾钩子（sendGlobalTurn 置入；prompt-done/异常清空，stopped 不清）。 */
  turnHooks: GlobalTurnHooks | null;
}

export interface AgentStoreState {
  /** 跨 store 依赖（store 实例在 setup 时一次性创建）。 */
  settings: ReturnType<typeof useSettingsStore>;
  chat: ReturnType<typeof useChatStore>;
  workspace: ReturnType<typeof useWorkspaceStore>;
  session: ReturnType<typeof useSessionStore>;
  /** 预设后端注册表（决定「有哪些 / 顺序 / detect/installHint」）。 */
  registry: ReturnType<typeof createAgentProviderRegistry>;
  /** 跨切片共享的可变局部。 */
  locals: AgentStoreLocals;

  /* ===== 助手库 ===== */
  agents: Ref<Agent[]>;
  /* ===== provider 目录域 ===== */
  providerIcons: Ref<Record<string, string>>;
  agentProviders: Ref<AgentProviderConfig[]>;
  selectedProviderId: Ref<string>;
  routeToAcp: Ref<boolean>;
  agentDetection: Ref<Record<string, AgentProgramProbe>>;
  providersHydrated: Promise<void> | null;
  /* ===== ACP 运行态 ===== */
  acpBusy: Ref<boolean>;
  acpConnecting: Ref<boolean>;
  acpHandle: Ref<number | null>;
  acpSessionId: Ref<string | null>;
  pendingPermission: Ref<AcpPermissionRequestPayload | null>;
  permissionDeadline: Ref<number | null>;
  acpStreamId: Ref<string | null>;
  acpConfigOptions: Ref<AcpSessionConfigOption[]>;
  acpMcpServers: Ref<string[]>;
  acpMcpSkipped: Ref<McpSkippedServer[]>;
  acpImageSupport: Ref<boolean | null>;
  acpConnected: Ref<boolean>;
  acpStatus: Ref<"connecting" | "connected" | "session_active" | "disconnected" | "error" | null>;
  activeTurnId: Ref<number | null>;
  turnStartedAtMs: Ref<number | null>;
  acpUsage: Ref<{ used: number; size: number; cost?: { amount: number; currency: string } } | null>;
  acpThoughtText: Ref<string>;
  acpCommands: Ref<AcpAvailableCommand[]>;
}

/** 登记一份全新的共享状态（每次 useAgentStore 实例化都走这里，保持各切片共享同一份）。 */
export function createAgentStoreState(): AgentStoreState {
  const settings = useSettingsStore();
  const chat = useChatStore();
  const workspace = useWorkspaceStore();
  const session = useSessionStore();
  const registry = createAgentProviderRegistry();
  return {
    settings,
    chat,
    workspace,
    session,
    registry,
    locals: {
      acpStream: null,
      acpThreadId: null,
      acpSessionThreadId: null,
      replayingConfig: false,
      scheduleHintInjectedFor: null,
      hostHintInjectedFor: null,
      runBridge: null,
      turnHooks: null,
    },
    agents: ref<Agent[]>([]),
    providerIcons: ref<Record<string, string>>(providerIconsStorage.read()?.icons ?? {}),
    agentProviders: ref<AgentProviderConfig[]>([]),
    selectedProviderId: ref(""),
    routeToAcp: ref(false),
    agentDetection: ref<Record<string, AgentProgramProbe>>({}),
    providersHydrated: null,
    acpBusy: ref(false),
    acpConnecting: ref(false),
    acpHandle: ref<number | null>(null),
    acpSessionId: ref<string | null>(null),
    pendingPermission: ref<AcpPermissionRequestPayload | null>(null),
    permissionDeadline: ref<number | null>(null),
    acpStreamId: ref<string | null>(null),
    acpConfigOptions: ref<AcpSessionConfigOption[]>([]),
    acpMcpServers: ref<string[]>([]),
    acpMcpSkipped: ref<McpSkippedServer[]>([]),
    acpImageSupport: ref<boolean | null>(null),
    acpConnected: ref(false),
    acpStatus: ref<"connecting" | "connected" | "session_active" | "disconnected" | "error" | null>(null),
    activeTurnId: ref<number | null>(null),
    turnStartedAtMs: ref<number | null>(null),
    acpUsage: ref<{ used: number; size: number; cost?: { amount: number; currency: string } } | null>(null),
    acpThoughtText: ref(""),
    acpCommands: ref<AcpAvailableCommand[]>([]),
  };
}
