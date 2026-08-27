import { useArtifactStore } from "./artifact";
import { useProjectStore } from "./project";
import { useSettingsStore } from "./settings";
import { useVfsStore } from "./vfs";
import { createLlmClient } from "@greywork/llm";
import { buildLlmHistory, selectLlmProvider } from "./chat-llm";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { ChatStep, CommandEntry, ThreadMessage } from "../types";

export const CHAT_EFFORTS = [
  { value: "low", label: "low", desc: "最快响应，适合简单指令" },
  { value: "medium", label: "medium", desc: "平衡速度与深度" },
  { value: "high", label: "high", desc: "更深思考，适合复杂任务" },
  { value: "xhigh", label: "xhigh", desc: "最深推理，更慢且更耗 token" },
] as const;
export type ChatEffort = (typeof CHAT_EFFORTS)[number]["value"];

export const CHAT_SUGGESTIONS = [
  "梳理项目本周改动并生成日报",
  "跑一遍测试，修复失败的用例",
  "重构工作台三栏布局组件",
  "分析站点客流数据并输出报表",
];

let msgSeq = 0;
function uid(): string {
  msgSeq += 1;
  return `m-${msgSeq}`;
}

let simTimers: ReturnType<typeof setTimeout>[] = [];
function clearSim(): void {
  simTimers.forEach(clearTimeout);
  simTimers = [];
}

/** mock 规划器：按意图文本生成步骤时间线。 */
export function buildSteps(text: string): ChatStep[] {
  const steps: ChatStep[] = [{ kind: "read", label: "读取上下文", detail: "workspace · greywork/", status: "wait" }];
  if (/测试|test/i.test(text)) {
    steps.push({ kind: "exec", label: "运行测试", detail: "pnpm vitest run", status: "wait" });
    steps.push({ kind: "test", label: "汇总测试结果", detail: "38 passed · 0 failed", status: "wait" });
  } else if (/日报|周报|报告/.test(text)) {
    steps.push({ kind: "search", label: "检索任务记录", detail: "近 7 天 · 24 条动态", status: "wait" });
    steps.push({ kind: "write", label: "生成报告", detail: "reports/weekly.md", status: "wait" });
  } else {
    steps.push({ kind: "read", label: "读取相关源码", detail: "packages/workbench/src/*.vue", status: "wait" });
    steps.push({ kind: "write", label: "执行修改", detail: "patch · 3 files changed", status: "wait" });
    steps.push({ kind: "exec", label: "验证构建", detail: "pnpm typecheck && pnpm build", status: "wait" });
  }
  return steps;
}

