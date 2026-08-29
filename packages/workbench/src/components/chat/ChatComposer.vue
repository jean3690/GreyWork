<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { REASONING_EFFORTS, type ReasoningEffort } from "@greywork/shell";
import { useChatStore } from "../../stores/chat";
import { PERMISSION_TIERS, useSettingsStore } from "../../stores/settings";
import { useWorkspaceStore } from "../../stores/workspace";
import { useSessionStore } from "../../stores/session";
import { getPluginMarket } from "../../state/pluginMarket";
import { Paperclip, Plus, Send, Shield, ShieldCheck, ShieldOff, SlidersHorizontal, Square, X } from "lucide-vue-next";
import { Button, Dialog, FilePick, Select, type SelectOption, Switch } from "../ui";
import type { AcpSessionConfigOption } from "@greywork/acp";
import { useAgentStore } from "../../stores/agent";
import { useI18n } from "vue-i18n";

const { t } = useI18n();
const chat = useChatStore();
const settings = useSettingsStore();
const agentStore = useAgentStore();
const workspaceStore = useWorkspaceStore();
const sessionStore = useSessionStore();
const pluginMarket = getPluginMarket();

const draft = defineModel<string>("draft", { default: "" });
const attachments = defineModel<string[]>("attachments", { default: () => [] });

const inputEl = ref<HTMLTextAreaElement | null>(null);
const plusMenuOpen = ref(false);
const advancedOpen = ref(false);
const mentionOpen = ref(false);
const confirmOpen = ref(false);
const acpPopOpen = ref(false);
const acpConfigError = ref("");

const selectedProvider = computed(() => agentStore.agentProviders.find((p) => p.id === agentStore.selectedProviderId));

const acpSelectOptions = computed(() => agentStore.acpConfigOptions.filter((o) => o.type === "select" && o.options?.length));

const activeThreadProjectName = computed(() => {
  const session = sessionStore.getSession(chat.activeThreadId);
  return session?.workspaceId ? (workspaceStore.workspaceById(session.workspaceId)?.name ?? null) : null;
});

/* ── 模型选择（自 TopBar 迁入） ── */
const modelOptions = computed<SelectOption[]>(() =>
  settings.modelProviders
    .filter((p) => p.id !== "custom" && p.enabled && p.model.trim())
    .map((p) => ({ label: `${p.name} · ${p.model}`, value: p.id })),
);
const selectedModel = computed(() => {
  const preferred = settings.selectedModelProviderId;
  return (preferred && modelOptions.value.some((o) => o.value === preferred) ? preferred : modelOptions.value[0]?.value) ?? "";
});
function onModelChange(value: string): void {
  settings.selectedModelProviderId = value;
}

/* ── ACP ── */
async function onAcpConfigChange(configId: string, value: string): Promise<void> {
  acpConfigError.value = (await agentStore.setAcpConfig(configId, value)) ?? "";
}
async function onAcpConnect(): Promise<void> {
  acpConfigError.value = (await agentStore.connectAcp()) ?? "";
}
function tryConnectAcp(): void {
  if (selectedProvider.value?.kind !== "acp" || agentStore.acpConfigOptions.length) return;
  void onAcpConnect();
}
watch(acpPopOpen, (open) => {
  if (open) tryConnectAcp();
});
watch(
  () => agentStore.routeToAcp,
  (on) => {
    if (on) tryConnectAcp();
  },
);

/* ── 发送 ── */
function doSend(): void {
  const value = draft.value.trim();
  if (!value) return;
  if (agentStore.routeToAcp) {
    if (agentStore.acpBusy) return;
    agentStore.dispatchToAcp(value);
    draft.value = "";
    attachments.value = [];
    closeMenus();
    return;
  }
  if (chat.busy) return;
  if (settings.permissionTier === "cautious") {
    confirmOpen.value = true;
    return;
  }
  commit();
}
function onStop(): void {
  if (agentStore.acpBusy) {
    void agentStore.stopAcp();
    return;
  }
  chat.abortGeneration();
}
function commit(): void {
  if (chat.submitText(draft.value, attachments.value)) {
    draft.value = "";
    attachments.value = [];
  }
  closeMenus();
}
function confirmRun(): void {
  confirmOpen.value = false;
  commit();
}
function closeMenus(): void {
  mentionOpen.value = false;
  plusMenuOpen.value = false;
}

