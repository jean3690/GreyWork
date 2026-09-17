/**
 * mock 演示管线切片：无可用 LLM/ACP 后端时，把意图文本演成一段「步进时间线 →
 * 思考链揭示 → 工具活动 → 完成文案 → 产物落盘」的演示回合。
 *
 * 产物契约在此闭环：xlsx/pptx/html/md 落到 VFS → Artifacts 卡片 + Diffs 实时出现，
 * 每条产物 id 回挂到消息的 artifacts 记账。纯内容构造（buildSteps / buildThinking /
 * planMockTools / solarDeck / briefFromReport / parseRowValues）在 shared.ts，
 * 这里只剩会碰 store 实例的执行逻辑。
 *
 * 与 stream 切片成环：dispatchAssistant（stream）无供应商时调 runAssistant，
 * runAssistant 又要经 stream 的 mutators（setMessageContent / appendMessageThinking /
 * appendTools）写消息 —— 经 api 持有者惰性解析。
 */
import { appendXlsxRow, exportToXlsx } from "../../lib/xlsx";
import { exportToPptx } from "../../lib/pptx";
import { extractDashboardTitle, specToHtml } from "../../lib/genui";
import { isDarkMode } from "../../lib/theme";
import { formatDuration } from "../../lib/tool-activity";
import { notify } from "../notice";
import { simTimers, t, buildThinking, briefFromReport, notifyArtifactFailure, parseRowValues, planMockTools, solarDeck } from "./shared";
import type { ThreadMessage } from "../../types";
import type { ChatStoreState } from "./state";
import type { SessionApi } from "./session";
import type { StreamApi } from "./stream";

export interface DemoDeps {
  state: ChatStoreState;
  getSession: () => SessionApi;
  getStream: () => StreamApi;
}

export interface DemoApi {
  runAssistant(message: ThreadMessage, intentText?: string): void;
}