/** 会话状态：每 thread 消息流 + 命令历史 + 真实/mock 执行管线（send→respond）。 */
export const useChatStore = defineStore("chat", () => {
  const projectStore = useProjectStore();
  const settingsStore = useSettingsStore();
  const artifactStore = useArtifactStore();
  const vfsStore = useVfsStore();

  const activeThreadId = ref("");
  const threads = ref<Record<string, ThreadMessage[]>>({});
  const busy = ref(false);
  const speedBoost = ref(false);
  const chatEffort = ref<ChatEffort>("medium");
  const commandHistory = ref<CommandEntry[]>([]);

  /* ===== 真实 LLM 管线（openai-compatible 流式；密钥宿主侧解析） ===== */
  const llm = createLlmClient();
  /** 最近一次派发是否走了真实管线（false = mock 演示管线） */
  const llmActive = ref(false);
  /** 响应式可用性：设置中启用/配置供应商后即时翻转（与 llmActive 无关，不固化于初始化）。 */
  const llmReady = computed(() => llm.isAvailable() && !!selectLlmProvider(settingsStore.modelProviders, settingsStore.selectedModelProviderId));
  let llmRequestId: number | null = null;
  let streamingInto: ThreadMessage | null = null;
  let llmListening = false;

  function finishStream(): void {
    busy.value = false;
    streamingInto = null;
    llmRequestId = null;
  }

  async function ensureLlmListener(): Promise<void> {
    if (llmListening) return;
    llmListening = true;
    await llm.onEvent((event) => {
      if (event.kind === "llm-delta") {
        if (streamingInto) streamingInto.content += event.payload.delta ?? "";
      } else if (event.kind === "llm-done") {
        finishStream();
      } else if (event.kind === "llm-error") {
        if (streamingInto) streamingInto.content += `\n\n[LLM 错误] ${event.payload.message ?? "unknown"}`;
        finishStream();
      }
    });
  }

  /** 统一助手分发：配置了可用供应商 → 真实流式；否则 mock 兜底（明示演示管线）。 */
  async function dispatchAssistant(message: ThreadMessage): Promise<void> {
    const provider = selectLlmProvider(settingsStore.modelProviders, settingsStore.selectedModelProviderId);
    if (!provider || !llm.isAvailable()) {
      llmActive.value = false;
      runAssistant(message);
      return;
    }
    llmActive.value = true;
    message.planPending = false;
    // 真实管线不演造步骤时间线；增量直接写入 content
    message.steps = [];
    busy.value = true;
    streamingInto = message;
    await ensureLlmListener();
    try {
      const history = buildLlmHistory(ensure(activeThreadId.value).filter((item) => item.id !== message.id));
      llmRequestId = await llm.chat({
        baseUrl: provider.baseUrl ?? "",
        model: provider.model,
        apiKeyEnv: provider.apiKeyEnv,
        messages: history,
      });
    } catch (error) {
      message.content = `[LLM 调用失败] ${error instanceof Error ? error.message : String(error)}`;
      finishStream();
    }
  }

  /** 中止生成：真实流式走宿主 stop；mock 时间线清定时器。 */
  function abortGeneration(): void {
    if (llmRequestId !== null) {
      void llm.stop(llmRequestId);
      return;
    }
    clearSim();
    busy.value = false;
  }
  function ensure(threadId: string): ThreadMessage[] {
    if (!threads.value[threadId]) threads.value[threadId] = [];
    return threads.value[threadId];
  }

  function push(threadId: string, message: ThreadMessage): void {
    ensure(threadId).push(message);
  }

  /** mock 执行：步进时间线 → 完成文案 → 追加交付物。 */
  function runAssistant(message: ThreadMessage): void {
    message.planPending = false;
    busy.value = true;
    let delay = 420;
    for (const step of message.steps ?? []) {
      simTimers.push(setTimeout(() => (step.status = "running"), delay));
      delay += 620 + Math.random() * 480;
      simTimers.push(setTimeout(() => (step.status = "done"), delay));
      delay += 140;
    }
    simTimers.push(
      setTimeout(() => {
        message.content = speedBoost.value
          ? "任务已完成（速度模式 · 提速约 1.5 倍）。所有步骤执行成功，可在右侧面板查看产物、Diff 与来源。"
          : "任务已完成。所有步骤均执行成功，右侧面板可查看生成的文件、Git Diff 与引用来源。";
        busy.value = false;
        // 交付物契约：产物落盘虚拟文件系统 → Artifacts 卡片 + Diffs 实时出现
        const firstLabel = String(message.steps?.[1]?.label ?? "");
        const isReport = /报告/.test(firstLabel) || /报告/.test(message.content);
        const name = isReport ? "reports/weekly-report.md" : "reports/task-result.md";
        const stepLines = (message.steps ?? []).map((step) => `- ✅ ${step.label}（${step.detail}）`);
        void vfsStore.write(
          name,
          [
            `# ${isReport ? "周报" : "任务结果"}`,
            "",
            `来源会话：${message.content.slice(0, 24)}…`,
            "",
            "## 执行步骤",
            ...stepLines,
            "",
          ].join("\n"),
        );
        const artifactId = artifactStore.pushArtifact({
          name: isReport ? "weekly-report.md" : "task-result.md",
          meta: isReport ? "Markdown · 刚刚生成" : "Markdown · 任务产物",
          type: "report",
          source: "assistant-pipeline",
        });
        message.artifacts = [...(message.artifacts ?? []), artifactId];
      }, delay),
    );
  }

  /**
   * send→respond 管线（ChatView 共用）：
   * user 消息入流 → planMode 时挂起 plan 卡（inline）→ 确认后执行。
   */
  function submitText(text: string, attachments: string[] = []): ThreadMessage | null {
    const trimmed = text.trim();
    if (!trimmed || busy.value) return null;
    if (!activeThreadId.value) {
      activeThreadId.value = projectStore.startNewThread(null);
    }
    commandHistory.value.unshift({ input: trimmed, ts: Date.now(), threadId: activeThreadId.value });
    if (commandHistory.value.length > 100) commandHistory.value.pop();

    push(activeThreadId.value, {
      id: uid(),
      role: "user",
      content: trimmed,
      ts: Date.now(),
      attachments: [...attachments],
    });

    if (settingsStore.planMode) {
      const pending: ThreadMessage = {
        id: uid(),
        role: "assistant",
        content: "",
        ts: Date.now(),
        steps: buildSteps(trimmed),
        planPending: true,
      };
      push(activeThreadId.value, pending);
      return pending;
    }
    const message: ThreadMessage = { id: uid(), role: "assistant", content: "", ts: Date.now(), steps: buildSteps(trimmed) };
    push(activeThreadId.value, message);
    void dispatchAssistant(message);
    return message;
  }

  function confirmPlan(_threadId: string, message: ThreadMessage): void {
    void dispatchAssistant(message);
  }

  function cancelPlan(threadId: string, message: ThreadMessage): void {
    const list = ensure(threadId);
    const index = list.indexOf(message);
    if (index >= 0) list.splice(index, 1);
  }

  /**
   * ACP 回合（agent store 派发）：user 消息入流 + assistant 支架，
   * 返回支架消息供 ACP 事件流式续写。与 submitText 的差异：
   * 无 planMode / mock 步骤时间线，内容完全由 ACP 宿主事件驱动。
   */
  function startAcpTurn(text: string, providerName: string): ThreadMessage {
    if (!activeThreadId.value) activeThreadId.value = projectStore.startNewThread(null);
    const threadId = activeThreadId.value;
    push(threadId, { id: uid(), role: "user", content: text, ts: Date.now(), attachments: [] });
    const message: ThreadMessage = { id: uid(), role: "assistant", content: "", ts: Date.now(), acp: providerName };
    push(threadId, message);
    return message;
  }

  /** 通过响应式线程列表更新 ACP 支架，不能直接修改 startAcpTurn 返回的原始对象。 */
  function appendMessageContent(messageId: string, content: string): void {
    const message = ensure(activeThreadId.value).find((candidate) => candidate.id === messageId);
    if (message) message.content += content;
  }

  function setMessageContent(messageId: string, content: string): void {
    const message = ensure(activeThreadId.value).find((candidate) => candidate.id === messageId);
    if (message) message.content = content;
  }

  return {
    activeThreadId,
    threads,
    busy,
    speedBoost,
    chatEffort,
    commandHistory,
    clearSim,
    ensure,
    submitText,
    confirmPlan,
    cancelPlan,
    startAcpTurn,
    appendMessageContent,
    setMessageContent,
    llmReady,
    llmActive,
    abortGeneration,
  };
});
