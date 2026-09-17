import { createJsonStorage } from "@greywork/core";
import { defineStore } from "pinia";
import { ref, watch } from "vue";
import { listen } from "@tauri-apps/api/event";
import { automationsBackend, type AutomationDuePayload, type AutomationDueRow, type AutomationTaskRow } from "../lib/automations-backend";
import { useChatStore } from "./chat";
import { useAgentStore } from "./agent";
import { useSessionStore } from "./session";
import { notify } from "./notice";
import { i18n } from "../i18n";

const t = i18n.global.t;

/** 自动化任务：按时/规则触发的预设指令，Run Now 经 chat 派管线复跑并落产物。 */
export interface AutomationTask {
  id: string;
  name: string;
  /** 触发描述（如「每天 09:00」）。 */
  schedule: string;
  /** 标准 cron 5 段表达式（分 时 日 月 周）；null/缺省 = 手动触发（仅 Run Now）。 */
  cron?: string | null;
  /**
   * 一次性任务的触发时刻（epoch ms）；null/缺省 = 按 cron 循环。
   *
   * 与 `cron` 互斥：cron 没有年份字段，表达不了「就跑这一次」，所以一次性任务
   * 只写 `onceAt`（宿主按时间戳判定 + 跑过即不再触发），并在跑完后自动停用。
   */
  onceAt?: number | null;
  /** 执行后端：ACP 后端 id（带工具跑）；null/缺省 = 本机模型管线。 */
  acpProviderId?: string | null;
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
    target: "普通对话",
    intent: "梳理项目本周改动并生成日报",
    enabled: false,
    lastRun: 0,
    running: false,
  },
  {
    id: "at-seed-2",
    name: "自动生成周报",
    schedule: "每周五 18:00",
    cron: "0 18 * * 5",
    target: "普通对话",
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
    enabled: false,
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
    onceAt: task.onceAt ?? null,
    acpProviderId: task.acpProviderId ?? null,
    target: task.target,
    intent: task.intent,
    enabled: task.enabled,
    lastRun: task.lastRun,
  };
}

/**
 * 一次性任务的收尾判定：跑过（lastRun > 0）就不再启用。
 *
 * 宿主在入队时就会写 last_run（应用不在场时接着由 host_exec 兜底执行），所以从库里
 * 读回来时通常是「跑过但 enabled 仍为 1」——只看本会话是否执行过会漏掉这条路径。
 */
