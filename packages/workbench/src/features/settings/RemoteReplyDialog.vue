<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { appEvents } from "@/events";
import { useAgentStore } from "@/stores/agent";
import { useSettingsStore, type RemoteReplyMode } from "@/stores/settings";
import Icon from "@/features/shared/Icon.vue";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

/**
 * 回复管线配置弹窗：远程消息由谁回答。
 *
 * 两档：本机模型供应商（无工具）或 ACP 后端（agent 带工具执行）。选 ACP 时再往下
 * 一层——**后端 + 会话级细粒度配置**（模型 / 思考强度 / 会话模式）。细粒度项直接来自
 * agent 在 session/new 暴露的 `acpConfigOptions`：agent 有什么就配什么，留空 =
 * 跟随当前会话（对话页怎么选就怎么用）。
 *
 * 本面板只管「用哪个」，增删后端在 设置 → Agent。
 */
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const settings = useSettingsStore();
const agent = useAgentStore();

/** 回复后端两个档位（顺序即界面顺序）。 */
const REPLY_MODES: RemoteReplyMode[] = ["llm", "acp"];
/** ACP 档位可选的后端：只列启用项（停用的后端不该出现在「用哪个」里）。 */
const enabledAgentProviders = computed(() => agent.agentProviders.filter((provider) => provider.enabled));

/**
 * 细粒度项：agent 当前暴露的 select 型配置（model / effort / mode …）。
 * 未知 id 的展示名回落 agent 自带 name；类别已知的走本地化标签。
 */
const configOptions = computed(() =>
  agent.acpConfigOptions
    .filter((entry) => entry.type === "select" && (entry.options?.length ?? 0) > 1)
    .map((entry) => ({
      id: entry.id,
      label: entry.name,
      current: String(entry.currentValue ?? ""),
      choices: entry.options ?? [],
      override: settings.remoteAssist.acpConfigValues[entry.id] ?? "",
    })),
);

function setOverride(configId: string, value: string): void {
  settings.setRemoteAcpConfigValue(configId, value);
}

/** 跳到「设置 → Agent」管理 ACP 后端（本面板只管用哪个，不管增删）。 */
function openAgentSettings(): void {
  appEvents.emit("settings:open", { section: "agent" });
}

function onOpenChange(next: boolean): void {
  if (!next) emit("close");
}
</script>

