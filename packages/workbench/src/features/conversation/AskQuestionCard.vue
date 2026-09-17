<script setup lang="ts">
/**
 * AskUserQuestion 选择菜单（message.ask 消息）：
 * agent 通过一次 `AskUserQuestion` 工具调用提出 1..N 个问题（每个 2–4 个选项，可多选），
 * 这里渲染成选择卡。宿主没有 client→agent 的工具结果通道，所以作答以一条普通用户消息
 * 回传同一会话（单选单题即点即走，其余显式提交），消息侧据此收口为只读态。
 *
 * 每题除给定选项外都留一行「其他」自由输入 —— 工具语义里选项并非穷举，用户常需要补充。
 */
import { computed, reactive } from "vue";
import { useI18n } from "vue-i18n";
import { formatAnswerLine, formatAskAnswer, isAskSettled } from "@/lib/ask-question";
import { dispatchIntent } from "@/lib/dispatch-intent";
import { useTurnActive } from "@/lib/turn-activity";
import { useChatStore } from "@/stores/chat";
import Icon from "@/features/shared/Icon.vue";
import type { AskAnswer, ThreadMessage } from "@/types";

const props = defineProps<{ threadId: string; message: ThreadMessage }>();

const { t } = useI18n();
const chat = useChatStore();

const questions = computed(() => props.message.ask?.questions ?? []);
const settled = computed(() => isAskSettled(props.message.ask));
const answers = computed<AskAnswer[]>(() => props.message.ask?.answers ?? []);

/** 每题已选项（label）。多选存多项，单选存一项。 */
const selections = reactive<Record<number, string[]>>({});
/** 每题的「其他」自由输入。 */
const customs = reactive<Record<number, string>>({});

/** 航次忙碌判定：与 PlanCard 一致，运行中不让作答（提交要启动一个航次）。 */
const busy = useTurnActive();

/** 单选 + 单题：点选项即提交，不必再按一次确认（对齐工具语义的即时选择）。 */
const instant = computed(() => questions.value.length === 1 && !questions.value[0]?.multiSelect);

function isPicked(index: number, label: string): boolean {
  return (selections[index] ?? []).includes(label);
}

function pick(index: number, label: string): void {
  if (settled.value || busy.value) return;
  const question = questions.value[index];
  if (!question) return;
  if (question.multiSelect) {
    const current = new Set(selections[index] ?? []);
    if (current.has(label)) current.delete(label);
    else current.add(label);
    selections[index] = [...current];
    return;
  }
  selections[index] = [label];
  if (instant.value) submit();
}

function answered(index: number): boolean {
  return (selections[index]?.length ?? 0) > 0 || Boolean(customs[index]?.trim());
}

/** 有没有人正在用「其他」自由输入。 */
const anyCustom = computed(() => questions.value.some((_, index) => Boolean(customs[index]?.trim())));

const allAnswered = computed(() => questions.value.every((_, index) => answered(index)));

/** 单选单题点即提交，不需要提交键；但一旦开始自填，就得给一个明确的提交入口。 */
const showSubmit = computed(() => !instant.value || anyCustom.value);

function buildAnswers(): AskAnswer[] {
  return questions.value.map((question, index) => ({
    question: question.question,
    labels: selections[index] ?? [],
    custom: customs[index]?.trim() || undefined,
  }));
}

/** 提交：先把作答写回消息（卡片转只读），再走统一分流点回传给 agent。 */
function submit(): void {
  if (settled.value || busy.value || !allAnswered.value) return;
  const list = buildAnswers();
  chat.markAskAnswered(props.threadId, props.message, list);
  // 作答是对 agent 的回话，不是新的用户意图：不开计划门、不参与编排判定。
  void dispatchIntent(formatAskAnswer({ ...props.message.ask!, answers: list }));
}
</script>

