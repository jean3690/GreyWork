import { createJsonStorage } from "@greywork/core";
import { defineStore } from "pinia";
import { ref } from "vue";
import { listen } from "@tauri-apps/api/event";
import { automationsBackend, type AutomationDuePayload, type AutomationDueRow, type AutomationTaskRow } from "../lib/automations-backend";
import { useChatStore } from "./chat";

/** 自动化任务：按时/规则触发的预设指令，Run Now 经 chat 派管线复跑并落产物。 */
export interface AutomationTask {
  id: string;
  name: string;
  /** 触发描述（如「每天 09:00」）。 */
  schedule: string;
  /** 标准 cron 5 段表达式（分 时 日 月 周）；null/缺省 = 手动触发（仅 Run Now）。 */
  cron?: string | null;
  /** 目标工作区/项目。 */
  target: string;
  /** 实际下发的指令文本（复跑 mock/真实管线）。 */
  intent: string;
  enabled: boolean;
  /** 最近一次运行时间戳（epoch ms；0=从未）。 */
  lastRun: number;
  /** 是否正在执行（Run Now 进行中）。 */
  running: boolean;
}

interface SavedAutomations {
  list?: AutomationTask[];
}

const automationsStorage = createJsonStorage<SavedAutomations>(
  "greywork.automations",
  (value): value is SavedAutomations => typeof value === "object" && value !== null && !Array.isArray(value),
);

let seq = 0;
function uid(): string {
  seq += 1;
  return `at-${seq}`;
}

const DEFAULT_AUTOMATIONS: AutomationTask[] = [
  {
    id: "at-seed-1",
    name: "整理项目状态",
    schedule: "每天 09:00",
    cron: "0 9 * * *",
    target: "GreyWork 主仓",
    intent: "梳理项目本周改动并生成日报",
    enabled: true,
    lastRun: 0,
    running: false,
  },
  {
    id: "at-seed-2",
    name: "自动生成周报",
    schedule: "每周五 18:00",
    cron: "0 18 * * 4",
    target: "城市数据洞察",
    intent: "生成一份周报，包含数据表，并导出 Excel 和 PPT 简报",
    enabled: false,
    lastRun: 0,
    running: false,
  },
  {
    id: "at-seed-3",
    name: "依赖安全巡检",
    schedule: "每天 03:00",
    cron: "0 3 * * *",
    target: "全部项目",
    intent: "跑一遍测试，修复失败的用例",
    enabled: true,
    lastRun: 0,
    running: false,
  },
];

function toRow(task: AutomationTask): AutomationTaskRow {
  return {
    id: task.id,
    name: task.name,
    schedule: task.schedule,
    cron: task.cron ?? null,
    target: task.target,
    intent: task.intent,
    enabled: task.enabled,
    lastRun: task.lastRun,
  };
}

