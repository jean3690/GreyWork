<script setup lang="ts">
/**
 * 团队页 · Cowork 协作面板：起跑表单（成员位 / 目标）与进行中的协作集群
 * （成员位胶囊 / 暂停恢复 / 对团队说话 / 任务板 / 协作往来）。
 */
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import Icon from "@/features/shared/Icon.vue";
import Hint from "@/features/shared/Hint.vue";
import { configOptionLabel } from "@/lib/acp-config-options";
import { useAgentStore } from "@/stores/agent";
import { useChatStore } from "@/stores/chat";
import { useCoworkStore, type CoworkMemberInit } from "@/stores/cowork";
import { useSessionStore } from "@/stores/session";

const { t } = useI18n();
const cowork = useCoworkStore();
const sessionStore = useSessionStore();
const agentStore = useAgentStore();
const chat = useChatStore();
const router = useRouter();

/** 可选的 ACP 后端：成员位各自挑一个，不选则跟随全局。 */
const acpProviders = computed(() => agentStore.agentProviders);

/** 成员位实际会用到的后端 id：显式指定优先，跟随全局。 */
function memberProviderIdOf(member: CoworkMemberInit): string | undefined {
  return member.providerId ?? agentStore.selectedProviderId;
}

/** 该成员位后端暴露的 select 型会话配置（未探测 / 探测失败时为空）。 */
function memberConfigOptions(member: CoworkMemberInit) {
  const providerId = memberProviderIdOf(member);
  return providerId ? cowork.optionsOf(providerId).filter((option) => option.type === "select") : [];
}

/** 展开成员配置编辑区的行（一次只开一行）。 */
const configTarget = ref<number | null>(null);

function toggleMemberConfig(index: number): void {
  if (configTarget.value === index) {
    configTarget.value = null;
    return;
  }
  configTarget.value = index;
  const member = memberDrafts.value[index];
  const providerId = memberProviderIdOf(member);
  if (providerId) void cowork.probeProviderOptions(providerId);
}

function setMemberConfig(member: CoworkMemberInit, configId: string, value: string): void {
  if (!member.configValues) member.configValues = {};
  if (value === "") delete member.configValues[configId];
  else member.configValues[configId] = value;
}

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

/*** 活动流只展示最近 30 条（拖长会堆到整个列表）。 */
const visibleActivity = computed(() => cowork.activity.slice(0, 30));

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

function timeOf(ts: number): string {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

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
</script>

<template>
  <div>
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
        <div v-for="(member, index) in memberDrafts" :key="index" class="flex flex-wrap items-center gap-1.5">
          <input
            v-model="member.name"
            class="min-w-[120px] flex-1 rounded-[8px] border border-line bg-panel-2 px-2.5 py-1.5 text-[12px] text-foreground outline-none placeholder:text-dim2 focus:border-accent"
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
          <!-- 后端按成员选：整个队伍跑同一个 agent 只是退化情况 -->
          <!-- title 与 aria-label 文案相同：可读名已由 aria-label 提供，重复的悬停提示没有增量，直接不留 -->
          <select
            v-model="member.providerId"
            class="max-w-[150px] rounded-[8px] border border-line bg-panel-2 px-2 py-1.5 text-[12px] text-foreground outline-none focus:border-accent"
            data-testid="member-provider"
            :aria-label="t('cowork.provider.label')"
          >
            <option :value="undefined">{{ t("cowork.provider.followGlobal") }}</option>
            <option v-for="provider in acpProviders" :key="provider.id" :value="provider.id">{{ provider.name }}</option>
          </select>
          <!-- 成员级会话配置（模型 / 思考强度…）：展开后按该后端上报项逐个选择 -->
          <button
            type="button"
            data-testid="member-config-toggle"
            class="rounded-[8px] border px-2 py-1.5 text-[11.5px] transition-colors"
            :class="configTarget === index ? 'border-accent/50 text-foreground' : 'border-line text-dim hover:text-foreground'"
            :aria-expanded="configTarget === index"
            @click="toggleMemberConfig(index)"
          >
            {{ t("cowork.memberConfig.label") }}
          </button>
          <!-- 纯图标按钮：aria-label 只服务读屏，看得见的人需要一条悬停提示。
               （上面那个后端 <select> 不留提示，是因为它自己有可见的选中值。） -->
          <Hint :text="t('cowork.removeMember')">
            <button
              type="button"
              class="grid size-7 place-items-center rounded-[8px] border border-line text-dim transition-colors hover:text-foreground"
              :disabled="memberDrafts.length <= 1"
              :aria-label="t('cowork.removeMember')"
              @click="removeMember(index)"
            >
              <Icon name="close" :size="12" />
            </button>
          </Hint>
          <div v-if="configTarget === index" data-testid="member-config-area" class="flex w-full flex-wrap items-center gap-1.5 ps-1">
            <span v-if="cowork.probingProviders[memberProviderIdOf(member) ?? '']" class="text-[11px] text-dim2">
              {{ t("cowork.memberConfig.probing") }}
            </span>
            <p v-else-if="memberConfigOptions(member).length === 0" class="text-[11px] text-dim2">
              {{ t("cowork.memberConfig.probeFailed") }}
            </p>
            <label v-for="option in memberConfigOptions(member)" :key="option.id" class="flex items-center gap-1">
              <span class="text-[11px] text-dim2">{{ configOptionLabel(option) }}</span>
              <select
                class="max-w-[140px] rounded-[8px] border border-line bg-panel-2 px-2 py-1 text-[11.5px] text-foreground outline-none focus:border-accent"
                :data-testid="`member-config-${option.id}`"
                :aria-label="configOptionLabel(option)"
                :value="member.configValues?.[option.id] ?? ''"
                @change="setMemberConfig(member, option.id, ($event.target as HTMLSelectElement).value)"
              >
                <option value="">{{ t("cowork.memberConfig.followBackend") }}</option>
                <option v-for="choice in option.options" :key="choice.value" :value="choice.value">{{ choice.name }}</option>
              </select>
            </label>
          </div>
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
          <Hint v-for="slot in cowork.slots" :key="slot.id" :text="t(`cowork.wake.${slot.wake}`)" multiline>
            <button
              type="button"
              class="flex items-center gap-1.5 rounded-full border border-line bg-panel-2 px-2.5 py-1 text-[11px] text-dim transition-colors hover:text-foreground"
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
          </Hint>
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
          <div v-for="item in visibleActivity" :key="item.id" class="rounded-[10px] bg-panel-2 px-2.5 py-2">
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
  </div>
</template>
