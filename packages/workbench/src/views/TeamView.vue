<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { useRunsStore } from "../stores/runs";
import { useChatStore } from "../stores/chat";
import { useCoworkStore, type CoworkMemberInit } from "../stores/cowork";
import { useSessionStore } from "../stores/session";
import Icon from "../components/Icon.vue";
import type { PlannerRun, Subtask } from "@greywork/agents";

/**
 * 团队页：
 * 上半是 Cowork 协作运行（leader 拆解派活 + 成员并行执行，靠收件箱与任务板协作）；
 * 下半保留 planner 编排运行的看板（自动执行拆解出的并行子任务）。
 */
const { t } = useI18n();
const runsStore = useRunsStore();
const cowork = useCoworkStore();
const sessionStore = useSessionStore();
const chat = useChatStore();
const router = useRouter();

// ---------- Cowork ----------

const goalDraft = ref("");
const memberDrafts = ref<CoworkMemberInit[]>([
  { name: "Leader", role: "leader" },
  { name: "Builder", role: "teammate", specialty: "builder" },
  { name: "Reviewer", role: "teammate", specialty: "reviewer" },
]);
const startError = ref<string | null>(null);
const messageDraft = ref("");
/** 空串 = 发给 leader。 */
const messageTarget = ref("");

const wakeDot: Record<string, string> = {
  idle: "bg-line-2",
  running: "bg-amber",
  dirty: "bg-cyan",
};

const taskDot: Record<string, string> = {
  pending: "bg-line-2",
  in_progress: "bg-amber",
  done: "bg-mint",
  failed: "bg-destructive",
};

const runBadge: Record<string, string> = {
  running: "bg-amber/10 text-amber",
  paused: "bg-cyan/10 text-cyan",
  done: "bg-mint/10 text-mint",
  failed: "bg-destructive/10 text-destructive",
  cancelled: "bg-panel-2 text-dim",
};

const turnsLabel = computed<string>(() => {
  const spend = cowork.spend;
  if (!spend) return "";
  return t("cowork.turns", { used: spend.turns, max: spend.budget.maxTurns });
});

async function startCowork(): Promise<void> {
  startError.value = null;
  const failure = await cowork.startRun(
    goalDraft.value,
    memberDrafts.value.filter((member) => member.name.trim().length > 0),
  );
  if (failure) {
    startError.value = failure;
    return;
  }
  goalDraft.value = "";
}

function addMember(): void {
  memberDrafts.value.push({ name: "", role: "teammate", specialty: undefined });
}

function removeMember(index: number): void {
  memberDrafts.value.splice(index, 1);
}

function sendToTeam(): void {
  const text = messageDraft.value.trim();
  if (!text) return;
  cowork.sendUser(text, messageTarget.value || undefined);
  messageDraft.value = "";
}

function resumeCowork(): void {
  startError.value = cowork.resumeRun() ? null : t("cowork.errors.resumeStillOver");
}

/** 打开某成员位的会话：协作产出全在各自会话里，流式过程照常可看。 */
function openSlot(threadId: string): void {
  sessionStore.setActive(threadId);
  chat.activeThreadId = threadId;
  void router.push(`/conversation/${threadId}`);
}

// ---------- planner 编排（既有） ----------

const runStatusMeta: Record<PlannerRun["status"], { label: string; badge: string }> = {
  planning: { label: "规划中", badge: "bg-cyan/10 text-cyan" },
  running: { label: "执行中", badge: "bg-amber/10 text-amber" },
  done: { label: "已完成", badge: "bg-mint/10 text-mint" },
  failed: { label: "失败", badge: "bg-destructive/10 text-destructive" },
};

const subStatusMeta: Record<Subtask["status"], { dot: string; label: string }> = {
  pending: { dot: "bg-line-2", label: "待派" },
  running: { dot: "bg-amber", label: "执行" },
  done: { dot: "bg-mint", label: "完成" },
  failed: { dot: "bg-destructive", label: "失败" },
};

const displayRuns = computed(() => runsStore.runs);
const doneCount = (run: PlannerRun): number => run.subtasks.filter((sub) => sub.status === "done").length;