<template>
  <div
    v-if="questions.length"
    data-testid="ask-card"
    :data-settled="settled"
    class="flex flex-col gap-2.5 rounded-[14px] border border-line bg-panel-2 p-3"
  >
    <div class="flex items-center justify-between gap-2">
      <span class="flex min-w-0 items-center gap-1.5 text-[12px] font-medium text-foreground">
        <Icon name="message" :size="13" class="shrink-0 text-cyan" />
        {{ t("chatView.ask.title") }}
      </span>
      <span
        v-if="settled"
        data-testid="ask-answered-badge"
        class="flex h-5 shrink-0 items-center gap-1 rounded-full bg-mint/10 px-2 text-[10.5px] text-mint"
      >
        <Icon name="check-one" :size="10" />
        {{ t("chatView.ask.answered") }}
      </span>
    </div>

    <!-- 只读态：列出当时的作答 -->
    <ul v-if="settled" class="m-0 flex list-none flex-col gap-1.5" data-testid="ask-card-answered">
      <li v-for="answer in answers" :key="answer.question" class="flex items-start gap-1.5 text-[12px] leading-relaxed">
        <Icon name="check" :size="11" class="mt-[3px] shrink-0 text-mint" />
        <span class="min-w-0 text-dim [overflow-wrap:anywhere]">{{ formatAnswerLine(answer) }}</span>
      </li>
    </ul>

    <!-- 作答态 -->
    <div v-else class="flex flex-col gap-3">
      <div v-for="(question, index) in questions" :key="index" class="flex flex-col gap-1.5" :data-testid="`ask-question-${index}`">
        <div class="flex items-baseline gap-1.5">
          <span v-if="question.header" class="shrink-0 rounded-full bg-panel px-1.5 text-[10px] text-dim2">{{ question.header }}</span>
          <span class="min-w-0 text-[12.5px] leading-snug text-foreground [overflow-wrap:anywhere]">{{ question.question }}</span>
          <span v-if="question.multiSelect" class="shrink-0 text-[10px] text-dim2">{{ t("chatView.ask.multiHint") }}</span>
        </div>

        <div class="flex flex-col gap-1">
          <button
            v-for="option in question.options"
            :key="option.label"
            type="button"
            :data-testid="`ask-option-${index}`"
            :aria-pressed="isPicked(index, option.label)"
            :disabled="busy"
            class="flex cursor-pointer items-start gap-2 rounded-[8px] border px-2 py-1.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:opacity-50"
            :class="isPicked(index, option.label) ? 'border-cyan/60 bg-cyan/10' : 'border-line bg-panel hover:border-line-2'"
            @click="pick(index, option.label)"
          >
            <span
              class="mt-[3px] grid size-3.5 shrink-0 place-items-center border"
              :class="[
                question.multiSelect ? 'rounded-[3px]' : 'rounded-full',
                isPicked(index, option.label) ? 'border-cyan bg-cyan text-accent-ink' : 'border-line-2',
              ]"
            >
              <Icon v-if="isPicked(index, option.label)" name="check" :size="8" :stroke-width="3" />
            </span>
            <span class="min-w-0">
              <span class="block text-[12px] text-foreground [overflow-wrap:anywhere]">{{ option.label }}</span>
              <span v-if="option.description" class="block text-[11px] leading-snug text-dim2 [overflow-wrap:anywhere]">{{
                option.description
              }}</span>
            </span>
          </button>
        </div>

        <!-- 「其他」自由输入：选项并非穷举，用户常要自行补充 -->
        <label class="flex items-center gap-2 rounded-[8px] border border-line bg-panel px-2 py-1">
          <Icon name="plus" :size="11" class="shrink-0 text-dim2" />
          <input
            v-model="customs[index]"
            type="text"
            :data-testid="`ask-custom-${index}`"
            :disabled="busy"
            :placeholder="t('chatView.ask.otherPlaceholder')"
            :aria-label="t('chatView.ask.otherPlaceholder')"
            class="min-w-0 flex-1 bg-transparent text-[12px] text-foreground outline-none placeholder:text-dim2 disabled:opacity-50"
          />
        </label>
      </div>

      <div v-if="showSubmit" class="flex items-center justify-end gap-2">
        <span v-if="!allAnswered" class="text-[10.5px] text-dim2">{{ t("chatView.ask.incomplete") }}</span>
        <button
          type="button"
          data-testid="ask-submit"
          :disabled="busy || !allAnswered"
          class="flex h-7 cursor-pointer items-center gap-1.5 rounded-[8px] bg-accent px-3 text-[11.5px] font-medium text-accent-ink transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:opacity-40"
          @click="submit"
        >
          <Icon name="send-one" :size="12" />
          {{ t("chatView.ask.submit") }}
        </button>
      </div>
    </div>
  </div>
</template>
