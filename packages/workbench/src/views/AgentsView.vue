<script setup lang="ts">
import { computed } from "vue";
import { useAgentStore } from "../stores/agent";
import { PERM_LABELS, useSettingsStore } from "../stores/settings";
import { AGENT_ROLE_TONES, DEFAULT_TONE, TONE_SOFT } from "../lib/tones";

const agentStore = useAgentStore();
const settings = useSettingsStore();

/** 协作看板：列 = Agent，卡 = 子任务（mock；左侧 4px 彩边表示优先级）。 */
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

const board = computed(() =>
  agentStore.agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    role: agent.role,
    status: agent.status,
    tone: AGENT_ROLE_TONES[agent.role] ?? DEFAULT_TONE,
    soft: TONE_SOFT[AGENT_ROLE_TONES[agent.role] ?? DEFAULT_TONE] ?? "rgba(59, 130, 246, 0.12)",
    tasks: BOARD_TASKS[agent.id] ?? [],
  })),
);

const roleLabel: Record<string, string> = {
  planner: "总规划",
  "geo-analyst": "地理情报",
  "spatial-artist": "空间成型",
  reviewer: "质量审查",
};

const statusLabel: Record<string, string> = {
  working: "正在执行任务…",
  idle: "待命",
  blocked: "阻塞中",
  offline: "离线",
};

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
        <h1 class="view__title">Agent 协作</h1>
        <p class="view__sub">多 Agent 并行编排，自主完成任务流水线。</p>
      </div>
      <div class="view__actions">
        <button class="btn btn--ghost">技能库</button>
        <button class="btn btn--primary">启动循环</button>
      </div>
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
          <span class="panel__title">Agent 编队</span><span class="panel__meta">{{ agentStore.agents.length }} ONLINE</span>
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
                {{ agent.status === "working" ? `正在推进「${BOARD_TASKS[agent.id]?.[0]?.label ?? "任务"}」` : "待命中，随时可接单" }}
              </em>
            </div>
            <span class="status-dot" :data-status="agent.status"></span>
            <div class="agent-card__progress" :style="{ background: softOf(agent.role) }">
              <i :style="{ width: agent.progress + '%', background: toneOf(agent.role) }"></i>
            </div>
            <em class="agent-card__pct">{{ agent.progress }}%</em>
          </div>
        </div>
        <p class="footnote">角色：{{ agentStore.roles.join(" / ") }}</p>
      </div>
      <div class="panel">
        <div class="panel__head">
          <span class="panel__title">编排流水线</span><span class="panel__meta">采集 → 分析 → 报告 → 审查</span>
        </div>
        <ol class="pipeline">
          <li v-for="(step, i) in agentStore.workflowSteps" :key="step.id" class="pipeline__step" :data-status="step.status">
            <span class="pipeline__index">{{ i + 1 }}</span>
            <div class="pipeline__body">
              <strong>{{ step.label }}</strong
              ><span>{{ step.desc }}</span>
            </div>
            <em class="pipeline__status">{{ step.status === "done" ? "完成" : step.status === "active" ? "运行中" : "等待" }}</em>
          </li>
        </ol>
      </div>
      <div class="panel">
        <div class="panel__head">
          <span class="panel__title">循环策略</span><span class="panel__meta">{{ PERM_LABELS[settings.permissionTier] }}</span>
        </div>
        <div class="policy">
          <div class="policy__row">
            <span>最大回合</span><strong>{{ settings.aiLoopPolicy.maxRounds }}</strong>
          </div>
          <div class="policy__row">
            <span>执行档位</span><strong>{{ PERM_LABELS[settings.permissionTier] }}</strong>
          </div>
          <div class="policy__row">
            <span>宿主守卫</span><strong>{{ agentStore.acpAvailable ? "ON（桌面端强制）" : "OFF（Web 无宿主）" }}</strong>
          </div>
          <div class="policy__row">
            <span>工具白名单</span><strong>{{ settings.aiLoopPolicy.toolAllowlist?.length ?? 0 }}</strong>
          </div>
        </div>
        <p class="footnote">权限档位由桌面宿主强制执行：cautious 逐条确认 · daily 仅自动放行只读操作 · auto 直通。</p>
      </div>
    </div>
  </section>
</template>