function timeOf(ts: number): string {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function roleLabel(role: string): string {
  const labels: Record<string, string> = {
    planner: "规划",
    researcher: "调研",
    builder: "执行",
    "geo-analyst": "地理",
    "spatial-artist": "制图",
    reviewer: "审查",
  };
  return labels[role] ?? role;
}
</script>

<template>
  <section class="mx-auto min-h-0 h-full w-full max-w-[860px] overflow-y-auto px-4 py-6 sm:px-6">
    <div class="mb-1 flex items-center gap-2">
      <h1 class="font-display text-[20px] font-bold tracking-tight text-foreground">{{ t("cowork.title") }}</h1>
      <span v-if="cowork.status" class="rounded-full px-2 py-0.5 text-[10px] font-medium" :class="runBadge[cowork.status]">
        {{ t(`cowork.runStatus.${cowork.status}`) }}
      </span>
      <span v-if="turnsLabel" class="rounded-full border border-line bg-panel-2 px-2 py-0.5 text-[10px] text-dim">
        {{ turnsLabel }}
      </span>
    </div>
    <p class="mb-4 text-[12px] text-dim2">{{ t("cowork.sub") }}</p>

    <!-- 起一次协作 -->
    <div v-if="!cowork.active" class="rounded-[14px] border border-line bg-panel p-3.5">
      <textarea
        v-model="goalDraft"
        rows="2"
        class="w-full resize-none rounded-[10px] border border-line bg-panel-2 px-3 py-2 text-[13px] text-foreground outline-none placeholder:text-dim2 focus:border-accent"
        :placeholder="t('cowork.goalPlaceholder')"
      />
      <div class="mt-3 text-[11px] font-medium text-dim">{{ t("cowork.members") }}</div>
      <div class="mt-1.5 flex flex-col gap-1.5">
        <div v-for="(member, index) in memberDrafts" :key="index" class="flex items-center gap-1.5">
          <input
            v-model="member.name"
            class="min-w-0 flex-1 rounded-[8px] border border-line bg-panel-2 px-2.5 py-1.5 text-[12px] text-foreground outline-none placeholder:text-dim2 focus:border-accent"
            :placeholder="t('cowork.memberNamePlaceholder')"
          />
          <select
            v-model="member.role"
            class="rounded-[8px] border border-line bg-panel-2 px-2 py-1.5 text-[12px] text-foreground outline-none focus:border-accent"
            data-testid="member-role"
          >
            <option value="leader">{{ t("cowork.role.leader") }}</option>
            <option value="teammate">{{ t("cowork.role.teammate") }}</option>
          </select>
          <select
            v-if="member.role === 'teammate'"
            v-model="member.specialty"
            class="rounded-[8px] border border-line bg-panel-2 px-2 py-1.5 text-[12px] text-foreground outline-none focus:border-accent"
            data-testid="member-specialty"
            :aria-label="t('cowork.specialty.label')"
          >
            <option :value="undefined">{{ t("cowork.specialty.none") }}</option>
            <option value="planner">{{ t("cowork.specialty.planner") }}</option>
            <option value="researcher">{{ t("cowork.specialty.researcher") }}</option>
            <option value="builder">{{ t("cowork.specialty.builder") }}</option>
            <option value="reviewer">{{ t("cowork.specialty.reviewer") }}</option>
          </select>
          <button
            type="button"
            class="grid size-7 place-items-center rounded-[8px] border border-line text-dim transition-colors hover:text-foreground"
            :disabled="memberDrafts.length <= 1"
            :aria-label="t('cowork.removeMember')"
            @click="removeMember(index)"
          >
            <Icon name="close" :size="12" />
          </button>
        </div>
      </div>
      <div class="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          class="flex items-center gap-1 rounded-[8px] border border-line px-2.5 py-1.5 text-[12px] text-dim transition-colors hover:text-foreground"
          @click="addMember"
        >
          <Icon name="plus" :size="12" />
          {{ t("cowork.addMember") }}
        </button>
        <button
          type="button"
          class="ml-auto rounded-[8px] bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-ink disabled:opacity-50"
          :disabled="cowork.starting"
          @click="startCowork"
        >
          {{ cowork.starting ? t("cowork.starting") : t("cowork.start") }}
        </button>
      </div>
      <p v-if="startError" class="mt-2 text-[11px] text-destructive">{{ startError }}</p>
    </div>

    <!-- 进行中的协作 -->
    <div v-else class="flex flex-col gap-2.5">
      <div class="rounded-[14px] border border-line bg-panel p-3.5">
        <div class="text-[13px] font-medium text-foreground">{{ cowork.goal }}</div>
        <div class="mt-2 flex flex-wrap gap-1.5">
          <button
            v-for="slot in cowork.slots"
            :key="slot.id"
            type="button"
            class="flex items-center gap-1.5 rounded-full border border-line bg-panel-2 px-2.5 py-1 text-[11px] text-dim transition-colors hover:text-foreground"
            :title="t(`cowork.wake.${slot.wake}`)"
            @click="openSlot(slot.threadId)"
          >
            <span class="size-1.5 rounded-full" :class="wakeDot[slot.wake]" />
            <span class="text-foreground">{{ slot.name }}</span>
            <span class="text-dim2">{{ t(`cowork.role.${slot.role}`) }}</span>
            <span v-if="slot.specialty" class="rounded-full bg-panel px-1.5 text-[10px] text-cyan">{{
              t(`cowork.specialty.${slot.specialty}`)
            }}</span>
            <span v-if="slot.unread > 0" class="rounded-full bg-cyan/15 px-1.5 text-[10px] text-cyan">{{ slot.unread }}</span>
            <span class="tabular-nums text-dim2">{{ slot.turns }}</span>
            <span v-if="slot.status === 'failed'" class="text-destructive">!</span>
          </button>
        </div>
        <p v-if="cowork.pausedReason" class="mt-2.5 rounded-[8px] bg-panel-2 px-2.5 py-2 text-[11px] text-dim">
          {{ t("cowork.pausedHint", { reason: t(`cowork.breach.${cowork.pausedReason}`) }) }}
        </p>
        <div class="mt-2.5 flex items-center gap-2 text-[10px] text-dim2">
          <span>{{ t("cowork.inflight", { count: cowork.stats.inflight }) }}</span>
          <span>{{ t("cowork.unread", { count: cowork.stats.unread }) }}</span>
          <div class="ml-auto flex items-center gap-1.5">
            <button
              v-if="cowork.status === 'paused'"
              type="button"
              class="rounded-[8px] border border-line px-2.5 py-1 text-[11px] text-dim transition-colors hover:text-foreground"
              @click="resumeCowork"
            >
              {{ t("cowork.resume") }}
            </button>
            <button
              v-else
              type="button"
              class="rounded-[8px] border border-line px-2.5 py-1 text-[11px] text-dim transition-colors hover:text-foreground"
              @click="cowork.pauseRun()"
            >
              {{ t("cowork.pause") }}
            </button>
            <button
              type="button"
              class="rounded-[8px] border border-line px-2.5 py-1 text-[11px] text-dim transition-colors hover:text-destructive"
              @click="cowork.stopRun()"
            >
              {{ t("cowork.stop") }}
            </button>
          </div>
        </div>
        <p v-if="startError" class="mt-2 text-[11px] text-destructive">{{ startError }}</p>
      </div>

      <!-- 对团队说话 -->
      <div class="flex items-center gap-1.5">
        <select
          v-model="messageTarget"
          class="rounded-[8px] border border-line bg-panel-2 px-2 py-2 text-[12px] text-foreground outline-none focus:border-accent"
        >
          <option value="">{{ t("cowork.role.leader") }}</option>
          <option v-for="slot in cowork.slots" :key="slot.id" :value="slot.id">{{ slot.name }}</option>
        </select>
        <input
          v-model="messageDraft"
          class="min-w-0 flex-1 rounded-[8px] border border-line bg-panel-2 px-3 py-2 text-[12px] text-foreground outline-none placeholder:text-dim2 focus:border-accent"
          :placeholder="t('cowork.sendPlaceholder')"
          @keydown.enter.prevent="sendToTeam"
        />
        <button type="button" class="rounded-[8px] bg-accent px-3 py-2 text-[12px] font-medium text-accent-ink" @click="sendToTeam">
          {{ t("cowork.send") }}
        </button>
      </div>

      <!-- 任务板 -->
      <div class="rounded-[14px] border border-line bg-panel p-3.5">
        <div class="mb-2 text-[11px] font-medium text-dim">{{ t("cowork.board") }}</div>
        <p v-if="cowork.tasks.length === 0" class="text-[11px] text-dim2">{{ t("cowork.emptyTasks") }}</p>
        <div v-else class="flex flex-col gap-1.5">
          <div v-for="task in cowork.tasks" :key="task.id" class="rounded-[10px] bg-panel-2 px-2.5 py-2">
            <div class="flex items-center gap-2">
              <span class="size-1.5 shrink-0 rounded-full" :class="taskDot[task.status]" />
              <span class="min-w-0 flex-1 truncate text-[12px] text-foreground">{{ task.subject }}</span>
              <span class="shrink-0 text-[10px] text-dim2">{{ t(`cowork.taskStatus.${task.status}`) }}</span>
              <span v-if="task.ownerName" class="shrink-0 text-[10px] text-dim">{{ task.ownerName }}</span>
            </div>
            <div v-if="task.blockedBy.length > 0" class="mt-1 text-[10px] text-dim2">⛓ {{ task.blockedBy.join("、") }}</div>
            <p v-if="task.result" class="mt-1 line-clamp-3 text-[11px] text-dim">{{ task.result }}</p>
          </div>
        </div>
      </div>

      <!-- 协作往来 -->
      <div class="rounded-[14px] border border-line bg-panel p-3.5">
        <div class="mb-2 text-[11px] font-medium text-dim">{{ t("cowork.activityTitle") }}</div>
        <p v-if="cowork.activity.length === 0" class="text-[11px] text-dim2">{{ t("cowork.emptyActivity") }}</p>
        <div v-else class="flex flex-col gap-1.5">
          <div v-for="item in cowork.activity.slice(0, 30)" :key="item.id" class="rounded-[10px] bg-panel-2 px-2.5 py-2">
            <div class="flex items-center gap-1.5 text-[10px] text-dim2">
              <span class="text-dim">{{ item.fromName }}</span>
              <Icon name="right" :size="10" />
              <span class="text-dim">{{ item.toName }}</span>
              <span class="rounded-full bg-panel px-1.5">{{ t(`cowork.mailKind.${item.kind}`) }}</span>
              <span v-if="!item.read" class="text-cyan">●</span>
              <span class="ml-auto tabular-nums">{{ timeOf(item.createdAt) }}</span>
            </div>
            <p class="mt-1 line-clamp-4 whitespace-pre-wrap text-[11px] text-foreground">{{ item.summary || item.body }}</p>
          </div>
        </div>
      </div>
    </div>

    <!-- planner 编排运行（既有） -->
    <div class="mt-6 mb-2 flex items-center gap-2">
      <h2 class="font-display text-[14px] font-semibold text-foreground">编排运行</h2>
      <span class="rounded-full border border-line bg-panel-2 px-2 py-0.5 text-[10px] text-dim">
        并行上限 {{ runsStore.maxParallel }}
      </span>
    </div>

    <div v-if="displayRuns.length === 0" class="flex flex-col items-center gap-2 py-10 text-center">
      <Icon name="peoples" :size="24" class="text-line-2" />
      <p class="text-[12px] text-dim2">还没有编排运行。<br />在会话里发起「自动执行」，拆解出的子任务进度会实时出现在这里。</p>
    </div>

    <div class="flex flex-col gap-2.5">
      <article v-for="run in displayRuns" :key="run.id" class="rounded-[14px] border border-line bg-panel p-3.5">
        <div class="flex items-start gap-2.5">
          <span class="mt-0.5 grid size-7 shrink-0 place-items-center rounded-[8px] bg-panel-2 text-dim">
            <Icon name="peoples" :size="14" />
          </span>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="rounded-full px-2 py-0.5 text-[10px] font-medium" :class="runStatusMeta[run.status].badge">
                {{ runStatusMeta[run.status].label }}
              </span>
              <span class="text-[10px] text-dim2">{{ timeOf(run.createdAt) }}</span>
            </div>
            <div class="mt-1 truncate text-[13px] font-medium text-foreground">{{ run.goal }}</div>

            <div class="mt-2 flex flex-wrap gap-1.5">
              <span
                v-for="sub in run.subtasks"
                :key="sub.id"
                class="flex items-center gap-1.5 rounded-full border border-line bg-panel-2 px-2 py-0.5 text-[10px] text-dim"
              >
                <span class="size-1.5 rounded-full" :class="subStatusMeta[sub.status].dot" />
                {{ roleLabel(sub.role) }} · {{ subStatusMeta[sub.status].label }}
              </span>
            </div>

            <div v-if="run.subtasks.length" class="mt-2.5 flex items-center gap-2">
              <div class="h-1 flex-1 overflow-hidden rounded-full bg-panel-2">
                <div
                  class="h-full rounded-full bg-accent transition-[width]"
                  :style="{ width: `${(doneCount(run) / run.subtasks.length) * 100}%` }"
                />
              </div>
              <span class="text-[10px] tabular-nums text-dim2">{{ doneCount(run) }}/{{ run.subtasks.length }}</span>
            </div>
          </div>
        </div>
      </article>
    </div>
  </section>
</template>