/** 自动化：任务清单持久化（桌面真源 SQLite + localStorage 缓存）+ Run Now 下发 chat 管线。 */
export const useAutomationStore = defineStore("automation", () => {
  const list = ref<AutomationTask[]>([]);

  function loadPersisted(): void {
    const saved = automationsStorage.read();
    const base = saved?.list && Array.isArray(saved.list) && saved.list.length ? saved.list : DEFAULT_AUTOMATIONS.map((a) => ({ ...a }));
    list.value = base.map((a) => ({ ...a, running: false }));
  }
  loadPersisted();

  /** 桌面态启动接管：库已接管 → 库内容覆盖本地；未接管 → 本地种子作为真源首落库。 */
  const backendHydratePromise = (() => {
    if (!automationsBackend.active()) return null;
    return automationsBackend
      .load()
      .then((tasks) => {
        if (tasks) {
          // 库真源优先：running 瞬时态不落库，统一置 false
          list.value = tasks.map((task) => ({ ...task, running: false }));
        } else {
          persist(); // 首启：种子/缓存成为库真源
        }
      })
      .catch((error: unknown) => {
        console.error("[automation] SQLite 加载失败，沿用本地缓存", error);
      });
  })();

  function persist(): void {
    automationsStorage.write({ list: list.value });
    if (automationsBackend.active()) {
      // 后端真源同步：失败不回滚内存（下次 persist 自愈）。
      void automationsBackend.save(list.value.map(toRow)).catch((error: unknown) => {
        console.error("[automation] SQLite 同步失败，将下次重试", error);
      });
    }
  }

  function add(task?: Partial<AutomationTask>): AutomationTask {
    const item: AutomationTask = {
      id: uid(),
      name: "新建自动化任务",
      schedule: "手动触发",
      cron: null,
      target: "未绑定工作区",
      intent: "生成一份周报",
      enabled: false,
      lastRun: 0,
      running: false,
      ...task,
    };
    list.value.unshift(item);
    persist();
    return item;
  }

  function remove(id: string): void {
    list.value = list.value.filter((a) => a.id !== id);
    persist();
  }

  function setEnabled(id: string, enabled: boolean): void {
    const task = list.value.find((a) => a.id === id);
    if (task) {
      task.enabled = enabled;
      persist();
    }
  }

  function update(id: string, patch: Partial<AutomationTask>): void {
    const task = list.value.find((a) => a.id === id);
    if (task) {
      Object.assign(task, patch);
      persist();
    }
  }

  /** Run Now：把任务指令下发到 chat 管线（mock/真实），并记录运行时间。
   * 运行状态由 ScheduledView 观察 chat.busy 反映（单人说·同一时刻只跑一个）。 */
  function runNow(id: string): void {
    const task = list.value.find((a) => a.id === id);
    if (!task) return;
    const chat = useChatStore();
    if (chat.busy) return;
    task.enabled = true;
    chat.submitText(task.intent);
    task.lastRun = Date.now();
    persist();
  }

  /* ===== 宿主到期队列（automation_due 表）消费 =====
   * 可靠化语义：到期任务由宿主持久化入队并广播唤醒；渲染端单消费循环
   * 拉取（60min 窗口）逐条执行 finish。busy 不丢不跳——任务留在队列，
   * 由 30s 轮询/due 事件唤醒补跑；webview reload 期间积压任务 hydrate
   * 后补跑。取代旧「busy 跳过记 lastRun 假成功、广播丢失即丢」语义。 */
  /** 队列轮询间隔（ms）：与宿主 tick 同频；busy 结束的任务最多延迟一轮执行。 */
  const DUE_POLL_MS = 30_000;

  /** 消费循环互斥（防重入双跑）。 */
  let consuming = false;

  type DueExecResult = "done" | "busy" | "missing";

  /**
   * 执行一条到期任务：chat 管线忙 → busy（任务保留队列下轮重试）；
   * 任务已不在清单 → missing（防御分支，正常由库级联删除）。成功提交
   * 时乐观记 last_run。
   */
  function executeDue(row: AutomationDueRow): DueExecResult {
    const chat = useChatStore();
    if (chat.busy) return "busy";
    const task = list.value.find((a) => a.id === row.taskId);
    if (!task) return "missing";
    task.enabled = true;
    task.lastRun = Date.now();
    chat.submitText(row.intent);
    persist();
    return "done";
  }

  /**
   * 消费到期队列：拉 pending（60min 窗口）逐条执行；busy/空即停。
   * 公开导出供测试、due 事件与轮询复用。
   */
  async function consumeDue(): Promise<void> {
    if (consuming) return;
    consuming = true;
    try {
      for (;;) {
        const due = await automationsBackend.dueList();
        if (!due || due.length === 0) break;
        const result = executeDue(due[0]);
        if (result !== "busy") {
          // done/missing 都收尾（missing 无 task 可跑，标 failed 不留死队列）
          await automationsBackend.dueFinish(due[0].id, result === "done" ? "success" : "failed");
        }
        if (result !== "done") break;
      }
    } catch (error: unknown) {
      console.error("[automation] 到期队列消费失败", error);
    } finally {
      consuming = false;
    }
  }

  // 桌面态：监听宿主 tick 广播唤醒 + 30s 轮询兜底 + hydrate 后补跑积压。
  // 浏览器态无后端（无 tick/队列），全部跳过。
  if (automationsBackend.active()) {
    void listen<AutomationDuePayload>("automation://due", () => {
      void consumeDue();
    }).catch((error: unknown) => {
      console.error("[automation] due 事件监听失败", error);
    });
    setInterval(() => {
      void consumeDue();
    }, DUE_POLL_MS);
    if (backendHydratePromise) {
      void backendHydratePromise.then(() => {
        void consumeDue();
      });
    }
  }

  return {
    list,
    add,
    remove,
    setEnabled,
    update,
    runNow,
    consumeDue,
    /** 桌面态启动接管完成信号（null = 浏览器态无后端）。 */
    hydrated: backendHydratePromise,
  };
});
