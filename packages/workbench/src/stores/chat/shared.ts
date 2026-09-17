/**
 * chat store 共享层：模块级纯函数 / 常量 / 编排辅助。
 *
 * 这里的 helpers 不访问任何 store 实例：id 工厂、mock 规划器（buildSteps /
 * buildThinking / planMockTools）、演示内容（solarDeck / briefFromReport /
 * parseRowValues）与产物失败上报都是模块级的；simTimers / clearSim 是模块级
 * 可变状态（多 store 实例共享，与原 stores/chat.ts 的模块作用域行为一致）。
 */
import { createIdFactory } from "@greywork/core";
import { notify } from "../notice";
import { i18n } from "../../i18n";
import type { PptxDeck } from "../../lib/pptx";
import type { ChatStep, ToolActivity } from "../../types";

export const t = i18n.global.t;

/** 产物落盘失败的统一上报：key 去重（一次失败只一条通知，别被演示管线的多次写入刷屏）。 */
export function notifyArtifactFailure(error: unknown): void {
  notify({
    kind: "error",
    key: "artifact-write",
    title: t("errors.artifactWriteFailed"),
    detail: error instanceof Error ? error.message : String(error),
  });
}

export const uid = createIdFactory("m");
export const quid = createIdFactory("q");
export const tid = createIdFactory("t");

export let simTimers: ReturnType<typeof setTimeout>[] = [];
export function clearSim(): void {
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

/** 从意图里解析要追加的行数据：支持「意图：a,b,c」内联，否则回退到示例行。 */
export function parseRowValues(text: string): string[] {
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

/** 报告/演示意图的默认 Brief：从执行步骤推导 Summary / Outline / Page Brief。 */
export function briefFromReport(intentText: string, steps: ChatStep[]): { title: string; body: string }[] {
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
export function solarDeck(): { deck: PptxDeck; brief: { title: string; body: string }[] } {
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
export function planMockTools(intentText: string): ToolActivity[] {
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
