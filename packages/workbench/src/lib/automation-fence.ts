/**
 * ```automation 围栏解析：AI 回复里声明的自动化任务提案 → 结构化草稿。
 *
 * 为什么不是工具调用：宿主没有向 agent 注册工具的通道，agent 侧也不存在
 * ScheduleTask 这个工具（调了只会 not found）。输出围栏是既有同构模式 ——
 * cowork 协作指令走 ```cowork 围栏，宿主在回合收尾解析。只认**带标签的围栏**，
 * 不扫裸 JSON：模型输出的普通 JSON（如示例代码块）不该被误当任务提案。
 */
import { validateCron } from "./cron";

export interface AutomationFence {
  name: string;
  intent: string;
  cron?: string;
  onceAt?: number;
}

// 围栏关键字保持 `schedule`（宿主提示词与模型输出按此约定，改动会破坏兼容）。
const FENCE_PATTERN = /```schedule\s*([\s\S]*?)```/gi;

/** 该字段是否能作为触发条件（cron 合法 / onceAt 是未来时刻）。 */
function hasTrigger(entry: { cron?: unknown; onceAt?: unknown }): boolean {
  if (typeof entry.cron === "string" && entry.cron.trim() !== "" && validateCron(entry.cron) === null) return true;
  if (typeof entry.onceAt === "number" && Number.isFinite(entry.onceAt) && entry.onceAt > Date.now()) return true;
  return false;
}

/**
 * 从模型输出中解析所有合法的 automation 提案。
 * 容错策略：JSON 坏、缺 name/intent、无有效触发条件的条目**整条丢弃**（半份提案
 * 没有确认价值，还容易让用户误建一个永远不触发的任务）。
 */
export function parseAutomationFences(output: string): AutomationFence[] {
  const results: AutomationFence[] = [];
  for (const match of output.matchAll(FENCE_PATTERN)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]?.trim() ?? "");
    } catch {
      continue;
    }
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const { name, intent } = record;
      if (typeof name !== "string" || !name.trim()) continue;
      if (typeof intent !== "string" || !intent.trim()) continue;
      if (!hasTrigger(record)) continue;
      const fence: AutomationFence = { name: name.trim(), intent: intent.trim() };
      if (typeof record.cron === "string" && record.cron.trim() !== "" && validateCron(record.cron) === null) {
        fence.cron = record.cron.trim();
      }
      if (typeof record.onceAt === "number" && Number.isFinite(record.onceAt) && record.onceAt > Date.now()) {
        fence.onceAt = record.onceAt;
      }
      results.push(fence);
    }
  }
  return results;
}
