<script setup lang="ts">
/**
 * ACP 权限卡片，两种形态共用一个组件：
 *
 * - **活跃态**（无 `trace` prop）：读 store 的 `pendingPermission`。宿主发出
 *   permission-request 后在这里给用户逐条确认。宿主 120s 不答复即取消工具调用
 *   （acp_host.rs PERMISSION_CONFIRM_TIMEOUT），store 镜像同一窗口：卡片显示倒计时，
 *   到时自行收卡并留痕。
 * - **只读态**（传 `trace`）：裁决结果随消息落盘后回看的那条记录，挂在会话消息流里
 *   （ConversationMessage）。与 AskQuestionCard / ScheduleConfirmCard 的 settled 态同一约定。
 *
 * 无障碍：活跃态卡片是**内联**在消息流里的，没有遮罩、不抢焦点，身后的消息照样可见可操作，
 * 所以它不是 alertdialog（那是模态变体）也绝不能标 aria-modal —— 那是在告诉辅助技术
 * 「页面其余部分已失活」，而事实相反。这里用「带名字的控件组」：
 * role="group" + aria-labelledby 指向卡片内那行可见标题。只读态是纯展示，不套 role。
 */
import { computed, onBeforeUnmount, ref, useId, watch } from "vue";
import { normalizePermissionOperationKind, toPermissionPanelOptions } from "@greywork/acp/permissions";
import type { PermissionIntent, PermissionOperationKind } from "@greywork/acp/permissions";
import { i18n } from "@/i18n";
import { clipPermissionDetail, permissionCommand } from "@/lib/permission-detail";
import { useAgentStore } from "@/stores/agent";
import Icon from "@/features/shared/Icon.vue";
import Hint from "@/features/shared/Hint.vue";
import type { PermissionTrace } from "@/types";

const props = defineProps<{ trace?: PermissionTrace }>();

const t = i18n.global.t;
const agent = useAgentStore();

const titleId = useId();

/** 只读态：拿到留痕就渲染记录，否则渲染待确认卡片。 */
const settled = computed(() => props.trace !== undefined);

