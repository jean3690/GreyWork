import { useArtifactStore } from "./artifact";
import { useProjectStore } from "./project";
import { useSettingsStore } from "./settings";
import { useVfsStore } from "./vfs";
import { createLlmClient } from "@greywork/llm";
import { buildLlmHistory, selectLlmProvider } from "./chat-llm";
import { exportToXlsx } from "../lib/xlsx";
import { exportToPptx } from "../lib/pptx";
import { extractDashboardTitle, specToHtml } from "../lib/genui";
import { appEvents } from "../events";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { i18n } from "../i18n";
import type { ChatStep, CommandEntry, ThreadMessage } from "../types";

const t = i18n.global.t;

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
  const steps: ChatStep[] = [
    { kind: "read", label: t("chat.steps.readContext"), detail: t("chat.steps.readContextDetail"), status: "wait" },
  ];
  if (/测试|test/i.test(text)) {
    steps.push({ kind: "exec", label: t("chat.steps.runTests"), detail: t("chat.steps.runTestsDetail"), status: "wait" });
    steps.push({ kind: "test", label: t("chat.steps.summarize"), detail: t("chat.steps.summarizeDetail"), status: "wait" });
  } else if (/日报|周报|报告/.test(text)) {
    steps.push({ kind: "search", label: t("chat.steps.search"), detail: t("chat.steps.searchDetail"), status: "wait" });
    steps.push({ kind: "write", label: t("chat.steps.writeReport"), detail: t("chat.steps.writeReportDetail"), status: "wait" });
  } else {
    steps.push({ kind: "read", label: t("chat.steps.readSource"), detail: t("chat.steps.readSourceDetail"), status: "wait" });
    steps.push({ kind: "write", label: t("chat.steps.apply"), detail: t("chat.steps.applyDetail"), status: "wait" });
    steps.push({ kind: "exec", label: t("chat.steps.verify"), detail: t("chat.steps.verifyDetail"), status: "wait" });
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
  const commandHistory = ref<CommandEntry[]>([]);

  /* ===== 真实 LLM 管线（openai-compatible 流式；密钥宿主侧解析） ===== */
  const llm = createLlmClient();
  /** 最近一次派发是否走了真实管线（false = mock 演示管线） */
  const llmActive = ref(false);
  /** 响应式可用性：设置中启用/配置供应商后即时翻转（与 llmActive 无关，不固化于初始化）。 */
  const llmReady = computed(
    () => llm.isAvailable() && !!selectLlmProvider(settingsStore.modelProviders, settingsStore.selectedModelProviderId),
  );
  let llmRequestId: number | null = null;
  let streamingInto: ThreadMessage | null = null;
  let llmListening = false;
  /** 当前流式续写的消息 id（ChatView 据此切换 StreamText 纯文本渲染，流式结束回 Markdown）。 */
  const streamingMessageId = ref<string | null>(null);

  /* 流式批处理：chunk 先入缓冲，~40ms 合并写入一次，
     避免每个 chunk 都触发深层响应式 + Markdown 全量重解析。 */
  const appendBuf = new Map<string, { threadId: string; text: string }>();
  let streamBuf = "";
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushPendingContent();
    }, 40);
  }

  /** 立即写入缓冲内容（ACP 回合结束 / 测试断言前调用）。 */
  function flushPendingContent(): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (appendBuf.size) {
      for (const [messageId, entry] of appendBuf) {
        const message = ensure(entry.threadId).find((candidate) => candidate.id === messageId);
        if (message) message.content += entry.text;
      }
      appendBuf.clear();
    }
    if (streamBuf) {
      if (streamingInto) streamingInto.content += streamBuf;
      streamBuf = "";
    }
  }

  function finishStream(): void {
    flushPendingContent();
    busy.value = false;
    streamingInto = null;
    llmRequestId = null;
    streamingMessageId.value = null;
  }

  async function ensureLlmListener(): Promise<void> {
    if (llmListening) return;
    llmListening = true;
    await llm.onEvent((event) => {
      if (event.kind === "llm-delta") {
        if (streamingInto) {
          streamBuf += event.payload.delta ?? "";
          scheduleFlush();
        }
      } else if (event.kind === "llm-done") {
        finishStream();
      } else if (event.kind === "llm-error") {
        if (streamingInto) streamBuf += `\n\n${t("chat.llmError", { detail: event.payload.message ?? "unknown" })}`;
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
    streamingMessageId.value = message.id;
    await ensureLlmListener();
    try {
      const history = buildLlmHistory(ensure(activeThreadId.value).filter((item) => item.id !== message.id));
      llmRequestId = await llm.chat({
        baseUrl: provider.baseUrl ?? "",
        model: provider.model,
        apiKeyEnv: provider.apiKeyEnv,
        messages: history,
        reasoningEffort: provider.reasoningEffort ?? "auto",
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
        message.content = speedBoost.value ? t("chat.completedSpeed") : t("chat.completed");
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
        appEvents.emit("artifact:created", {
          name: isReport ? "weekly-report.md" : "task-result.md",
          path: name,
          format: "md",
          source: "assistant-pipeline",
        });
        // 表格意图：额外产出一个 xlsx 交付物（引擎生成 → VFS 二进制落盘 → Artifacts 卡片）
        if (/表|Excel|xlsx|客流|站点/i.test(message.content) || /表/.test(firstLabel)) {
          void exportToXlsx([
            {
              name: "task-result",
              headers: ["站点", "客流"],
              rows: [
                ["北京站", "1284"],
                ["上海站", "2231"],
                ["深圳站", "876"],
              ],
            },
          ])
            .then((data) => vfsStore.writeBinary("reports/task-result.xlsx", data))
            .then(() => {
              artifactStore.pushArtifact({
                name: "task-result.xlsx",
                meta: "Excel · 表格产物",
                type: "dataset",
                source: "assistant-pipeline",
                format: "xlsx",
              });
              appEvents.emit("artifact:created", {
                name: "task-result.xlsx",
                path: "reports/task-result.xlsx",
                format: "xlsx",
                source: "assistant-pipeline",
              });
            })
            .catch(() => undefined);
        }
        // 报告意图：额外产出一个 pptx 简报（标题 + 执行步骤）
        if (isReport) {
          void exportToPptx({
            title: "任务简报",
            subtitle: `来源会话：${message.content.slice(0, 24)}…`,
            slides: [
              {
                title: "执行步骤",
                bullets: (message.steps ?? []).map((step) => `${step.label}：${step.detail}`),
              },
            ],
          })
            .then((data) => vfsStore.writeBinary("reports/task-brief.pptx", data))
            .then(() => {
              artifactStore.pushArtifact({
                name: "task-brief.pptx",
                meta: "PPT · 简报产物",
                type: "report",
                source: "assistant-pipeline",
                format: "pptx",
              });
              appEvents.emit("artifact:created", {
                name: "task-brief.pptx",
                path: "reports/task-brief.pptx",
                format: "pptx",
                source: "assistant-pipeline",
              });
            })
            .catch(() => undefined);
        }
        // 界面意图：GenUI 产出静态 HTML 可视化 → VFS → 预览面板（preview:request 联动）
        if (/界面|仪表盘|看板|dashboard|genui/i.test(message.content) || /界面|仪表盘|看板/.test(firstLabel)) {
          const html = specToHtml({
            title: `${extractDashboardTitle(message.content)} · GenUI`,
            subtitle: `来源会话：${message.content.slice(0, 24)}…`,
            kpis: [
              { label: "总客流", value: "12,384" },
              { label: "峰值日", value: "周六" },
              { label: "环比", value: "+8.2%" },
            ],
            table: {
              headers: ["站点", "客流", "占比"],
              rows: [
                ["北京站", "4,281", "80%"],
                ["上海站", "3,650", "62%"],
                ["深圳站", "2,134", "40%"],
              ],
            },
          });
          const path = `reports/genui/dashboard-${Date.now()}.html`;
          void vfsStore
            .write(path, html)
            .then(() => {
              const name = path.split("/").pop() ?? "dashboard.html";
              artifactStore.pushArtifact({
                name,
                meta: "HTML · 可视化产物",
                type: "report",
                source: "assistant-pipeline",
                format: "html",
              });
              appEvents.emit("artifact:created", {
                name,
                path,
                format: "html",
                source: "assistant-pipeline",
              });
            })
            .catch(() => undefined);
        }
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
   * 返回 { threadId, message } 供 ACP 事件按线程流式续写（不依赖 activeThreadId）。
   * 与 submitText 的差异：无 planMode / mock 步骤时间线，内容完全由 ACP 宿主事件驱动。
   */
  function startAcpTurn(text: string, providerName: string): { threadId: string; message: ThreadMessage } {
    if (!activeThreadId.value) activeThreadId.value = projectStore.startNewThread(null);
    const threadId = activeThreadId.value;
    push(threadId, { id: uid(), role: "user", content: text, ts: Date.now(), attachments: [] });
    const message: ThreadMessage = { id: uid(), role: "assistant", content: "", ts: Date.now(), acp: providerName };
    push(threadId, message);
    return { threadId, message };
  }

  /** 通过响应式线程列表更新 ACP 支架；threadId 缺省 = 当前激活线程（向后兼容）。
   * 增量先入缓冲（~40ms 合并），由 flushPendingContent 统一写入。 */
  function appendMessageContent(messageId: string, content: string, threadId = activeThreadId.value): void {
    const entry = appendBuf.get(messageId);
    if (entry) entry.text += content;
    else appendBuf.set(messageId, { threadId, text: content });
    scheduleFlush();
  }

  function setMessageContent(messageId: string, content: string, threadId = activeThreadId.value): void {
    // 丢弃待 flush 的增量，避免覆盖回退后再被缓冲追加。
    appendBuf.delete(messageId);
    const message = ensure(threadId).find((candidate) => candidate.id === messageId);
    if (message) message.content = content;
  }

  return {
    activeThreadId,
    threads,
    busy,
    speedBoost,
    commandHistory,
    clearSim,
    ensure,
    submitText,
    confirmPlan,
    cancelPlan,
    startAcpTurn,
    appendMessageContent,
    setMessageContent,
    flushPendingContent,
    streamingMessageId,
    llmReady,
    llmActive,
    abortGeneration,
  };
});