function onDraftInput(): void {
  mentionOpen.value = /@$/.test(draft.value);
  if (mentionOpen.value) plusMenuOpen.value = false;
}
function insertMention(name: string): void {
  draft.value = draft.value.replace(/@\S*$/, "") + "@" + name + " ";
  mentionOpen.value = false;
}
const mentionOptions = computed(() => pluginMarket.marketplace.map((m) => m.name).slice(0, 8));
function onChatAttach(file: File): void {
  attachments.value.push(file.name);
}
function removeAttachment(index: number): void {
  attachments.value.splice(index, 1);
}
/** 推理等级单源：读写当前选中模型供应商的 reasoningEffort（settings 持久化）。 */
const currentEffort = computed<ReasoningEffort>(() => {
  const provider = settings.modelProviders.find((provider) => provider.id === settings.selectedModelProviderId);
  return provider?.reasoningEffort ?? "auto";
});
function setEffort(e: ReasoningEffort): void {
  const provider = settings.modelProviders.find((provider) => provider.id === settings.selectedModelProviderId);
  if (provider) provider.reasoningEffort = e;
}
function setTier(tier: (typeof PERMISSION_TIERS)[number]["value"]): void {
  settings.permissionTier = tier;
}
function configLabel(option: AcpSessionConfigOption): string {
  const labels: Record<string, string> = {
    model: t("chat.configModel"),
    thought_level: t("chat.configThoughtLevel"),
    mode: t("chat.configMode"),
  };
  return (option.category && labels[option.category]) || option.name;
}
const shieldIcons = { cautious: Shield, daily: ShieldCheck, auto: ShieldOff } as const;

function fill(text: string): void {
  draft.value = text;
  inputEl.value?.focus();
}
function focus(): void {
  inputEl.value?.focus();
}
defineExpose({ fill, focus });
</script>