const nowMs = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | null = null;
watch(
  () => agent.pendingPermission,
  (pending) => {
    if (pending && ticker === null) {
      ticker = setInterval(() => {
        nowMs.value = Date.now();
      }, 250);
    } else if (!pending && ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  if (ticker !== null) clearInterval(ticker);
});

const remainingLabel = computed(() => {
  const deadline = agent.permissionDeadline;
  if (deadline === null) return "—";
  const seconds = Math.max(0, Math.ceil((deadline - nowMs.value) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
});

/** 工具类别 → 图标：与工具时间线用同一套视觉语言，用户不必读字就知道在批什么。 */
const KIND_ICONS: Record<PermissionOperationKind, string> = {
  execute: "terminal",
  edit: "edit",
  read: "search",
  fetch: "earth",
  tool: "hammer",
};

const kind = computed(() => props.trace?.kind ?? agent.pendingPermission?.kind ?? "other");
const operation = computed(() => normalizePermissionOperationKind(kind.value));
const kindIcon = computed(() => KIND_ICONS[operation.value]);
const kindLabel = computed(() => t(`chatView.permission.kinds.${operation.value}`));

const title = computed(() => props.trace?.title ?? agent.pendingPermission?.title ?? "");
const paths = computed(() => props.trace?.paths ?? agent.pendingPermission?.locations ?? []);
/** 命令正文：只读态取留痕里存下的，活跃态现从 rawInput 提取。超长先截断再进模板。 */
const commandText = computed(() => {
  const raw = props.trace ? props.trace.command : permissionCommand(agent.pendingPermission?.rawInput);
  return raw ? clipPermissionDetail(raw) : null;
});

const toolCallId = computed(() => agent.pendingPermission?.toolCallId ?? "");

const options = computed(() => toPermissionPanelOptions(agent.pendingPermission?.options ?? []));

/**
 * agent 自己给了 reject 选项（opencode 的 "Reject"）时不再补一个「拒绝」兜底按钮：
 * 两个拒绝并排，用户得停下来读才知道差别（其实差别只是「发不发这个 optionId」）。
 */
const showFallbackDeny = computed(
  () => !options.value.some((option) => option.intent === "reject-once" || option.intent === "reject-always"),
);

/** 按意图分色：允许类可点性最高（accent），拒绝类是中性描边，认不出的走默认。 */
function optionClass(intent: PermissionIntent): string {
  const base =
    "cursor-pointer rounded-[8px] px-2.5 py-1 text-[11.5px] transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan";
  if (intent === "allow-once") return `${base} bg-accent font-medium text-accent-ink`;
  if (intent === "allow-always") return `${base} border border-cyan/60 bg-cyan/10 text-cyan`;
  if (intent === "reject-once" || intent === "reject-always") return `${base} border border-line bg-panel-2 text-dim`;
  return `${base} border border-line bg-panel-2 text-foreground`;
}

/** 留痕徽标文案：谁说、怎么说的，比「已裁决」三个字有用得多。 */
const traceAllowed = computed(() => Boolean(props.trace && props.trace.source !== "timeout" && props.trace.choice));

const traceLabel = computed(() => {
  const trace = props.trace;
  if (!trace) return "";
  if (trace.source === "timeout") return t("chatView.permission.decidedTimeout");
  if (!trace.choice) return t("chatView.permission.decidedDeny");
  return t(trace.source === "auto" ? "chatView.permission.decidedAuto" : "chatView.permission.decidedAllow", {
    choice: trace.choice,
  });
});

const traceIcon = computed(() => {
  if (traceAllowed.value) return "check-one";
  return props.trace?.source === "timeout" ? "clock" : "close-one";
});

const traceDetail = computed(() => {
  const trace = props.trace;
  if (!trace) return "";
  const detail = trace.command ?? trace.paths.join("、");
  return detail ? clipPermissionDetail(detail) : "";
});
</script>

<template>
  <!-- 只读态：会话流里的裁决记录 -->
  <div v-if="settled" data-testid="permission-trace" class="flex items-start gap-2.5 rounded-[14px] border border-line bg-panel-2 p-3">
    <span class="grid size-8 shrink-0 place-items-center rounded-[9px] bg-panel text-dim">
      <Icon :name="kindIcon" :size="15" />
    </span>
    <div class="min-w-0 flex-1">
      <div class="flex items-center justify-between gap-2">
        <span class="flex min-w-0 items-center gap-1.5 text-[12px] font-medium text-foreground">
          {{ kindLabel }}
          <span v-if="title" class="min-w-0 truncate text-[11.5px] font-normal text-dim">{{ title }}</span>
        </span>
        <span
          data-testid="permission-trace-badge"
          class="flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[10.5px]"
          :class="traceAllowed ? 'bg-mint/10 text-mint' : 'bg-amber/15 text-amber'"
        >
          <Icon :name="traceIcon" :size="10" />
          {{ traceLabel }}
        </span>
      </div>
      <p v-if="traceDetail" class="mt-1 break-words text-[11.5px] leading-relaxed text-dim2 [overflow-wrap:anywhere]">
        {{ traceDetail }}
      </p>
    </div>
  </div>

  <!-- 活跃态：待确认的权限请求 -->
  <div
    v-else-if="agent.pendingPermission"
    role="group"
    :aria-labelledby="titleId"
    class="flex items-start gap-2.5 rounded-[14px] border border-line bg-popover p-3 shadow-lg"
    data-testid="permission-card"
  >
    <span class="grid size-8 shrink-0 place-items-center rounded-[9px] bg-amber/15 text-amber">
      <Icon name="shield" :size="15" />
    </span>
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-2">
        <p :id="titleId" class="text-[13px] font-medium text-foreground">{{ t("chatView.permission.title") }}</p>
        <span data-testid="permission-kind" class="flex shrink-0 items-center gap-1 rounded-full bg-panel px-1.5 text-[10px] text-dim">
          <Icon :name="kindIcon" :size="10" />
          {{ kindLabel }}
        </span>
      </div>
      <p v-if="title" class="mt-0.5 break-words text-[12px] leading-relaxed text-dim [overflow-wrap:anywhere]">
        {{ title }}
      </p>
      <pre
        v-if="commandText"
        data-testid="permission-command"
        class="mt-1.5 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded-[8px] bg-panel-2 px-2 py-1.5 font-mono text-[11px] leading-snug text-foreground"
        >{{ commandText }}</pre
      >
      <div v-if="paths.length" class="mt-1.5" data-testid="permission-paths">
        <span class="text-[10.5px] text-dim2">{{ t("chatView.permission.paths") }}</span>
        <ul class="m-0 mt-0.5 flex list-none flex-col gap-0.5 pl-0">
          <!-- 截断的路径：`<li>` 不可聚焦，提示仍只认悬停（与原生 title 同），换过来只为样式统一。 -->
          <Hint v-for="path in paths" :key="path" :text="path" multiline>
            <li class="truncate font-mono text-[11px] text-dim [overflow-wrap:anywhere]">{{ path }}</li>
          </Hint>
        </ul>
      </div>
      <p class="mt-1 text-[10.5px] text-dim2">{{ t("chatView.permission.hint", { s: remainingLabel }) }}</p>
      <Hint :text="toolCallId" multiline>
        <p class="mt-0.5 truncate text-[10px] text-dim2">{{ t("chatView.permission.toolCallId") }} {{ toolCallId }}</p>
      </Hint>
      <div class="mt-2 flex flex-wrap items-center gap-1.5">
        <button
          v-for="option in options"
          :key="option.id"
          type="button"
          :data-testid="`permission-option-${option.intent}`"
          :class="optionClass(option.intent)"
          @click="agent.respondPermission(option.value)"
        >
          {{ option.label }}
        </button>
        <button
          v-if="showFallbackDeny"
          type="button"
          data-testid="permission-deny"
          class="cursor-pointer rounded-[8px] border border-line bg-panel-2 px-2.5 py-1 text-[11.5px] text-dim transition-colors hover:border-line-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
          @click="agent.respondPermission(null)"
        >
          {{ t("chatView.permission.deny") }}
        </button>
      </div>
    </div>
  </div>
</template>