<template>
  <Dialog :open="props.open" @update:open="onOpenChange">
    <DialogContent
      :show-close-button="false"
      class="flex max-h-[88vh] flex-col gap-0 overflow-hidden rounded-[14px] border-line bg-panel p-0 shadow-xl sm:max-w-[520px]"
      data-testid="remote-reply-dialog"
    >
      <div class="flex items-center justify-between px-4 pb-2 pt-3.5">
        <div class="flex min-w-0 items-center gap-2.5">
          <span class="grid size-7 shrink-0 place-items-center rounded-[8px] border border-line bg-panel-2 text-dim">
            <Icon name="robot" :size="14" />
          </span>
          <div class="min-w-0">
            <DialogTitle class="text-[13px] font-medium text-foreground">{{ t("remoteAssist.rows.replyName") }}</DialogTitle>
            <DialogDescription class="mt-0.5 text-[10.5px] leading-relaxed text-dim2">
              {{ t("remoteAssist.settings.replyHint") }}
            </DialogDescription>
          </div>
        </div>
        <button
          type="button"
          class="grid size-6 shrink-0 cursor-pointer place-items-center rounded-[6px] text-dim transition-colors hover:bg-panel-2 hover:text-foreground"
          aria-label="关闭"
          @click="emit('close')"
        >
          <Icon name="close" :size="13" />
        </button>
      </div>

      <div class="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4 pt-1">
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="mode in REPLY_MODES"
            :key="mode"
            type="button"
            class="h-7 cursor-pointer rounded-[7px] border px-2.5 text-[11.5px] transition-colors"
            :class="
              settings.remoteAssist.replyMode === mode
                ? 'border-accent bg-panel-2 text-foreground'
                : 'border-line bg-panel-2 text-dim hover:border-line-2 hover:text-foreground'
            "
            :aria-pressed="settings.remoteAssist.replyMode === mode"
            :data-testid="`reply-mode-${mode}`"
            @click="settings.setRemoteAssist({ replyMode: mode })"
          >
            {{ mode === "llm" ? t("remoteAssist.settings.replyLlm") : t("remoteAssist.settings.replyAcp") }}
          </button>
        </div>

        <template v-if="settings.remoteAssist.replyMode === 'acp'">
          <label class="flex items-center gap-2">
            <span class="w-24 shrink-0 text-[11.5px] text-dim2">{{ t("remoteAssist.settings.replyProvider") }}</span>
            <select
              class="min-w-0 flex-1 cursor-pointer rounded-[8px] border border-line bg-panel-2 px-2 py-1.5 text-[12.5px] text-foreground outline-none focus:border-line-2"
              data-testid="reply-provider"
              :value="settings.remoteAssist.replyProviderId ?? ''"
              @change="settings.setRemoteAssist({ replyProviderId: ($event.target as HTMLSelectElement).value || null })"
            >
              <option value="">{{ t("remoteAssist.settings.replyProviderFollow") }}</option>
              <option v-for="provider in enabledAgentProviders" :key="provider.id" :value="provider.id">
                {{ provider.name }}
              </option>
            </select>
          </label>
          <p
            v-if="enabledAgentProviders.length === 0"
            class="text-[10.5px] leading-relaxed text-destructive"
            data-testid="reply-provider-empty"
          >
            {{ t("remoteAssist.settings.replyProviderEmpty") }}
          </p>
          <p class="text-[10.5px] leading-relaxed text-dim2">{{ t("remoteAssist.settings.replyProviderShared") }}</p>

          <div class="border-t border-line pt-3">
            <span class="block text-[12px] text-foreground">{{ t("remoteAssist.settings.fineGrained") }}</span>
            <span class="text-[11px] text-dim2">{{ t("remoteAssist.settings.fineGrainedHint") }}</span>

            <div v-if="configOptions.length" class="mt-2 flex flex-col gap-2" data-testid="reply-config-options">
              <label v-for="option in configOptions" :key="option.id" class="flex items-center gap-2">
                <span class="w-24 shrink-0 truncate text-[11.5px] text-dim2">{{ option.label }}</span>
                <select
                  class="min-w-0 flex-1 cursor-pointer rounded-[8px] border border-line bg-panel-2 px-2 py-1.5 text-[12px] text-foreground outline-none focus:border-line-2"
                  :data-testid="`reply-config-${option.id}`"
                  :value="option.override"
                  @change="setOverride(option.id, ($event.target as HTMLSelectElement).value)"
                >
                  <option value="">{{ t("remoteAssist.settings.followSession", { current: option.current || "—" }) }}</option>
                  <option v-for="choice in option.choices" :key="String(choice.value)" :value="String(choice.value)">
                    {{ choice.name ?? String(choice.value) }}
                  </option>
                </select>
              </label>
            </div>
            <p v-else class="mt-2 rounded-[10px] border border-line bg-panel-2 px-3 py-2 text-[11px] leading-relaxed text-dim2">
              {{ t("remoteAssist.settings.fineGrainedEmpty") }}
            </p>
          </div>
        </template>

        <button
          type="button"
          class="h-7 w-fit cursor-pointer rounded-[7px] border border-line bg-panel-2 px-2.5 text-[11.5px] text-dim transition-colors hover:border-line-2 hover:text-foreground"
          data-testid="reply-open-agent-settings"
          @click="openAgentSettings"
        >
          {{ t("remoteAssist.settings.openAgentSettings") }}
        </button>
      </div>
    </DialogContent>
  </Dialog>
</template>
