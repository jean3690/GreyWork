<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { CHAT_EFFORTS, useChatStore, type ChatEffort } from "../../stores/chat";
import { PERMISSION_TIERS, useSettingsStore } from "../../stores/settings";
import { useProjectStore } from "../../stores/project";
import { getPluginMarket } from "../../state/pluginMarket";
import { Paperclip, Plus, Send, Shield, ShieldCheck, ShieldOff, Square, X } from "lucide-vue-next";
import { Button, Dialog, FilePick, Select, type SelectOption, Switch } from "../ui";
import type { AcpSessionConfigOption } from "@greywork/acp";
import { useAgentStore } from "../../stores/agent";

const chat = useChatStore();
const settings = useSettingsStore();
const agentStore = useAgentStore();
const projectStore = useProjectStore();
const pluginMarket = getPluginMarket();

const draft = defineModel<string>("draft", { default: "" });
const attachments = defineModel<string[]>("attachments", { default: () => [] });

const inputEl = ref<HTMLTextAreaElement | null>(null);
const plusMenuOpen = ref(false);
const mentionOpen = ref(false);
const confirmOpen = ref(false);
const acpPopOpen = ref(false);
const acpConfigError = ref("");

const selectedProvider = computed(() =>
  agentStore.agentProviders.find((p) => p.id === agentStore.selectedProviderId),
);

const acpSelectOptions = computed(() =>
  agentStore.acpConfigOptions.filter((o) => o.type === "select" && o.options?.length),
);

const activeThreadProjectName = computed(() => {
  for (const g of projectStore.threadGroups) {
    if (g.threads.some((t) => t.id === chat.activeThreadId)) return g.project ?? null;
  }
  return null;
});

