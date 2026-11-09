<script setup lang="ts">
/**
 * ACP 会话配置选择簇（模型 / 思考强度 / 会话模式等）——单独渲染在输入框下方，不与发送按钮同排。
 * 数据源 agent.acpConfigOptions：agent 在 session/new 暴露什么就渲染什么——select 型出下拉胶囊，
 * boolean 型出开关胶囊（协议里两种都存在，早先只消费 select 会把开关类配置整个漏掉）。
 * 旧版 `modes` 已由 runtime 合成为一条 select 型 config option，这里无感复用。
 * 状态：
 *  - 连接中 → 状态胶囊；
 *  - 已连接且有配置 → 各配置胶囊（切换走 setAcpConfig，后端确认后回填）；
 *  - 已连接但模型未暴露思考强度 → 提示桩（如 opencode 仅对支持 effort 变体的模型开放）；
 *  - 未连接 / 本地 LLM 路由 → 不渲染。
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useAgentStore } from "@/stores/agent";
import { useWorkspaceStore } from "@/stores/workspace";
import { acpDefaultConfigValues, clearAcpDefaultConfig, setAcpDefaultConfig } from "@/stores/agent/shared";
import { notify } from "@/stores/notice";
import { configOptionLabel, isThoughtLevelConfigOption } from "@/lib/acp-config-options";
import AcpModelSelector from "@/features/conversation/AcpModelSelector.vue";
import AgentScopeSelect from "@/features/conversation/AgentScopeSelect.vue";
import Icon from "@/features/shared/Icon.vue";
import Hint from "@/features/shared/Hint.vue";
const { t } = useI18n();
const agent = useAgentStore();
const workspaceStore = useWorkspaceStore();

/** 当前工作区是否已记住会话配置（模型 / 思考强度）——记住了才提示，避免空口号。 */
const remembered = computed(() => {
  const values = workspaceStore.agentConfigOf(workspaceStore.activeWorkspaceId)?.configValues;
  return Boolean(values && Object.keys(values).length);
});

/** 思考强度类配置项的判定与标签已抽到 lib/acp-config-options.ts（与 cowork 成员配置共用）。 */

/** 模型之外的 select 型配置项（思考强度 / 会话模式等）。键名因 agent 而异，
 *  统一渲染而不是写死 id 去猜，避免后端换了名字就整块消失。 */
const extraOptions = computed(() =>
  agent.acpConfigOptions
    .filter((entry) => entry.type === "select" && entry.id !== "model")
    .map((entry) => ({
      entry,
      label: configOptionLabel(entry),
    })),
);

/**
 * 已连接但当前模型未暴露思考强度配置（opencode 仅对支持 effort 变体的模型开放）→ 提示桩。
 * 必须真的暴露了 model 选择器才提示：只有旧版 modes（或别的布尔配置）的 agent 不该被劝去换模型。
 */
const showEffortUnavailable = computed(
  () =>
    agent.acpConnected &&
    agent.acpConfigOptions.some((entry) => entry.type === "select" && entry.id === "model") &&
    !agent.acpConfigOptions.some((entry) => entry.type === "select" && isThoughtLevelConfigOption(entry)),
);

/**
 * boolean 型配置项：协议允许 agent 暴露开关（如「允许网络」）。渲染成胶囊，
 * 点击即取反——值由后端确认后经 config-options 事件回填，不做本地乐观翻转。
 */
const booleanOptions = computed(() =>
  agent.acpConfigOptions
    .filter((entry) => entry.type === "boolean")
    .map((entry) => ({
      entry,
      label: entry.name || entry.id,
      enabled: entry.currentValue === true,
    })),
);

async function toggleBoolean(optionId: string, next: boolean): Promise<void> {
  await agent.setAcpConfig(optionId, next);
}

/** 是否已设置全局默认（决定「清除」入口是否出现）。 */
const hasGlobalDefault = computed(() => Object.keys(acpDefaultConfigValues.value).length > 0);

