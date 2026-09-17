<script setup lang="ts">
/**
 * ACP 会话配置选择簇（模型 / 思考强度 / 会话模式等）——单独渲染在输入框下方，不与发送按钮同排。
 * 数据源 agent.acpConfigOptions：agent 在 session/new 暴露什么就渲染什么（select 型）。
 * 状态：
 *  - 连接中 → 状态胶囊；
 *  - 已连接且有配置 → 各配置胶囊（切换走 setAcpConfig，后端确认后回填）；
 *  - 已连接但模型未暴露思考强度 → 提示桩（如 opencode 仅对支持 effort 变体的模型开放）；
 *  - 未连接 / 本地 LLM 路由 → 不渲染。
 */
import { computed } from "vue";
import { useAgentStore } from "@/stores/agent";
import { useWorkspaceStore } from "@/stores/workspace";
import { i18n } from "@/i18n";
import AcpModelSelector from "@/features/conversation/AcpModelSelector.vue";
import AgentScopeSelect from "@/features/conversation/AgentScopeSelect.vue";
import Icon from "@/features/shared/Icon.vue";
import Hint from "@/features/shared/Hint.vue";

const t = i18n.global.t;

const agent = useAgentStore();
const workspaceStore = useWorkspaceStore();

/** 当前工作区是否已记住会话配置（模型 / 思考强度）——记住了才提示，避免空口号。 */
const remembered = computed(() => {
  const values = workspaceStore.agentConfigOf(workspaceStore.activeWorkspaceId)?.configValues;
  return Boolean(values && Object.keys(values).length);
});

/** 思考强度类配置项的判定：opencode 用 category=thought_level + id=effort；
 *  codex / claude-code 等 agent 的 id 各异（reasoning_effort / thought_level…），
 *  统一按 category 或 id 特征识别，避免写死单一 id。 */
const isThoughtLevel = (entry: { id: string; category?: string }): boolean =>
  entry.category === "thought_level" || entry.id === "effort" || entry.id === "reasoning_effort" || entry.id === "thought_level";

/** 模型之外的 select 型配置项（思考强度 / 会话模式等）。键名因 agent 而异，
 *  统一渲染而不是写死 id 去猜，避免后端换了名字就整块消失。 */
const extraOptions = computed(() =>
  agent.acpConfigOptions
    .filter((entry) => entry.type === "select" && entry.id !== "model")
    .map((entry) => ({
      entry,
      // 已知类别走本地化标签；未知配置项回落 agent 自带 name
      label: isThoughtLevel(entry)
        ? t("chat.configThoughtLevel")
        : entry.category === "mode" || entry.id === "mode"
          ? t("chat.configMode")
          : entry.name,
    })),
);

/** 已连接但当前模型未暴露思考强度配置（opencode 仅对支持 effort 变体的模型开放）→ 提示桩 */
const showEffortUnavailable = computed(
  () =>
    agent.acpConnected &&
    agent.acpConfigOptions.length > 0 &&
    !agent.acpConfigOptions.some((entry) => entry.type === "select" && isThoughtLevel(entry)),
);

const connecting = computed(() => agent.acpConnecting || agent.acpStatus === "connecting");
</script>

<template>
  <template v-if="agent.routeToAcp">
    <span
      v-if="connecting"
      class="flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-line bg-panel-2 px-2.5 text-[11px] text-dim"
    >
      <span class="size-2.5 animate-spin rounded-full border border-cyan border-t-transparent" />
      连接中…
    </span>
    <template v-else>
      <AgentScopeSelect />
      <AcpModelSelector option-id="model" placeholder="使用 CLI 模型" icon="magic" />
      <AcpModelSelector
        v-for="extra in extraOptions"
        :key="extra.entry.id"
        :option-id="extra.entry.id"
        :label="extra.label"
        icon="setting"
        show-name
      />
      <Hint
        v-if="showEffortUnavailable"
        text="当前模型不支持思考强度；切换到支持该能力的模型（如 opencode/gpt-5-codex）后会出现选择器"
        multiline
      >
        <span
          class="flex h-6 shrink-0 cursor-default items-center gap-1 rounded-full border border-line bg-panel-2 px-2.5 text-[11px] text-dim2"
        >
          <Icon name="setting" :size="11" class="text-dim2" />
          思考强度 · 模型不支持
        </span>
      </Hint>
      <Hint v-if="remembered" text="模型 / 思考强度已按当前工作区记住，切回该工作区会自动恢复">
        <span
          class="flex h-6 shrink-0 cursor-default items-center gap-1 rounded-full border border-line bg-panel-2 px-2.5 text-[11px] text-dim2"
        >
          <Icon name="pin" :size="11" class="text-dim2" />
          按工作区记忆
        </span>
      </Hint>
      <Hint v-if="agent.acpConnected" text="重启 ACP runtime（重新探测模型与配置）">
        <button
          type="button"
          class="grid size-6 shrink-0 cursor-pointer place-items-center rounded-full border border-line bg-panel-2 text-dim transition-colors hover:border-line-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="agent.acpBusy"
          @click="agent.restartAcpRuntime()"
        >
          <Icon name="refresh" :size="12" />
        </button>
      </Hint>
    </template>
  </template>
</template>
