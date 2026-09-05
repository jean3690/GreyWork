import { useArtifactStore } from "./artifact";
import { useSessionStore } from "./session";
import { useSettingsStore } from "./settings";
import { useVfsStore } from "./vfs";
import { createLlmClient } from "@greywork/llm";
import { buildLlmHistory, selectLlmProvider } from "./chat-llm";
import { exportToXlsx } from "../lib/xlsx";
import ExcelJS from "exceljs";
import { exportToPptx, type PptxDeck } from "../lib/pptx";
import { sanitizeXlsxGraphics } from "../lib/xlsx-sanitize";
import { extractDashboardTitle, specToHtml } from "../lib/genui";
import { createIdFactory } from "@greywork/core";
import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { i18n } from "../i18n";
import { mergeToolActivities } from "../lib/tool-activity";
import type { ChatStep, QueuedCommand, ThreadMessage, ToolActivity } from "../types";

const t = i18n.global.t;

const uid = createIdFactory("m");
const quid = createIdFactory("q");

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

/** mock 思考链：按意图文本生成「分句揭示」的推理叙事（演示 reasoning 行，可被真实推理流替换）。 */
export function buildThinking(text: string): string[] {
  const segments = [`理解意图：用户请求「${text.slice(0, 24)}…」的自动执行。`];
  if (/测试|test/i.test(text)) {
    segments.push("识别分支：测试修复 → 先读上下文，再运行测试定位失败用例。");
    segments.push("拟定执行序：read context → run tests → 逐项汇总验证。");
  } else if (/日报|周报|报告/.test(text)) {
    segments.push("识别分支：报告生成 → 检索近 7 天动态，聚合为 Markdown 报表。");
    segments.push("拟定执行序：read dataset → search → 生成报告与简报 PPT。");
  } else if (/太阳系|solar/i.test(text)) {
    segments.push("识别分支：演示 → 组稿太阳系 5 页深色主题幻灯片。");
    segments.push("拟定执行序：读素材 → 检索天体数据 → 组合 PPT 与逐页 Brief。");
  } else {
    segments.push("识别分支：代码任务 → 定位相关源码，小步修改。");
    segments.push("拟定执行序：read source → apply patch → verify build。");
  }
  segments.push("校验工具链与产物契约，开始执行。");
  return segments;
}