/** 把当前会话所有 select 型配置的当前值固化为全局默认（新工作区 / 无工作区记忆时兜底）。 */
function saveGlobalDefault(): void {
  const values: Record<string, string> = {};
  for (const entry of agent.acpConfigOptions) {
    if (entry.type === "select" && typeof entry.currentValue === "string" && entry.currentValue) values[entry.id] = entry.currentValue;
  }
  if (Object.keys(values).length === 0) return;
  setAcpDefaultConfig(values);
  notify({
    kind: "success",
    key: "acp-default-set",
    title: t("chat.acp.defaultSetTitle"),
    detail: t("chat.acp.defaultSetDetail"),
  });
}

function removeGlobalDefault(): void {
  clearAcpDefaultConfig();
  notify({
    kind: "success",
    key: "acp-default-cleared",
    title: t("chat.acp.defaultClearedTitle"),
    detail: t("chat.acp.defaultClearedDetail"),
  });
}

const connecting = computed(() => agent.acpConnecting || agent.acpStatus === "connecting");
</script>

<template>
  <template v-if="agent.routeToAcp">
    <span
      v-if="connecting"
      class="flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-line bg-panel-2 px-2.5 text-[11px] text-dim"
    >
      <span class="size-2.5 animate-spin rounded-full border border-cyan border-t-transparent" />
      {{ t("chat.acp.connecting") }}
    </span>
    <template v-else>
      <AgentScopeSelect />
      <AcpModelSelector option-id="model" :placeholder="t('chat.acp.useCliModel')" icon="magic" />
      <AcpModelSelector
        v-for="extra in extraOptions"
        :key="extra.entry.id"
        :option-id="extra.entry.id"
        :label="extra.label"
        icon="setting"
        show-name
      />
      <Hint
        v-for="option in booleanOptions"
        :key="option.entry.id"
        :text="t('chat.acp.toggleHint', { label: option.label, state: option.enabled ? t('chat.acp.on') : t('chat.acp.off') })"
      >
        <button
          type="button"
          class="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-full border px-2.5 text-[11px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
          :class="
            option.enabled
              ? 'border-accent/50 bg-panel-2 text-foreground'
              : 'border-line bg-panel-2 text-dim hover:border-line-2 hover:text-foreground'
          "
          :aria-pressed="option.enabled"
          :data-testid="`acp-config-boolean-${option.entry.id}`"
          @click="void toggleBoolean(option.entry.id, !option.enabled)"
        >
          <Icon name="setting" :size="11" class="text-dim2" />
          {{ option.label }}
          <span class="text-dim2">{{ option.enabled ? t("chat.acp.on") : t("chat.acp.off") }}</span>
        </button>
      </Hint>
      <Hint v-if="showEffortUnavailable" :text="t('chat.acp.effortUnsupportedHint')" multiline>
        <span
          class="flex h-6 shrink-0 cursor-default items-center gap-1 rounded-full border border-line bg-panel-2 px-2.5 text-[11px] text-dim2"
        >
          <Icon name="setting" :size="11" class="text-dim2" />
          {{ t("chat.acp.effortUnsupported") }}
        </span>
      </Hint>
      <Hint v-if="remembered" :text="t('chat.acp.rememberedHint')">
        <span
          class="flex h-6 shrink-0 cursor-default items-center gap-1 rounded-full border border-line bg-panel-2 px-2.5 text-[11px] text-dim2"
        >
          <Icon name="pin" :size="11" class="text-dim2" />
          {{ t("chat.acp.remembered") }}
        </span>
      </Hint>
      <Hint v-if="agent.acpConnected" :text="t('chat.acp.setDefaultHint')">
        <button
          type="button"
          data-testid="acp-default-set"
          class="grid h-6 shrink-0 cursor-pointer place-items-center rounded-full border border-line bg-panel-2 px-2 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
          @click="saveGlobalDefault"
        >
          {{ t("chat.acp.setDefault") }}
        </button>
      </Hint>
      <Hint v-if="hasGlobalDefault" :text="t('chat.acp.clearDefaultHint')">
        <button
          type="button"
          data-testid="acp-default-clear"
          class="grid h-6 shrink-0 cursor-pointer place-items-center rounded-full border border-line bg-panel-2 px-2 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
          @click="removeGlobalDefault"
        >
          {{ t("chat.acp.clearDefault") }}
        </button>
      </Hint>
      <Hint v-if="agent.acpConnected" :text="t('chat.acp.restartHint')">
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