export function createDemoSlice({ state, getSession, getStream }: DemoDeps): DemoApi {
  const session = getSession();
  const stream = getStream();
  const { busy, runningSessionId, speedBoost, streamingMessageId, artifactStore, vfsStore, sessionStore } = state;

  /** 给已存在的 Excel 追加一行（无则新建），写回 VFS 并通知查看器重载。返回交付物 id 供消息记账。 */
  async function appendRowToXlsx(intentText: string): Promise<string> {
    const path = "reports/task-result.xlsx";
    const row = parseRowValues(intentText);
    const existing = await vfsStore.readBinary(path).catch(() => null);
    const data = await appendXlsxRow(existing, "task-result", ["站点", "客流"], row);
    await vfsStore.writeBinary(path, data);
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

  /** mock 执行：步进时间线 → 思考链揭示 → 工具活动时间线 → 完成文案 → 追加交付物。 */
  function runAssistant(message: ThreadMessage, intentText = ""): void {
    // 走响应式引用更新：直接改原始 message 不会触发 Pinia 重渲染，步骤时间线会卡在 wait。
    const live = session.ensure(session.activeThreadId.value).find((m) => m.id === message.id) ?? message;
    live.planPending = false;
    sessionStore.markDirty();
    busy.value = true;
    runningSessionId.value = session.activeThreadId.value;
    // 演示管线回合起点：完成时报真实耗时（mock 工具时间线 startedAt/finishedAt 同刻，无法自算）。
    const turnStartAt = Date.now();
    // 本条消息正在被写入：思考段据此判定「仍在流」并保持展开（与真实 ACP 回合同一判据）。
    streamingMessageId.value = live.id;
    // 思考链：分句揭示推理。头几句在动手之前，末句留到工具跑完之后 —— 复现真实回合的
    // 「思考 → 动手 → 再思考」节奏，演示态也就能看到多段各自折叠的思考条。
    const thinking = buildThinking(intentText);
    const opening = thinking.length > 1 ? thinking.slice(0, -1) : thinking;
    const closing = thinking.length > 1 ? thinking.at(-1) : undefined;
    let thinkingDelay = 140;
    for (const thought of opening) {
      const capture = thought;
      simTimers.push(setTimeout(() => stream.appendMessageThinking(live.id, `${capture}\n`), thinkingDelay));
      thinkingDelay += 360 + Math.random() * 160;
    }
    let delay = 420;
    for (const step of live.steps ?? []) {
      simTimers.push(
        setTimeout(() => {
          step.status = "running";
          sessionStore.markDirty();
        }, delay),
      );
      delay += 380 + Math.random() * 220;
      simTimers.push(
        setTimeout(() => {
          step.status = "done";
          sessionStore.markDirty();
        }, delay),
      );
      delay += 120;
    }
    // 生成并推进「工具聚合时间线」（无 ACP 后端时演示执行可视化，与步骤并行）
    const mockTools = planMockTools(intentText);
    let toolDelay = 480;
    for (const tool of mockTools) {
      simTimers.push(
        setTimeout(
          () => stream.appendTools([{ ...tool, status: "in_progress", startedAt: Date.now(), finishedAt: null }], live.id),
          toolDelay,
        ),
      );
      toolDelay += 700 + Math.random() * 400;
      simTimers.push(
        setTimeout(
          () =>
            stream.appendTools([{ ...tool, status: tool.status === "failed" ? "failed" : "completed", finishedAt: Date.now() }], live.id),
          toolDelay,
        ),
      );
    }
    if (closing) simTimers.push(setTimeout(() => stream.appendMessageThinking(live.id, closing), toolDelay + 260));
    simTimers.push(
      setTimeout(
        () => {
          stream.setMessageContent(live.id, speedBoost.value ? t("chat.completedSpeed") : t("chat.completed"));
          busy.value = false;
          runningSessionId.value = null;
          streamingMessageId.value = null;
          // 演示管线完成同样给「任务完成」成功通知（与真实 ACP 路径对齐）。
          const duration = formatDuration(Date.now() - turnStartAt);
          notify({
            kind: "success",
            key: "mock-turn-done",
            title: t("chat.completedToast"),
            detail: t("chat.completedDetail", { duration }),
          });
          // 消息级记账：每条产物 id 都要回挂到本条消息，对话内「文件变更」块才列得全。
          // 此前只有主 md 记了账，xlsx/pptx/html 都漏在 artifacts 之外。
          const record = (id: string): void => {
            live.artifacts = [...(live.artifacts ?? []), id];
            sessionStore.markDirty();
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
            .catch(notifyArtifactFailure);
          // 追加行意图：就地修改现有 Excel（通知查看器重载），跳过整表重新生成
          if (isAddRow) {
            void appendRowToXlsx(intentText).then(record).catch(notifyArtifactFailure);
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
              .catch(notifyArtifactFailure);
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
              .catch(notifyArtifactFailure);
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
              .catch(notifyArtifactFailure);
          } else if (isReport) {
            // 报告意图同时产出演示方案 Brief（从执行步骤推导）
            void writeBrief("reports/brief.md", briefFromReport(intentText, live.steps ?? []))
              .then(record)
              .catch(notifyArtifactFailure);
          }
          // 界面意图：GenUI 产出静态 HTML 可视化 → VFS → deliverArtifact 广播
          // artifact:created，preview-bridge 收到后自动开预览（preview:request 是
          // 给非产物来源的跨面板请求用的，这里不需要再发一份）。
          if (/界面|仪表盘|看板|dashboard|genui/i.test(intentText) || /界面|仪表盘|看板/.test(firstLabel)) {
            const html = specToHtml(
              {
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
              },
              /* 静态产物不带脚本，明暗只能在生成时定稿（见 genui.ts 说明） */ { dark: isDarkMode() },
            );
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
              .catch(notifyArtifactFailure);
          }
          // 完成文案排在工具与收尾思考之后：演示态也遵守「思考 → 动手 → 再思考 → 作答」的真实顺序
        },
        Math.max(delay, toolDelay + 520),
      ),
    );
  }

  return { runAssistant };
}