/** 会话状态：每 thread 消息流 + 命令历史 + 真实/mock 执行管线（send→respond）。 */
export const useChatStore = defineStore("chat", () => {
  const sessionStore = useSessionStore();
  const settingsStore = useSettingsStore();
  const artifactStore = useArtifactStore();
  const vfsStore = useVfsStore();

  /** 当前会话 id：由持久化会话存储托管（computed+setter 保持原赋值语义）。 */
  const activeThreadId = computed<string>({
    get: () => sessionStore.activeSessionId ?? "",
    set: (value) => sessionStore.setActive(value || null),
  });
  /** 线程 id → 消息列表（派生自会话存储；消息对象响应式共享）。 */
  const threads = computed<Record<string, ThreadMessage[]>>(() => {
    const map: Record<string, ThreadMessage[]> = {};
    for (const session of sessionStore.sessions) map[session.id] = session.messages;
    return map;
  });
  const busy = ref(false);
  const speedBoost = ref(false);
  /* ===== 发送队列（M5）：回复期间下发的消息先入队，回合结束再补发 ===== */
  const commandQueue = ref<QueuedCommand[]>([]);
  const commandQueueMode = ref<"auto" | "manual">("auto");

  function enqueueCommand(input: string, attachments: string[] = []): void {
    commandQueue.value.push({ id: quid(), input: input.trim(), attachments: [...attachments], ts: Date.now() });
  }
  function removeCommand(id: string): void {
    commandQueue.value = commandQueue.value.filter((item) => item.id !== id);
  }
  function clearQueue(): void {
    commandQueue.value = [];
  }
  function sendCommand(id: string): void {
    const index = commandQueue.value.findIndex((item) => item.id === id);
    if (index < 0) return;
    const [item] = commandQueue.value.splice(index, 1);
    if (busy.value) {
      commandQueue.value.unshift(item);
      return;
    }
    submitText(item.input, item.attachments);
  }
  function toggleQueueMode(): void {
    commandQueueMode.value = commandQueueMode.value === "auto" ? "manual" : "auto";
  }
  // auto 模式：每回合结束补发队首一条（补发会再次置 busy，天然一轮一条）。
  // flush:"sync" 使补发恰好发生在 busy 归零那一刻（回复刚结束时），测试与运行时行为一致。
  watch(
    busy,
    (value) => {
      if (value || commandQueueMode.value !== "auto") return;
      const next = commandQueue.value.shift();
      if (next) submitText(next.input, next.attachments);
    },
    { flush: "sync" },
  );

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

  /**
   * 打开（或续用）当前活跃的正文段：思考段在前就先封口，工具段在前则另起一段。
   * text 段只记 `content` 的起始偏移，正文本身不存第二份。
   */
  function openTextSegment(message: ThreadMessage): void {
    const segments = (message.segments ??= []);
    const tail = segments.at(-1);
    if (tail?.kind === "text") return;
    if (tail?.kind === "thinking") tail.endedAt = Date.now();
    segments.push({ kind: "text", id: uid(), from: message.content.length, to: null });
  }

  /** 立即写入缓冲内容（ACP 回合结束 / 思考与工具插入前 / 测试断言前调用）。 */
  function flushPendingContent(): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (appendBuf.size) {
      for (const [messageId, entry] of appendBuf) {
        const message = ensure(entry.threadId).find((candidate) => candidate.id === messageId);
        if (!message) continue;
        openTextSegment(message);
        message.content += entry.text;
      }
      appendBuf.clear();
    }
    if (streamBuf) {
      if (streamingInto) {
        openTextSegment(streamingInto);
        streamingInto.content += streamBuf;
      }
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
  async function dispatchAssistant(message: ThreadMessage, intentText = ""): Promise<void> {
    const provider = selectLlmProvider(settingsStore.modelProviders, settingsStore.selectedModelProviderId);
    if (!provider || !llm.isAvailable()) {
      llmActive.value = false;
      runAssistant(message, intentText);
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
    streamingMessageId.value = null;
  }
  function ensure(threadId: string): ThreadMessage[] {
    return sessionStore.ensure(threadId);
  }

  function push(threadId: string, message: ThreadMessage): void {
    sessionStore.appendMessage(threadId, message);
  }

  /** 从意图里解析要追加的行数据：支持「意图：a,b,c」内联，否则回退到示例行。 */
  function parseRowValues(text: string): string[] {
    const inline = text.match(/[：:]\s*(.+)$/);
    if (inline) {
      const cells = inline[1]
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (cells.length) return cells;
    }
    return ["新增站点", String(1000 + Math.floor(Math.random() * 9000))];
  }

  /** 给已存在的 Excel 追加一行（无则新建），写回 VFS 并通知查看器重载。返回交付物 id 供消息记账。 */
  async function appendRowToXlsx(intentText: string): Promise<string> {
    const path = "reports/task-result.xlsx";
    const row = parseRowValues(intentText);
    const existing = await vfsStore.readBinary(path).catch(() => null);
    if (!existing) {
      const data = await exportToXlsx([{ name: "task-result", headers: ["站点", "客流"], rows: [row] }]);
      await vfsStore.writeBinary(path, data);
    } else {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(await sanitizeXlsxGraphics(existing));
      const ws = wb.getWorksheet(1) ?? wb.addWorksheet("task-result");
      ws.addRow(row);
      const buf = await wb.xlsx.writeBuffer();
      await vfsStore.writeBinary(path, new Uint8Array(buf as ArrayBuffer));
    }
    const id = await artifactStore.deliverArtifact({
      name: "task-result.xlsx",
      meta: "Excel · 已追加一行",
      type: "dataset",
      source: "assistant-pipeline",
      format: "xlsx",
      path,
      updated: true,
    });
    return id;
  }

  /** 写入演示方案 Brief（通用）：Summary / Outline / Page Brief 三段式。返回交付物 id 供消息记账。 */
  async function writeBrief(path: string, sections: { title: string; body: string }[]): Promise<string> {
    const md = ["# 演示方案 Brief", "", ...sections.flatMap((s) => [`## ${s.title}`, "", s.body, ""])].join("\n");
    return artifactStore.deliverArtifact({
      meta: "Markdown · 演示方案",
      type: "report",
      source: "assistant-pipeline",
      format: "md",
      path,
      data: md,
    });
  }

  /** 报告/演示意图的默认 Brief：从执行步骤推导 Summary / Outline / Page Brief。 */
  function briefFromReport(intentText: string, steps: ChatStep[]): { title: string; body: string }[] {
    const stepLines = steps.map((s, i) => `${i + 1}. ${s.label} —— ${s.detail}`);
    return [
      {
        title: "Summary",
        body: `本次演示围绕「${intentText.slice(0, 32) || "任务执行"}」展开，共规划 ${steps.length} 个关键步骤，覆盖从上下文读取到落盘交付的完整链路。`,
      },
      { title: "Outline", body: stepLines.join("\n") },
      { title: "Page Brief", body: steps.map((s, i) => `第 ${i + 1} 页｜${s.label}：${s.detail}`).join("\n") },
    ];
  }

  /** 太阳系演示：5 页深色主题 PPT 的内容与对应 Brief。 */
  function solarDeck(): { deck: PptxDeck; brief: { title: string; body: string }[] } {
    return {
      deck: {
        title: "The Solar System",
        subtitle: "A Journey Through Our Cosmic Neighborhood",
        slides: [
          { title: "The Solar System", bullets: ["A Journey Through Our Cosmic Neighborhood", "八大行星 · 一颗恒星 · 无尽的边疆"] },
          {
            title: "The Heart of It All: The Sun",
            bullets: ["占据太阳系约 99.86% 的质量", "核心核聚变，表面温度约 5500°C", "阳光抵达地球约需 8 分 20 秒"],
          },
          {
            title: "The Inner Planets",
            bullets: [
              "水星 Mercury — 最靠近太阳，几乎没有大气",
              "金星 Venus — 强烈温室效应，最热的行星",
              "地球 Earth — 已知唯一孕育生命的世界",
              "火星 Mars — 红色星球，探测最热点",
            ],
          },
          {
            title: "The Outer Giants",
            bullets: [
              "木星 Jupiter — 体积最大，大红斑风暴",
              "土星 Saturn — 壮观光环由冰与岩构成",
              "天王星 Uranus — 近乎侧躺自转",
              "海王星 Neptune — 最远，狂风呼啸",
            ],
          },
          {
            title: "The Frontier Awaits",
            bullets: ["柯伊伯带 Kuiper Belt — 矮行星的家园", "奥尔特云 Oort Cloud — 长周期彗星的源头", "旅行者号已飞越日球层，驶向星际"],
          },
        ],
      },
      brief: [
        {
          title: "Summary",
          body: "一次穿越太阳系的视觉之旅：从中心的恒星太阳，到内侧的四颗岩质行星、外侧的四颗巨行星，直至柯伊伯带与奥尔特云的未知边疆。",
        },
        {
          title: "Outline",
          body: "1. The Solar System\n2. The Heart of It All: The Sun\n3. The Inner Planets\n4. The Outer Giants\n5. The Frontier Awaits",
        },
        {
          title: "Page Brief",
          body: "第 1 页｜总览：太阳系的全貌与旅程引言\n第 2 页｜太阳：质量、能量与光\n第 3 页｜内行星：水金地火\n第 4 页｜外行星：木土天海\n第 5 页｜边疆：柯伊伯带与奥尔特云",
        },
      ],
    };
  }

  /** 依据意图文本规划演示用工具时间线序列（无 ACP 后端时渲染执行可视化）。 */
  function planMockTools(intentText: string): ToolActivity[] {
    const now = Date.now();
    const base: ToolActivity[] = [
      {
        toolCallId: "mock-read-context",
        kind: "read",
        status: "completed",
        startedAt: now,
        finishedAt: now,
        path: "README.md",
        description: "context",
      },
    ];
    const isReport = /日报|周报|报告/.test(intentText);
    const isTable = /表|Excel|xlsx|客流|站点/.test(intentText);
    const isTest = /测试|test/i.test(intentText);
    const isSolar = /太阳系|solar/i.test(intentText);
    if (isTest) {
      base.push(
        {
          toolCallId: "mock-exec-test",
          kind: "execute",
          status: "completed",
          startedAt: now,
          finishedAt: now,
          command: "pnpm test",
          description: "run tests",
        },
        {
          toolCallId: "mock-read-fail",
          kind: "read",
          status: "completed",
          startedAt: now,
          finishedAt: now,
          path: "packages/core/src/math.ts",
          description: "inspect failing spec",
        },
        {
          toolCallId: "mock-edit-fix",
          kind: "edit",
          status: "completed",
          startedAt: now,
          finishedAt: now,
          path: "packages/core/src/math.ts",
          description: "apply fix",
        },
        {
          toolCallId: "mock-exec-reverify",
          kind: "execute",
          status: "completed",
          startedAt: now,
          finishedAt: now,
          command: "pnpm test -- core",
          description: "re-verify",
        },
      );
    } else if (isSolar) {
      base.push(
        {
          toolCallId: "mock-read-deck",
          kind: "read",
          status: "completed",
          startedAt: now,
          finishedAt: now,
          path: "docs/positioning.md",
          description: "gather material",
        },
        {
          toolCallId: "mock-fetch-solar",
          kind: "fetch",
          status: "completed",
          startedAt: now,
          finishedAt: now,
          description: "fetch solar system facts",
          command: "WebSearch solar system planets",
        },
        {
          toolCallId: "mock-write-pptx",
          kind: "edit",
          status: "completed",
          startedAt: now,
          finishedAt: now,
          path: "reports/solar-system.pptx",
          description: "compose deck",
        },
      );
    } else if (isTable || isReport) {
      base.push(
        {
          toolCallId: "mock-read-data",
          kind: "read",
          status: "completed",
          startedAt: now,
          finishedAt: now,
          path: "reports/stations.csv",
          description: "read dataset",
        },
        {
          toolCallId: "mock-search",
          kind: "search",
          status: "completed",
          startedAt: now,
          finishedAt: now,
          path: "data/station-flow.json",
          description: "aggregate rows",
        },
        isReport
          ? {
              toolCallId: "mock-write-doc",
              kind: "edit",
              status: "completed",
              startedAt: now,
              finishedAt: now,
              path: "reports/weekly-report.md",
              description: "draft report",
            }
          : {
              toolCallId: "mock-write-xlsx",
              kind: "edit",
              status: "completed",
              startedAt: now,
              finishedAt: now,
              path: "reports/task-result.xlsx",
              description: "write rows",
            },
      );
    } else {
      base.push(
        {
          toolCallId: "mock-read-src",
          kind: "read",
          status: "completed",
          startedAt: now,
          finishedAt: now,
          path: "src/components/ActivityPanel.vue",
          description: "inspect",
        },
        {
          toolCallId: "mock-edit-src",
          kind: "edit",
          status: "completed",
          startedAt: now,
          finishedAt: now,
          path: "src/components/ActivityPanel.vue",
          description: "apply change",
        },
        {
          toolCallId: "mock-exec-check",
          kind: "execute",
          status: "completed",
          startedAt: now,
          finishedAt: now,
          command: "pnpm typecheck",
          description: "verify",
        },
      );
    }
    // 末位补一个思考块以演示 reasoning 行
    base.push({ toolCallId: "mock-think", kind: "think", status: "completed", startedAt: now, finishedAt: now, description: "thinking" });
    return base;
  }

  /** mock 执行：步进时间线 → 思考链揭示 → 工具活动时间线 → 完成文案 → 追加交付物。 */
  function runAssistant(message: ThreadMessage, intentText = ""): void {
    // 走响应式引用更新：直接改原始 message 不会触发 Pinia 重渲染，步骤时间线会卡在 wait。
    const live = ensure(activeThreadId.value).find((m) => m.id === message.id) ?? message;
    live.planPending = false;
    busy.value = true;
    // 本条消息正在被写入：思考段据此判定「仍在流」并保持展开（与真实 ACP 回合同一判据）。
    streamingMessageId.value = live.id;
    // 思考链：分句揭示推理。头几句在动手之前，末句留到工具跑完之后 —— 复现真实回合的
    // 「思考 → 动手 → 再思考」节奏，演示态也就能看到多段各自折叠的思考条。
    const thinking = buildThinking(intentText);
    const opening = thinking.length > 1 ? thinking.slice(0, -1) : thinking;
    const closing = thinking.length > 1 ? thinking.at(-1) : undefined;
    let thinkingDelay = 140;
    for (const segment of opening) {
      const capture = segment;
      simTimers.push(setTimeout(() => appendMessageThinking(live.id, `${capture}\n`), thinkingDelay));
      thinkingDelay += 360 + Math.random() * 160;
    }
    let delay = 420;
    for (const step of live.steps ?? []) {
      simTimers.push(setTimeout(() => (step.status = "running"), delay));
      delay += 380 + Math.random() * 220;
      simTimers.push(setTimeout(() => (step.status = "done"), delay));
      delay += 120;
    }
    // 生成并推进「工具聚合时间线」（无 ACP 后端时演示执行可视化，与步骤并行）
    const mockTools = planMockTools(intentText);
    let toolDelay = 480;
    for (const tool of mockTools) {
      simTimers.push(
        setTimeout(() => appendTools([{ ...tool, status: "in_progress", startedAt: Date.now(), finishedAt: null }], live.id), toolDelay),
      );
      toolDelay += 700 + Math.random() * 400;
      simTimers.push(
        setTimeout(
          () => appendTools([{ ...tool, status: tool.status === "failed" ? "failed" : "completed", finishedAt: Date.now() }], live.id),
          toolDelay,
        ),
      );
    }
    if (closing) simTimers.push(setTimeout(() => appendMessageThinking(live.id, closing), toolDelay + 260));
    simTimers.push(
      setTimeout(
        () => {
          setMessageContent(live.id, speedBoost.value ? t("chat.completedSpeed") : t("chat.completed"));
          busy.value = false;
          streamingMessageId.value = null;
          // 消息级记账：每条产物 id 都要回挂到本条消息，对话内「文件变更」块才列得全。
          // 此前只有主 md 记了账，xlsx/pptx/html 都漏在 artifacts 之外。
          const record = (id: string): void => {
            live.artifacts = [...(live.artifacts ?? []), id];
          };
          // 交付物契约：产物落盘虚拟文件系统 → Artifacts 卡片 + Diffs 实时出现
          // 意图识别基于用户原始输入（intentText），而非占位完成文案 message.content。
          const firstLabel = String(live.steps?.[1]?.label ?? "");
          const isReport = /日报|周报|报告/.test(intentText) || /报告/.test(live.content);
          // 太阳系演示意图：生成 5 页深色主题 PPT + 对应 Brief
          const isSolar = /(太阳系|solar system|太阳系之旅)/i.test(intentText);
          // 追加行意图：给已存在的 Excel 追加一行（走就地修改，不重新生成整表）
          const isAddRow =
            /添加|新增|插入|追加|补|增加|加.{0,4}(一行|行|row)/i.test(intentText) && /(excel|xlsx|表格|数据表|表)/i.test(intentText);
          const name = isReport ? "reports/weekly-report.md" : "reports/task-result.md";
          const stepLines = (live.steps ?? []).map((step) => `- ✅ ${step.label}（${step.detail}）`);
          void artifactStore
            .deliverArtifact({
              meta: isReport ? "Markdown · 刚刚生成" : "Markdown · 任务产物",
              type: "report",
              source: "assistant-pipeline",
              format: "md",
              path: name,
              data: [
                `# ${isReport ? "周报" : "任务结果"}`,
                "",
                `来源会话：${intentText.slice(0, 24)}…`,
                "",
                "## 执行步骤",
                ...stepLines,
                "",
              ].join("\n"),
            })
            .then(record)
            .catch(() => undefined);
          // 追加行意图：就地修改现有 Excel（通知查看器重载），跳过整表重新生成
          if (isAddRow) {
            void appendRowToXlsx(intentText)
              .then(record)
              .catch(() => undefined);
          }
          // 表格意图：额外产出一个 xlsx 交付物（引擎生成 → VFS 二进制落盘 → Artifacts 卡片）
          if (!isAddRow && (/表|Excel|xlsx|客流|站点/i.test(intentText) || /表/.test(firstLabel))) {
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
              .then((data) =>
                artifactStore.deliverArtifact({
                  meta: "Excel · 表格产物",
                  type: "dataset",
                  source: "assistant-pipeline",
                  format: "xlsx",
                  path: "reports/task-result.xlsx",
                  data,
                }),
              )
              .then(record)
              .catch(() => undefined);
          }
          // 报告意图：额外产出一个 pptx 简报（标题 + 执行步骤）
          if (isReport) {
            void exportToPptx({
              title: "任务简报",
              subtitle: `来源会话：${intentText.slice(0, 24)}…`,
              slides: [
                {
                  title: "执行步骤",
                  bullets: (live.steps ?? []).map((step) => `${step.label}：${step.detail}`),
                },
              ],
            })
              .then((data) =>
                artifactStore.deliverArtifact({
                  meta: "PPT · 简报产物",
                  type: "report",
                  source: "assistant-pipeline",
                  format: "pptx",
                  path: "reports/task-brief.pptx",
                  data,
                }),
              )
              .then(record)
              .catch(() => undefined);
          }
          // 演示方案 Brief（Summary / Outline / Page Brief 三段）
          if (isSolar) {
            const { deck, brief } = solarDeck();
            void exportToPptx(deck)
              .then((data) =>
                artifactStore.deliverArtifact({
                  meta: "PPT · 太阳系演示",
                  type: "report",
                  source: "assistant-pipeline",
                  format: "pptx",
                  path: "reports/solar-system.pptx",
                  data,
                }),
              )
              .then(record)
              .then(() => writeBrief("reports/brief.md", brief))
              .then(record)
              .catch(() => undefined);
          } else if (isReport) {
            // 报告意图同时产出演示方案 Brief（从执行步骤推导）
            void writeBrief("reports/brief.md", briefFromReport(intentText, live.steps ?? []))
              .then(record)
              .catch(() => undefined);
          }
          // 界面意图：GenUI 产出静态 HTML 可视化 → VFS → 预览面板（preview:request 联动）
          if (/界面|仪表盘|看板|dashboard|genui/i.test(intentText) || /界面|仪表盘|看板/.test(firstLabel)) {
            const html = specToHtml({
              title: `${extractDashboardTitle(intentText)} · GenUI`,
              subtitle: `来源会话：${intentText.slice(0, 24)}…`,
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
            void artifactStore
              .deliverArtifact({
                meta: "HTML · 可视化产物",
                type: "report",
                source: "assistant-pipeline",
                format: "html",
                path: `reports/genui/dashboard-${Date.now()}.html`,
                data: html,
              })
              .then(record)
              .catch(() => undefined);
          }
          // 完成文案排在工具与收尾思考之后：演示态也遵守「思考 → 动手 → 再思考 → 作答」的真实顺序
        },
        Math.max(delay, toolDelay + 520),
      ),
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
      activeThreadId.value = sessionStore.createSession(null).id;
    }
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
    void dispatchAssistant(message, trimmed);
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
    if (!activeThreadId.value) activeThreadId.value = sessionStore.createSession(null).id;
    const threadId = activeThreadId.value;
    push(threadId, { id: uid(), role: "user", content: text, ts: Date.now(), attachments: [] });
    const message: ThreadMessage = { id: uid(), role: "assistant", content: "", ts: Date.now(), acp: providerName };
    push(threadId, message);
    return { threadId, message };
  }

  /**
   * 通过响应式线程列表更新 ACP 支架；threadId 缺省 = 当前激活线程（向后兼容）。
   * 增量先入缓冲（~40ms 合并），由 flushPendingContent 统一写入；
   * 段边界在增量到达时就定下来，否则中途插进来的思考 / 工具会串位。
   */
  function appendMessageContent(messageId: string, content: string, threadId = activeThreadId.value): void {
    const entry = appendBuf.get(messageId);
    if (entry) {
      entry.text += content;
    } else {
      appendBuf.set(messageId, { threadId, text: content });
      const message = ensure(threadId).find((candidate) => candidate.id === messageId);
      if (message) openTextSegment(message);
    }
    scheduleFlush();
  }

  function setMessageContent(messageId: string, content: string, threadId = activeThreadId.value): void {
    // 丢弃待 flush 的增量，避免覆盖回退后再被缓冲追加。
    appendBuf.delete(messageId);
    const message = ensure(threadId).find((candidate) => candidate.id === messageId);
    if (!message) return;
    message.content = content;
    // 正文整体替换（错误文案 / 无输出兜底）：偏移全失效，思考与工具段保留，正文归一段挂到末尾。
    const kept = (message.segments ?? []).filter((segment) => segment.kind !== "text");
    message.segments = content ? [...kept, { kind: "text", id: uid(), from: 0, to: null }] : kept;
  }

  /**
   * 把工具活动增量并入指定消息的 tools 时间线，并登记到当前工具段。
   * 已在某段里的 toolCallId（后续 tool_call_update）不重复登记，也不另起新段。
   */
  function appendTools(activities: ToolActivity[], messageId: string, threadId = activeThreadId.value): void {
    // 缓冲里的正文先落地，否则这批工具会插到还没写出的正文之前，段序错位。
    flushPendingContent();
    const message = ensure(threadId).find((candidate) => candidate.id === messageId);
    if (!message) return;
    message.tools = mergeToolActivities(message.tools, activities);
    const segments = (message.segments ??= []);
    for (const activity of activities) {
      if (segments.some((segment) => segment.kind === "tools" && segment.toolCallIds.includes(activity.toolCallId))) continue;
      let tail = segments.at(-1);
      if (tail?.kind !== "tools") {
        if (tail?.kind === "thinking") tail.endedAt = Date.now();
        else if (tail?.kind === "text") tail.to = message.content.length;
        tail = { kind: "tools", id: uid(), toolCallIds: [] };
        segments.push(tail);
      }
      tail.toolCallIds.push(activity.toolCallId);
    }
  }

  /**
   * 追加思考链增量（ACP AgentThoughtChunk / mock 揭示共用入口）。
   * 连续的思考并进同一段；一旦被正文或工具打断，下一波思考另起一段 ——
   * 这样一条消息里的多轮推理各自折叠，而不是全部堆进消息头上那一坨。
   */
  function appendMessageThinking(messageId: string, delta: string, threadId = activeThreadId.value): void {
    flushPendingContent();
    const message = ensure(threadId).find((candidate) => candidate.id === messageId);
    if (!message) return;
    const segments = (message.segments ??= []);
    const tail = segments.at(-1);
    const now = Date.now();
    if (tail?.kind === "thinking") {
      tail.text += delta;
      tail.endedAt = now;
      return;
    }
    if (tail?.kind === "text") tail.to = message.content.length;
    segments.push({ kind: "thinking", id: uid(), text: delta, startedAt: now, endedAt: now });
  }

  return {
    activeThreadId,
    threads,
    busy,
    speedBoost,
    commandQueue,
    commandQueueMode,
    enqueueCommand,
    removeCommand,
    clearQueue,
    sendCommand,
    toggleQueueMode,
    clearSim,
    ensure,
    submitText,
    confirmPlan,
    cancelPlan,
    startAcpTurn,
    appendMessageContent,
    setMessageContent,
    appendTools,
    appendMessageThinking,
    flushPendingContent,
    streamingMessageId,
    llmReady,
    llmActive,
    abortGeneration,
  };
});