<template>
  <div class="composer">
    <div v-if="attachments.length || settings.planMode || chat.speedBoost" class="composer__chips">
      <span v-for="(a, i) in attachments" :key="a" class="chip"
        ><Paperclip class="size-3" /> {{ a }}<i class="chip__x" @click="removeAttachment(i)"><X class="size-3" /></i
      ></span>
      <span v-if="settings.planMode" class="chip chip--on">{{ t("chat.planMode") }}</span>
      <span v-if="chat.speedBoost" class="chip chip--on">{{ t("chat.speedBoost") }}</span>
    </div>
    <div class="composer__box">
      <button
        class="composer__plus"
        :class="{ active: plusMenuOpen }"
        :title="t('chat.plusTitle')"
        @click.stop="
          plusMenuOpen = !plusMenuOpen;
          mentionOpen = false;
        "
      >
        <Plus class="size-4" />
      </button>
      <textarea
        ref="inputEl"
        v-model="draft"
        rows="1"
        :placeholder="t('chat.placeholder.input')"
        :aria-label="t('chat.inputAria')"
        @keydown.enter.exact.prevent="doSend"
        @keydown.meta.enter.prevent="doSend"
        @keydown.ctrl.enter.prevent="doSend"
        @keydown.esc="
          plusMenuOpen = false;
          mentionOpen = false;
        "
        @input="onDraftInput"
      ></textarea>
      <button
        v-if="chat.busy || agentStore.acpBusy"
        class="composer__send composer__send--stop"
        :title="t('chat.stop')"
        :aria-label="t('chat.stop')"
        @click="onStop"
      >
        <Square class="size-3.5" />
      </button>
      <button
        class="composer__send"
        :disabled="!draft.trim() || chat.busy || agentStore.acpBusy"
        :title="t('chat.send')"
        :aria-label="t('chat.send')"
        @click="doSend"
      >
        <Send class="size-4" />
      </button>
      <div v-if="plusMenuOpen" class="pop pop--plus" @click.stop>
        <FilePick accept="*" :label="t('chat.uploadFile')" class="w-full" @select="onChatAttach" />
        <div class="pop__row">
          <div>
            <strong>{{ t("chat.currentGoal") }}</strong
            ><em>{{ activeThreadProjectName ?? t("chat.plainChat") }}</em>
          </div>
        </div>
      </div>
      <div v-if="mentionOpen" class="pop pop--mention">
        <p class="pop__cap">{{ t("chat.referencePlugin") }}</p>
        <button v-for="opt in mentionOptions" :key="opt" class="pop__opt" @click="insertMention(opt)">@ {{ opt }}</button>
      </div>
    </div>
    <div class="composer__bar">
      <Select
        v-if="!agentStore.routeToAcp"
        :model-value="selectedModel"
        :options="modelOptions"
        :placeholder="t('chat.noModel')"
        trigger-class="composer__model-trigger h-7 text-xs"
        @update:model-value="onModelChange"
      />
      <div class="acp-wrap">
        <button
          class="composer__pill"
          :class="{ active: agentStore.routeToAcp }"
          :title="t('chat.acpDispatchTitle')"
          @click.stop="
            acpPopOpen = !acpPopOpen;
            plusMenuOpen = false;
          "
        >
          <span class="perm__dot"></span>
          ACP · {{ selectedProvider?.name ?? t("chat.notSelected") }}
          <template v-if="agentStore.routeToAcp">{{ agentStore.acpBusy ? t("chat.acpBusy") : t("chat.acpReady") }}</template>
          <span class="composer__caret">▾</span>
        </button>
        <div v-if="acpPopOpen" class="pop acp-pop" @click.stop>
          <p class="pop__cap">{{ t("chat.dispatchTarget") }}</p>
          <button
            v-for="provider in agentStore.agentProviders"
            :key="provider.id"
            class="pop__opt pop__opt--col"
            :class="{ active: agentStore.selectedProviderId === provider.id }"
            :data-provider="provider.id"
            @click="agentStore.selectProvider(provider.id)"
          >
            <strong>{{ provider.name }}</strong>
            <em>{{ provider.command }}</em>
          </button>
          <div v-if="selectedProvider?.kind === 'acp'" class="pop__row">
            <div>
              <strong>{{
                agentStore.acpConnecting ? t("chat.connectingBackend") : acpConfigError ? t("chat.connectFailed") : t("chat.notConnected")
              }}</strong>
              <em>{{ acpConfigError || t("chat.connectHint") }}</em>
            </div>
            <Button size="sm" variant="outline" :disabled="agentStore.acpConnecting" @click="onAcpConnect">
              {{ agentStore.acpConnecting ? t("chat.connecting") : t("chat.loadConfig") }}
            </Button>
          </div>
          <div class="pop__row">
            <div>
              <strong>{{ t("chat.dispatchSwitch") }}</strong
              ><em>{{ t("chat.dispatchSwitchHint") }}</em>
            </div>
            <Switch :model-value="agentStore.routeToAcp" @update:model-value="agentStore.toggleRouteToAcp()" />
          </div>
          <p class="footnote">{{ t("chat.outputLive") }}{{ agentStore.acpAvailable ? "" : t("chat.acpWebEnv") }}</p>
        </div>
      </div>
      <div
        v-if="agentStore.routeToAcp && selectedProvider?.kind === 'acp' && acpSelectOptions.length"
        class="acp-config"
        :title="acpConfigError || undefined"
      >
        <label v-for="option in acpSelectOptions" :key="option.id" class="acp-config__item">
          <span class="acp-config__label">{{ configLabel(option) }}</span>
          <Select
            :model-value="String(option.currentValue ?? '')"
            :options="(option.options ?? []).map((c) => ({ label: c.name ?? String(c.value), value: String(c.value) }))"
            trigger-class="h-7 text-xs"
            @update:model-value="(v) => onAcpConfigChange(option.id, v)"
          />
        </label>
      </div>
      <span class="composer__sep"></span>
      <button
        class="composer__pill composer__pill--adv"
        :class="{ active: advancedOpen }"
        :title="t('chat.advanced')"
        :aria-label="t('chat.advancedAria')"
        @click.stop="advancedOpen = !advancedOpen"
      >
        <SlidersHorizontal class="size-3.5" />
        <span class="composer__caret">▾</span>
      </button>
      <span class="composer__hint">{{ chat.busy ? t("chat.busy") : t("chat.placeholder.hint") }}</span>
    </div>
    <div v-if="advancedOpen" class="composer__adv">
      <div class="shield-seg" role="group" :aria-label="t('chat.shield')">
        <button
          v-for="tier in PERMISSION_TIERS"
          :key="tier.value"
          class="shield-seg__btn"
          :data-tier="tier.value"
          :class="{ active: settings.permissionTier === tier.value }"
          :title="t(tier.desc)"
          @click="setTier(tier.value)"
        >
          <component :is="shieldIcons[tier.value]" class="size-3.5 shield-icon" />
          {{ t(tier.label) }}
        </button>
      </div>
      <div v-if="!agentStore.routeToAcp" class="seg">
        <button
          v-for="e in REASONING_EFFORTS"
          :key="e.value"
          class="seg__btn"
          :class="{ active: currentEffort === e.value }"
          :title="t(e.description)"
          @click="setEffort(e.value)"
        >
          {{ t(e.label) }}
        </button>
      </div>
      <button
        class="composer__pill composer__pill--speed"
        :class="{ active: chat.speedBoost }"
        :title="t('chat.speedTitle')"
        @click="chat.speedBoost = !chat.speedBoost"
      >
        {{ t("chat.speedBoost") }}
      </button>
      <button
        class="plan-switch"
        :class="{ active: settings.planMode }"
        :title="t('chat.planModeTitle')"
        @click="settings.planMode = !settings.planMode"
      >
        {{ t("chat.plan") }}
      </button>
    </div>
    <Dialog :open="confirmOpen" @update:open="confirmOpen = $event">
      <p class="text-sm font-semibold">{{ t("chat.cautiousConfirm") }}</p>
      <p class="detail-desc mt-2">{{ t("chat.cautiousDesc") }}</p>
      <p class="detail-desc">
        <strong>{{ t("chat.intent") }}</strong
        >{{ draft }}
      </p>
      <div class="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" @click="confirmOpen = false">{{ t("common.cancel") }}</Button>
        <Button size="sm" @click="confirmRun">{{ t("chat.confirmRun") }}</Button>
      </div>
    </Dialog>
  </div>
</template>