function settleOnceTask(task: AutomationTask): AutomationTask {
  if (!task.onceAt || task.lastRun <= 0) return task;
  return { ...task, enabled: false };
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
          list.value = tasks.map((task) => ({ ...task, running: false })).map(settleOnceTask);
        } else {
          persist(); // 首启：种子/缓存成为库真源
        }
      })
      .catch((error: unknown) => {
        console.error("[automation] SQLite 加载失败，沿用本地缓存", error);
        notify({ kind: "warning", key: "automation-load", title: t("errors.automationSyncFailed"), detail: String(error) });
      });
  })();

  function persist(): void {
    automationsStorage.write({ list: list.value });
    if (automationsBackend.active()) {
      // 后端真源同步：失败不回滚内存（下次 persist 自愈）。
      void automationsBackend.save(list.value.map(toRow)).catch((error: unknown) => {
        console.error("[automation] SQLite 同步失败，将下次重试", error);
        notify({ kind: "error", key: "automation-sync", title: t("errors.automationSyncFailed"), detail: String(error) });
      });
    }
  }

  function add(task?: Partial<AutomationTask>): AutomationTask {
    const item: AutomationTask = {
      id: uid(),
      name: "新建自动化任务",
      schedule: t("automation.manualTrigger"),
      cron: null,
      onceAt: null,
      acpProviderId: null,
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

  /* ===== 执行路由：本机模型管线 vs 指定 ACP 后端 =====
   * 任务绑定 acpProviderId 时走 ACP（带工具、按所选后端执行）；否则走既有 chat 管线。
   * ACP 在本应用是全局单会话（与对话页共用），到期执行会切换当前后端——这是既有
   * 架构约束，编辑器里已明示；换成按任务建会话是另一个量级的改造。 */
  type RunMode = "llm" | "acp";

  /** 任一条管线是否有回合在跑：两条管线共用同一会话视图，故调度上互斥。 */
  function turnActive(): boolean {
    const agent = useAgentStore();
    return useChatStore().busy || agent.acpBusy || agent.acpConnecting;
  }

  /**
   * 把指令交给执行后端：本机模型走 chat 管线（同步入流），ACP 先切后端再派发。
   * 返回失败文案（null = 已成功下发）；后端被删 / 未启用 / 连不上都在这里落地。
   */
  async function dispatchIntent(acpProviderId: string | null, intent: string): Promise<string | null> {
    if (!acpProviderId) {
      useChatStore().submitText(intent);
      return null;
    }
    const agent = useAgentStore();
    const provider = agent.agentProviders.find((candidate) => candidate.id === acpProviderId);
    if (!provider) return t("errors.acpNotSelected");
    if (!provider.enabled) return t("errors.providerNotEnabled", { name: provider.name });
    if (agent.selectedProviderId !== provider.id || !agent.routeToAcp) {
      const failure = await agent.activateAcpProvider(provider.id);
      if (failure) return failure;
    }
    await agent.dispatchToAcp(intent);
    return null;
  }

  /* ===== Run Now 在途跟踪 =====
   * 管线没有「本任务完成」回执，只有全局忙态 —— 所以用翻转检测近似：
   * 下发后忙态从 true → false 的一次翻转视为本次运行结束；另有 10 分钟保险丝兜底
   * （防忙态观察错位把任务永远钉在「运行中」）。一次只跑一个。 */
  const RUN_FUSE_MS = 10 * 60_000;
  let inflight: { id: string; mode: RunMode; sawBusy: boolean } | null = null;
  let fuseTimer: ReturnType<typeof setTimeout> | null = null;
  /** 最近一次 Run Now 下发的会话 id（视图「查看会话」入口）。 */
  const lastRunSessionId = ref<string | null>(null);

  function clearInflight(): void {
    if (fuseTimer !== null) {
      clearTimeout(fuseTimer);
      fuseTimer = null;
    }
    if (inflight) {
      const task = list.value.find((a) => a.id === inflight!.id);
      if (task) task.running = false;
      inflight = null;
    }
  }

  // 两条管线各自观察：本次运行只看自己那条的信号，别把另一条管线的忙碌当成自己的结束。
  watch(
    () => useChatStore().busy,
    (busy, wasBusy) => {
      const current = inflight;
      if (!current || current.mode !== "llm") return;
      if (busy) current.sawBusy = true;
      else if (wasBusy && current.sawBusy) clearInflight();
    },
  );

  watch(
    () => {
      const agent = useAgentStore();
      return agent.acpBusy || agent.acpConnecting;
    },
    (active, wasActive) => {
      const current = inflight;
      if (!current || current.mode !== "acp") return;
      if (active) current.sawBusy = true;
      else if (wasActive && current.sawBusy) clearInflight();
    },
  );

  /**
   * Run Now：把任务指令下发到它的执行后端，返回结果码供视图给即时反馈
   * （started / busy / missing）。running 置真直到管线忙完一轮或保险丝到期；
   * lastRun 在真正下发成功后回写（ACP 后端连不上不算跑过）。
   */
  function runNow(id: string): "started" | "busy" | "missing" {
    const task = list.value.find((a) => a.id === id);
    if (!task) return "missing";
    const chat = useChatStore();
    if (turnActive() || inflight !== null) return "busy";
    if (!chat.activeThreadId) {
      const session = useSessionStore().createSession(null);
      chat.activeThreadId = session.id;
    }
    task.enabled = true;
    task.running = true;
    lastRunSessionId.value = chat.activeThreadId;
    inflight = { id, mode: task.acpProviderId ? "acp" : "llm", sawBusy: false };
    fuseTimer = setTimeout(() => {
      fuseTimer = null;
      clearInflight();
    }, RUN_FUSE_MS);
    void dispatchIntent(task.acpProviderId ?? null, task.intent).then((failure) => {
      if (!failure) {
        task.lastRun = Date.now();
      } else {
        clearInflight();
        notify({
          kind: "error",
          key: "automation-run-failed",
          title: t("errors.automationRunFailed"),
          detail: `${task.name}：${failure}`,
        });
      }
      persist();
    });
    persist();
    return "started";
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

  type DueExecResult = "done" | "busy" | "missing" | "failed";

  /**
   * 执行一条到期任务：任一条管线忙 → busy（任务保留队列下轮重试）；任务已不在
   * 清单 → missing（防御分支，正常由库级联删除）；执行后端不可用 → failed。
   * 执行后端取自队列快照（入队时刻的选择），与 intent 同源。
   */
  async function executeDue(row: AutomationDueRow): Promise<DueExecResult> {
    if (turnActive()) return "busy";
    const task = list.value.find((a) => a.id === row.taskId);
    if (!task) return "missing";
    const failure = await dispatchIntent(row.acpProviderId, row.intent);
    if (failure) {
      notify({
        kind: "error",
        key: "automation-run-failed",
        title: t("errors.automationRunFailed"),
        detail: `${row.name}：${failure}`,
      });
      return "failed";
    }
    task.enabled = true;
    task.lastRun = Date.now();
    // 一次性任务跑完即停用：宿主调度器只按 (onceAt, last_run) 判定，留 enabled=1
    // 会让界面继续显示「已启用」，下次改这条任务时也容易误以为还会再跑。
    if (task.onceAt) task.enabled = false;
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
        const result = await executeDue(due[0]);
        if (result !== "busy") {
          // done/missing/failed 都收尾（missing 无 task 可跑，标 failed 不留死队列）
          await automationsBackend.dueFinish(due[0].id, result === "done" ? "success" : "failed");
        }
        if (result !== "done") break;
      }
    } catch (error: unknown) {
      console.error("[automation] 到期队列消费失败", error);
      notify({ kind: "error", key: "automation-due", title: t("errors.automationRunFailed"), detail: String(error) });
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
      notify({ kind: "warning", key: "automation-due-listen", title: t("errors.automationSyncFailed"), detail: String(error) });
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
    lastRunSessionId,
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
