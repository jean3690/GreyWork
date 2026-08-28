<script setup lang="ts">
import { computed } from "vue";
import { useAgentStore } from "../stores/agent";
import { PERM_LABELS, useSettingsStore } from "../stores/settings";
import { AGENT_ROLE_TONES, DEFAULT_TONE, TONE_SOFT } from "../lib/tones";
import { useI18n } from "vue-i18n";

const agentStore = useAgentStore();
const settings = useSettingsStore();
const { t } = useI18n();

/** 协作看板：列 = Agent，卡 = 子任务（无编排运行时回退到内置示例）。 */
interface BoardTask {
  id: string;
  label: string;
  priority: "high" | "medium" | "low";
}

const BOARD_TASKS: Record<string, BoardTask[]> = {
  "agent-alpha": [
    { id: "a-t1", label: "拆分空间采集子任务", priority: "high" },
    { id: "a-t2", label: "汇总 Geo 环分析结论", priority: "medium" },
    { id: "a-t3", label: "编排 3D 生成流水线", priority: "high" },
  ],
  "agent-gist": [
    { id: "g-t1", label: "台风路径轨迹清理", priority: "high" },
    { id: "g-t2", label: "站点客流空间聚类", priority: "medium" },
    { id: "g-t3", label: "MBTiles 切片质检", priority: "low" },
  ],
  "agent-forge": [
    { id: "f-t1", label: "3D Tiles LOD 生成", priority: "high" },
    { id: "f-t2", label: "地表网格烘焙", priority: "medium" },
  ],
  "agent-check": [
    { id: "c-t1", label: "QA-003 回归评审", priority: "medium" },
    { id: "c-t2", label: "交付物一致性审计", priority: "low" },
  ],
};

/** 活跃编排运行（规划中/执行中）；null = 展示内置示例卡。 */
const activeRun = computed(() => agentStore.runs.find((run) => run.status === "planning" || run.status === "running"));

/** subtask 状态 → 看板卡优先级（running 醒目、pending 置灰）。 */
function subtaskPriority(status: string): "high" | "medium" | "low" {
  if (status === "running") return "high";
  if (status === "done") return "medium";
  return "low";
}

/** 列任务：编排运行时取该 role 的子任务，否则回退内置示例。 */
function tasksOf(agentId: string, role: string): BoardTask[] {
  if (!activeRun.value) return BOARD_TASKS[agentId] ?? [];
  return activeRun.value.subtasks
    .filter((sub) => sub.role === role)
    .map((sub) => ({ id: sub.id, label: sub.prompt, priority: subtaskPriority(sub.status) }));
}

/** 列状态：编排运行中该 role 有 running 子任务 → working。 */
function statusOf(agent: { id: string; role: string; status: string }): string {
  if (!activeRun.value) return agent.status;
  const subs = agentStore.runs.find((run) => run.id === activeRun.value?.id)?.subtasks.filter((s) => s.role === agent.role) ?? [];
  if (subs.some((s) => s.status === "running")) return "working";
  if (subs.some((s) => s.status === "pending")) return "idle";
  return agent.status;
}

const board = computed(() =>
  agentStore.agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    role: agent.role,
    status: statusOf(agent),
    tone: AGENT_ROLE_TONES[agent.role] ?? DEFAULT_TONE,
    soft: TONE_SOFT[AGENT_ROLE_TONES[agent.role] ?? DEFAULT_TONE] ?? "rgba(59, 130, 246, 0.12)",
    tasks: tasksOf(agent.id, agent.role),
  })),
);

const roleLabel = computed<Record<string, string>>(() => ({
  planner: t("agents.role.planner"),
  "geo-analyst": t("agents.role.geoAnalyst"),
  "spatial-artist": t("agents.role.spatialArtist"),
  reviewer: t("agents.role.reviewer"),
}));

const statusLabel = computed<Record<string, string>>(() => ({
  working: t("agents.status.working"),
  idle: t("agents.status.idle"),
  blocked: t("agents.status.blocked"),
  offline: t("agents.status.offline"),
}));

function toneOf(role: string): string {
  return AGENT_ROLE_TONES[role] ?? DEFAULT_TONE;
}

function softOf(role: string): string {
  return TONE_SOFT[toneOf(role)] ?? "rgba(59, 130, 246, 0.12)";
}
</script>