/* ── 模型选择（自 TopBar 迁入） ── */
const modelOptions = computed<SelectOption[]>(() =>
  settings.modelProviders
    .filter((p) => p.id !== "custom" && p.enabled && p.model.trim())
    .map((p) => ({ label: `${p.name} · ${p.model}`, value: p.id })),
);
const selectedModel = computed(() => {
  const preferred = settings.selectedModelProviderId;
  return (preferred && modelOptions.value.some((o) => o.value === preferred)
    ? preferred
    : modelOptions.value[0]?.value) ?? "";
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
watch(acpPopOpen, (open) => { if (open) tryConnectAcp(); });
watch(() => agentStore.routeToAcp, (on) => { if (on) tryConnectAcp(); });

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
  if (agentStore.acpBusy) { void agentStore.stopAcp(); return; }
  chat.abortGeneration();
}
function commit(): void {
  if (chat.submitText(draft.value, attachments.value)) {
    draft.value = "";
    attachments.value = [];
  }
  closeMenus();
}
function confirmRun(): void { confirmOpen.value = false; commit(); }
function closeMenus(): void { mentionOpen.value = false; plusMenuOpen.value = false; }

function onDraftInput(): void {
  mentionOpen.value = /@$/.test(draft.value);
  if (mentionOpen.value) plusMenuOpen.value = false;
}
function insertMention(name: string): void {
  draft.value = draft.value.replace(/@\S*$/, "") + "@" + name + " ";
  mentionOpen.value = false;
}
const mentionOptions = computed(() => pluginMarket.marketplace.map((m) => m.name).slice(0, 8));
function onChatAttach(file: File): void { attachments.value.push(file.name); }
function removeAttachment(index: number): void { attachments.value.splice(index, 1); }
function setEffort(e: ChatEffort): void { chat.chatEffort = e; }
function setTier(tier: (typeof PERMISSION_TIERS)[number]["value"]): void { settings.permissionTier = tier; }
function configLabel(option: AcpSessionConfigOption): string {
  const labels: Record<string, string> = { model: "模型", thought_level: "思考强度", mode: "会话模式" };
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
      <span v-if="settings.planMode" class="chip chip--on">计划模式</span>
      <span v-if="chat.speedBoost" class="chip chip--on">速度 ×1.5</span>
    </div>
    <div class="composer__box">
      <button
        class="composer__plus"
        :class="{ active: plusMenuOpen }"
        title="附件 / 计划模式 / 目标"
        @click.stop="plusMenuOpen = !plusMenuOpen; mentionOpen = false;"
      >
        <Plus class="size-4" />
      </button>
      <textarea
        ref="inputEl"
        v-model="draft"
        rows="1"
        placeholder="给 GreyWork 下达任务，输入 @ 引用插件 / 技能…"
        aria-label="消息输入"
        @keydown.enter.exact.prevent="doSend"
        @keydown.meta.enter.prevent="doSend"
        @keydown.ctrl.enter.prevent="doSend"
        @keydown.esc="plusMenuOpen = false; mentionOpen = false;"
        @input="onDraftInput"
      ></textarea>
      <button
        v-if="chat.busy || agentStore.acpBusy"
        class="composer__send composer__send--stop"
        title="停止生成"
        aria-label="停止生成"
        @click="onStop"
      >
        <Square class="size-3.5" />
      </button>
      <button
        class="composer__send"
        :disabled="!draft.trim() || chat.busy || agentStore.acpBusy"
        title="发送"
        aria-label="发送"
        @click="doSend"
      >
        <Send class="size-4" />
      </button>
      <div v-if="plusMenuOpen" class="pop pop--plus" @click.stop>
        <FilePick accept="*" label="上传文件 / 图片" class="w-full" @select="onChatAttach" />
        <div class="pop__row">
          <div>
            <strong>当前目标</strong><em>{{ activeThreadProjectName ?? "普通对话（未绑定项目）" }}</em>
          </div>
        </div>
      </div>
      <div v-if="mentionOpen" class="pop pop--mention">
        <p class="pop__cap">引用插件 / 技能</p>
        <button v-for="opt in mentionOptions" :key="opt" class="pop__opt" @click="insertMention(opt)">@ {{ opt }}</button>
      </div>
    </div>
    <div class="composer__bar">
      <Select
        :model-value="selectedModel"
        :options="modelOptions"
        placeholder="未配置模型"
        trigger-class="composer__model-trigger h-7 text-xs"
        @update:model-value="onModelChange"
      />
      <div class="shield-seg" role="group" aria-label="权限档位">
        <button
          v-for="tier in PERMISSION_TIERS"
          :key="tier.value"
          class="shield-seg__btn"
          :data-tier="tier.value"
          :class="{ active: settings.permissionTier === tier.value }"
          :title="tier.desc"
          @click="setTier(tier.value)"
        >
          <component :is="shieldIcons[tier.value]" class="size-3.5 shield-icon" />
          {{ tier.label }}
        </button>
      </div>
      <div class="acp-wrap">
        <button
          class="composer__pill"
          :class="{ active: agentStore.routeToAcp }"
          title="ACP 派发目标与开关"
          @click.stop="acpPopOpen = !acpPopOpen; plusMenuOpen = false;"
        >
          <span class="perm__dot"></span>
          ACP · {{ selectedProvider?.name ?? "未选" }}
          <template v-if="agentStore.routeToAcp">{{ agentStore.acpBusy ? " · 执行中" : " · 就绪" }}</template>
          <span class="composer__caret">▾</span>
        </button>
        <div v-if="acpPopOpen" class="pop acp-pop" @click.stop>
          <p class="pop__cap">派发目标 · ACP 后端</p>
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
              <strong>{{ agentStore.acpConnecting ? "正在连接后端…" : acpConfigError ? "连接失败" : "未连接" }}</strong>
              <em>{{ acpConfigError || "连接后即可在 ACP 按钮旁切换模型 / 思考强度 / 会话模式" }}</em>
            </div>
            <Button size="sm" variant="outline" :disabled="agentStore.acpConnecting" @click="onAcpConnect">
              {{ agentStore.acpConnecting ? "连接中" : "加载配置" }}
            </Button>
          </div>
          <div class="pop__row">
            <div><strong>派发开关</strong><em>开 = 意图发往 ACP；关 = 内部 mock 管线</em></div>
            <Switch :model-value="agentStore.routeToAcp" @update:model-value="agentStore.toggleRouteToAcp()" />
          </div>
          <p class="footnote">输出实时进入对话流；{{ agentStore.acpAvailable ? "" : "当前为 Web 环境：本地 ACP 需桌面端。" }}</p>
        </div>
      </div>
      <div
        v-if="selectedProvider?.kind === 'acp' && acpSelectOptions.length"
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
      <div class="seg">
        <button
          v-for="e in CHAT_EFFORTS"
          :key="e.value"
          class="seg__btn"
          :class="{ active: chat.chatEffort === e.value }"
          :title="e.desc"
          @click="setEffort(e.value)"
        >
          {{ e.label }}
        </button>
      </div>
      <button
        class="composer__pill composer__pill--speed"
        :class="{ active: chat.speedBoost }"
        title="不降智前提下提速约 1.5 倍"
        @click="chat.speedBoost = !chat.speedBoost"
      >
        速度 ×1.5
      </button>
      <button
        class="plan-switch"
        :class="{ active: settings.planMode }"
        title="计划模式：先拆解任务给出方案，确认后再执行"
        @click="settings.planMode = !settings.planMode"
      >
        计划
      </button>
      <span class="composer__hint">{{ chat.busy ? "任务执行中…" : "Enter 发送 · Shift+Enter 换行" }}</span>
    </div>
    <Dialog :open="confirmOpen" @update:open="confirmOpen = $event">
      <p class="text-sm font-semibold">谨慎模式确认</p>
      <p class="detail-desc mt-2">当前权限档位为「最谨慎」：执行前需逐条确认。</p>
      <p class="detail-desc"><strong>意图：</strong>{{ draft }}</p>
      <div class="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" @click="confirmOpen = false">取消</Button>
        <Button size="sm" @click="confirmRun">确认执行</Button>
      </div>
    </Dialog>
  </div>
</template>
