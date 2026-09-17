/**
 * chat store 状态注册表：store 实例（session / settings / artifact / vfs）与
 * 全部基础响应式 ref。切片共享同一份 `createChatState()` 的产物，职责相关的
 * ref（busy / speedBoost / 发送队列 / 流式消息 id / LLM 可用性）在此统一创建。
 *
 * LLM 流式上下文（llmRequestId / activeTurnToken / streamingInto /
 * llmListening / 缓冲）是 stream 切片的闭包私有，不入本表（与 runtime 切片
 * 的 listening / replayGuard 策略一致）；全程由 API 函数经返回值桥接。
 */
import { computed, ref, type ComputedRef, type Ref } from "vue";
import { createLlmClient } from "@greywork/llm";
import { useArtifactStore } from "../artifact";
import { useSessionStore } from "../session";
import { useSettingsStore } from "../settings";
import { useVfsStore } from "../vfs";
import { selectLlmProvider } from "../chat-llm";
import type { QueuedCommand } from "../../types";

export interface ChatStoreState {
  sessionStore: ReturnType<typeof useSessionStore>;
  settingsStore: ReturnType<typeof useSettingsStore>;
  artifactStore: ReturnType<typeof useArtifactStore>;
  vfsStore: ReturnType<typeof useVfsStore>;
  /** 真实 LLM 管线客户端（openai-compatible 流式；密钥宿主侧解析）。 */
  llm: ReturnType<typeof createLlmClient>;
  /** 回复进行中：submit / 队列 / mock 计时都要据此上锁。 */
  busy: Ref<boolean>;
  /**
   * 当前回合归属的会话 id（null = 没有在跑的回合）。
   *
   * `busy` / `acpBusy` 是全局锁，说不清「哪个会话在跑」。侧栏要按会话显示状态
   * （未开始 / 运行 / 等待中 / 结束），就需要这一个字段把回合钉到具体会话上。
   * 只管置位与清空，状态本身由 lib/session-status 从它 + busy 派生，不落盘。
   */
  runningSessionId: Ref<string | null>;
  /** mock 演示加速开关（ChatView 顶栏）。 */
  speedBoost: Ref<boolean>;
  /** 发送队列（M5）：回复期间下发的消息先入队，回合结束再补发。 */
  commandQueue: Ref<QueuedCommand[]>;
  commandQueueMode: Ref<"auto" | "manual">;
  /** 当前流式续写的消息 id（ChatView 据此切换 StreamText 纯文本渲染，流式结束回 Markdown）。 */
  streamingMessageId: Ref<string | null>;
  /** 最近一次派发是否走了真实管线（false = mock 演示管线）。 */
  llmActive: Ref<boolean>;
  /** 响应式可用性：设置中启用/配置供应商后即时翻转（与 llmActive 无关，不固化于初始化）。 */
  llmReady: ComputedRef<boolean>;
}

export function createChatState(): ChatStoreState {
  const sessionStore = useSessionStore();
  const settingsStore = useSettingsStore();
  const artifactStore = useArtifactStore();
  const vfsStore = useVfsStore();

  const llm = createLlmClient();
  const busy = ref(false);
  const runningSessionId = ref<string | null>(null);
  const speedBoost = ref(false);
  const commandQueue = ref<QueuedCommand[]>([]);
  const commandQueueMode = ref<"auto" | "manual">("auto");
  const streamingMessageId = ref<string | null>(null);
  const llmActive = ref(false);
  const llmReady = computed(
    () => llm.isAvailable() && !!selectLlmProvider(settingsStore.modelProviders, settingsStore.selectedModelProviderId),
  );

  return {
    sessionStore,
    settingsStore,
    artifactStore,
    vfsStore,
    llm,
    busy,
    runningSessionId,
    speedBoost,
    commandQueue,
    commandQueueMode,
    streamingMessageId,
    llmActive,
    llmReady,
  };
}