<template>
  <section class="view">
    <div class="view__head">
      <div>
        <p class="view__eyebrow">AGENT SWARM</p>
        <h1 class="view__title">{{ t("agents.title") }}</h1>
        <p class="view__sub">{{ t("agents.sub") }}</p>
      </div>
      <div class="view__actions">
        <button class="btn btn--ghost">{{ t("agents.skillLibrary") }}</button>
        <button class="btn btn--primary">{{ t("agents.startLoop") }}</button>
      </div>
    </div>

    <!-- 编排运行摘要：最新一次 run 的目标/状态/进度（无 run 时隐藏） -->
    <div
      v-if="agentStore.runs.length"
      class="run-bar"
      :data-status="agentStore.runs[0]?.status"
      style="
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 14px;
        margin-bottom: 16px;
        border: 1px solid var(--line);
        border-radius: 10px;
        font-size: 13px;
      "
    >
      <span
        style="width: 8px; height: 8px; border-radius: 50%; background: var(--aion-blue, #3b82f6); flex: none"
        :style="
          agentStore.runs[0]?.status === 'done'
            ? { background: 'var(--success, #22c55e)' }
            : agentStore.runs[0]?.status === 'failed'
              ? { background: 'var(--danger, #ef4444)' }
              : { background: 'var(--accent, #f59e0b)' }
        "
      ></span>
      <strong style="max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{
        agentStore.runs[0]?.goal
      }}</strong>
      <span class="mono" style="margin-left: auto">{{ t(`agents.runStatus.${agentStore.runs[0]?.status ?? "planning"}`) }}</span>
      <span class="mono"
        >{{ agentStore.runs[0]?.subtasks.filter((s) => s.status === "done").length ?? 0 }}/{{
          agentStore.runs[0]?.subtasks.length ?? 0
        }}</span
      >
    </div>

    <!-- 协作看板：列 = Agent，卡 = 子任务 -->
    <div class="board" data-testid="agent-board">
      <div v-for="col in board" :key="col.id" class="board__col">
        <div class="board__col-head">
          <span class="board__avatar" :style="{ background: col.tone }">{{ col.name.slice(0, 1) }}</span>
          <div class="board__col-body">
            <strong>{{ col.name }}</strong>
            <span>{{ roleLabel[col.role] ?? col.role }}</span>
          </div>
          <span class="status-dot" :data-status="col.status" :title="statusLabel[col.status] ?? col.status"></span>
        </div>
        <div class="board__cards">
          <div v-for="task in col.tasks" :key="task.id" class="board__card" :data-priority="task.priority">
            <span class="board__card-edge" :style="{ background: col.tone }"></span>
            <span>{{ task.label }}</span>
          </div>
        </div>
        <p class="board__status" :style="{ color: col.tone }">{{ statusLabel[col.status] ?? col.status }}</p>
      </div>
    </div>

    <div class="agents-grid">
      <div class="panel">
        <div class="panel__head">
          <span class="panel__title">{{ t("agents.formation") }}</span
          ><span class="panel__meta">{{ agentStore.agents.length }} ONLINE</span>
        </div>
        <div class="agent-list">
          <div v-for="agent in agentStore.agents" :key="agent.id" class="agent-card">
            <span class="agent-card__avatar" :style="{ background: toneOf(agent.role), boxShadow: `0 0 0 3px ${softOf(agent.role)}` }">{{
              agent.name.slice(0, 1)
            }}</span>
            <div class="agent-card__body">
              <strong>{{ agent.name }}</strong>
              <span>{{ roleLabel[agent.role] ?? agent.role }}</span>
              <em class="agent-card__quote">
                {{
                  agent.status === "working"
                    ? t("agents.quote.working", {
                        task: board.find((col) => col.id === agent.id)?.tasks[0]?.label ?? t("agents.quote.task"),
                      })
                    : t("agents.quote.idle")
                }}
              </em>
            </div>
            <span class="status-dot" :data-status="agent.status"></span>
            <div class="agent-card__progress" :style="{ background: softOf(agent.role) }">
              <i :style="{ width: agent.progress + '%', background: toneOf(agent.role) }"></i>
            </div>
            <em class="agent-card__pct">{{ agent.progress }}%</em>
          </div>
        </div>
        <p class="footnote">{{ t("agents.roles") }}：{{ agentStore.roles.join(" / ") }}</p>
      </div>
      <div class="panel">
        <div class="panel__head">
          <span class="panel__title">{{ t("agents.pipelineTitle") }}</span
          ><span class="panel__meta">{{ t("agents.pipeline.flow") }}</span>
        </div>
        <ol class="pipeline">
          <li v-for="(step, i) in agentStore.workflowSteps" :key="step.id" class="pipeline__step" :data-status="step.status">
            <span class="pipeline__index">{{ i + 1 }}</span>
            <div class="pipeline__body">
              <strong>{{ t(step.label) }}</strong
              ><span>{{ t(step.desc) }}</span>
            </div>
            <em class="pipeline__status">{{
              step.status === "done"
                ? t("agents.status.done")
                : step.status === "active"
                  ? t("agents.status.running")
                  : t("agents.status.waiting")
            }}</em>
          </li>
        </ol>
      </div>
      <div class="panel">
        <div class="panel__head">
          <span class="panel__title">{{ t("agents.loop.title") }}</span
          ><span class="panel__meta">{{ t(PERM_LABELS[settings.permissionTier]) }}</span>
        </div>
        <div class="policy">
          <div class="policy__row">
            <span>{{ t("agents.loop.maxRounds") }}</span
            ><strong>{{ settings.aiLoopPolicy.maxRounds }}</strong>
          </div>
          <div class="policy__row">
            <span>{{ t("agents.loop.tier") }}</span
            ><strong>{{ t(PERM_LABELS[settings.permissionTier]) }}</strong>
          </div>
          <div class="policy__row">
            <span>{{ t("agents.loop.hostGuard") }}</span
            ><strong>{{ agentStore.acpAvailable ? t("agents.loop.hostGuardOn") : t("agents.loop.hostGuardOff") }}</strong>
          </div>
          <div class="policy__row">
            <span>{{ t("agents.loop.allowlist") }}</span
            ><strong>{{ settings.aiLoopPolicy.toolAllowlist?.length ?? 0 }}</strong>
          </div>
        </div>
        <p class="footnote">{{ t("agents.loop.footnote") }}</p>
      </div>
    </div>
  </section>
</template>
