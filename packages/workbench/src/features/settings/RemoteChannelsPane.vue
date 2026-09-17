<script setup lang="ts">
import { computed, reactive } from "vue";
import { useI18n } from "vue-i18n";
import { appEvents } from "@/events";
import { useAgentStore } from "@/stores/agent";
import { useRemoteAssistantStore, type RemoteChannel } from "@/stores/remote-assistant";
import { useSettingsStore, type ChannelId, type RemoteReplyMode } from "@/stores/settings";
import Icon from "@/features/shared/Icon.vue";
import ChannelActions from "@/features/channels/ChannelActions.vue";
import FeishuRegisterPanel from "@/features/channels/FeishuRegisterPanel.vue";
import WechatQrPanel from "@/features/channels/WechatQrPanel.vue";

/**
 * 设置 · 远程助手：三条通道 + 共用回复设置。
 *
 * 这里是通道配置的唯一入口（远程助手页只给一个「去设置配置」的跳转）：
 * - 微信：腾讯官方 ClawBot / iLink，扫码登录 + 长轮询；
 * - 钉钉：开放平台企业内部机器人，Stream 长连接（Client ID / Client Secret）；
 * - 飞书：自建应用 + 长连接（App ID / App Secret）。
 *
 * 凭证一律不进设置快照：微信的 bot token、钉钉的 AppSecret 与 sessionWebhook、飞书的
 * AppSecret 与 tenant token 都只落宿主数据目录（0600）。
 */
const { t } = useI18n();
const store = useRemoteAssistantStore();
const settings = useSettingsStore();
const agent = useAgentStore();

/** 需要「凭证表单」的两条通道（微信走扫码，不在此列）。 */
const CREDENTIAL_CHANNELS: {
  channel: Exclude<RemoteChannel, "wechat">;
  idLabel: string;
  secretLabel: string;
  idPlaceholder: string;
  /** 凭据小标题的文案键：飞书多一条扫码路径，那里要说「或手动填」 */
  credentialsKey: string;
}[] = [
  {
    channel: "dingtalk",
    idLabel: "Client ID",
    secretLabel: "Client Secret",
    idPlaceholder: "dingxxxxxxxxxxxx",
    credentialsKey: "credentials",
  },
  {
    channel: "feishu",
    idLabel: "App ID",
    secretLabel: "App Secret",
    idPlaceholder: "cli_xxxxxxxxxxxx",
    credentialsKey: "credentialsManual",
  },
];

const drafts = reactive<Record<string, { id: string; secret: string; error: string | null; saved: boolean }>>({
  dingtalk: { id: "", secret: "", error: null, saved: false },
  feishu: { id: "", secret: "", error: null, saved: false },
});

async function saveCredentials(channel: Exclude<RemoteChannel, "wechat">): Promise<void> {
  const draft = drafts[channel];
  draft.error = null;
  draft.saved = false;
  const failure =
    channel === "dingtalk"
      ? await store.saveDingTalkCredentials(draft.id, draft.secret)
      : await store.saveFeishuCredentials(draft.id, draft.secret);
  if (failure) {
    draft.error = failure;
    return;
  }
  // 密钥落宿主后即清空输入框：界面上不再留明文。
  draft.id = "";
  draft.secret = "";
  draft.saved = true;
  // 存完自动连一次：用户的期待就是「填完就能用」。
  if (channel === "dingtalk") await store.connectDingTalk();
  else await store.connectFeishu();
}

/** 某条通道的凭证是否已保存（用于占位提示「留空表示沿用」）。 */
function credentialsStored(channel: Exclude<RemoteChannel, "wechat">): boolean {
  return channel === "dingtalk" ? store.dingtalkStatus.configured : store.feishuStatus.configured;
}

/* ===== 共用回复设置 ===== */
/** 回复后端两个档位（顺序即界面顺序）。 */
const REPLY_MODES: RemoteReplyMode[] = ["llm", "acp"];
/** ACP 档位可选的后端：只列启用项（停用的后端不该出现在「用哪个」里）。 */
const enabledAgentProviders = computed(() => agent.agentProviders.filter((provider) => provider.enabled));

/** 某条通道的三个开关（顺序即界面顺序；testid 用 kebab-case 便于外部引用）。 */
const SWITCHES = [
  { key: "autoConnect", testId: "auto-connect" },
  { key: "autoReply", testId: "auto-reply" },
  { key: "allowOtherSenders", testId: "allow-others" },
] as const;

type SwitchKey = (typeof SWITCHES)[number]["key"];

function onToggle(channel: ChannelId, key: SwitchKey, checked: boolean): void {
  settings.setChannelPrefs(channel, { [key]: checked });
  // 发送者策略是宿主侧规则：连接建立时一次性下发，改了要重连才生效。
  if (key === "allowOtherSenders") void store.applySenderPolicy(channel);
}

/** 跳到「设置 → Agent」管理 ACP 后端（本面板只管用哪个，不管增删）。 */
function openAgentSettings(): void {
  appEvents.emit("settings:open", { section: "agent" });
}

/** 开关行与凭证表单的共用文案类。 */
const rowClass = "flex cursor-pointer items-center justify-between gap-3";
const hintClass = "text-[11px] text-dim2";
const inputClass =
  "min-w-0 flex-1 rounded-[8px] border border-line bg-panel-2 px-2 py-1.5 font-mono text-[12px] text-foreground outline-none focus:border-line-2";
</script>

<template>
  <div class="flex flex-col gap-4" data-testid="remote-channels-pane">
    <!-- 微信：扫码登录 + 三个开关 -->
    <div class="rounded-[14px] border border-line bg-panel p-4">
      <div class="mb-3 flex items-center gap-2">
        <span class="grid size-6 place-items-center rounded-[6px] border border-line bg-panel-2 text-dim">
          <Icon name="message" :size="13" />
        </span>
        <span class="text-[13px] font-medium text-foreground">{{ t("remoteAssist.channels.wechat") }}</span>
      </div>

      <ChannelActions channel="wechat" />
      <p class="mt-2 text-[10.5px] leading-relaxed text-dim2">{{ t("remoteAssist.wechat.requirement") }}</p>

      <div v-if="store.qr || store.qrError" class="mt-3">
        <WechatQrPanel />
      </div>

      <div class="mt-3 flex flex-col gap-2.5 border-t border-line pt-3">
        <label v-for="item in SWITCHES" :key="item.key" :class="rowClass">
          <span>
            <span class="block text-[12.5px] text-foreground">{{ t(`remoteAssist.settings.${item.key}`) }}</span>
            <span :class="hintClass">{{ t(`remoteAssist.settings.${item.key}Hint`) }}</span>
          </span>
          <input
            type="checkbox"
            class="size-4 cursor-pointer accent-[var(--accent)]"
            :checked="settings.remoteAssist.channels.wechat[item.key]"
            :aria-label="t(`remoteAssist.settings.${item.key}`)"
            :data-testid="`wechat-${item.testId}`"
            @change="onToggle('wechat', item.key, ($event.target as HTMLInputElement).checked)"
          />
        </label>
      </div>
    </div>

    <!-- 钉钉 / 飞书：应用凭证 + 三个开关（结构相同，用一张表驱动） -->
    <div
      v-for="entry in CREDENTIAL_CHANNELS"
      :key="entry.channel"
      class="rounded-[14px] border border-line bg-panel p-4"
      :data-testid="`channel-${entry.channel}`"
    >
      <div class="mb-3 flex items-center gap-2">
        <span class="grid size-6 place-items-center rounded-[6px] border border-line bg-panel-2 text-dim">
          <Icon name="message" :size="13" />
        </span>
        <span class="text-[13px] font-medium text-foreground">{{ t(`remoteAssist.channels.${entry.channel}`) }}</span>
      </div>

      <ChannelActions :channel="entry.channel" />
      <p class="mt-2 text-[10.5px] leading-relaxed text-dim2">{{ t(`remoteAssist.${entry.channel}.requirement`) }}</p>

      <!-- 飞书：扫码创建是首选入口（省掉去控制台建应用抄密钥） -->
      <FeishuRegisterPanel v-if="entry.channel === 'feishu'" class="mt-3" />

      <div class="mt-3 flex flex-col gap-2.5 border-t border-line pt-3">
        <span class="text-[12.5px] text-foreground" :data-testid="`${entry.channel}-credentials-label`">
          {{ t(`remoteAssist.${entry.channel}.${entry.credentialsKey}`) }}
        </span>
        <label class="flex items-center gap-2">
          <span class="w-24 shrink-0 text-[11.5px] text-dim2">{{ entry.idLabel }}</span>
          <input
            v-model="drafts[entry.channel].id"
            :class="inputClass"
            :placeholder="entry.idPlaceholder"
            :data-testid="`${entry.channel}-client-id`"
          />
        </label>
        <label class="flex items-center gap-2">
          <span class="w-24 shrink-0 text-[11.5px] text-dim2">{{ entry.secretLabel }}</span>
          <input
            v-model="drafts[entry.channel].secret"
            type="password"
            :class="inputClass"
            :placeholder="credentialsStored(entry.channel) ? t(`remoteAssist.${entry.channel}.secretKeep`) : '******'"
            :data-testid="`${entry.channel}-client-secret`"
          />
        </label>
        <p class="text-[10.5px] leading-relaxed text-dim2">{{ t(`remoteAssist.${entry.channel}.secretHint`) }}</p>
        <p v-if="drafts[entry.channel].error" class="text-[11px] text-destructive" :data-testid="`${entry.channel}-save-error`">
          {{ drafts[entry.channel].error }}
        </p>
        <p v-else-if="drafts[entry.channel].saved" class="text-[11px] text-mint" :data-testid="`${entry.channel}-saved`">
          {{ t(`remoteAssist.${entry.channel}.saved`) }}
        </p>
        <button
          type="button"
          class="h-7 w-fit cursor-pointer rounded-[7px] bg-accent px-3 text-[11.5px] font-medium text-accent-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="!drafts[entry.channel].id.trim()"
          :data-testid="`${entry.channel}-save`"
          @click="void saveCredentials(entry.channel)"
        >
          {{ t(`remoteAssist.${entry.channel}.save`) }}
        </button>
      </div>

      <div class="mt-3 flex flex-col gap-2.5 border-t border-line pt-3">
        <label v-for="item in SWITCHES" :key="item.key" :class="rowClass">
          <span>
            <span class="block text-[12.5px] text-foreground">{{ t(`remoteAssist.settings.${item.key}`) }}</span>
            <span :class="hintClass">{{ t(`remoteAssist.settings.${item.key}Hint`) }}</span>
          </span>
          <input
            type="checkbox"
            class="size-4 cursor-pointer accent-[var(--accent)]"
            :checked="settings.remoteAssist.channels[entry.channel][item.key]"
            :aria-label="t(`remoteAssist.settings.${item.key}`)"
            :data-testid="`${entry.channel}-${item.testId}`"
            @change="onToggle(entry.channel, item.key, ($event.target as HTMLInputElement).checked)"
          />
        </label>
      </div>
    </div>

    <!-- 回复后端：三条通道共用 -->
    <div class="rounded-[14px] border border-line bg-panel p-4">
      <div class="mb-3">
        <span class="block text-[12.5px] text-foreground">{{ t("remoteAssist.settings.reply") }}</span>
        <span :class="hintClass">{{ t("remoteAssist.settings.replyHint") }}</span>
      </div>
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
          :data-testid="`wechat-reply-mode-${mode}`"
          @click="settings.setRemoteAssist({ replyMode: mode })"
        >
          {{ mode === "llm" ? t("remoteAssist.settings.replyLlm") : t("remoteAssist.settings.replyAcp") }}
        </button>
      </div>

      <template v-if="settings.remoteAssist.replyMode === 'acp'">
        <label class="mt-2 flex items-center gap-2">
          <span class="w-24 shrink-0 text-[11.5px] text-dim2">{{ t("remoteAssist.settings.replyProvider") }}</span>
          <select
            class="min-w-0 flex-1 cursor-pointer rounded-[8px] border border-line bg-panel-2 px-2 py-1.5 text-[12.5px] text-foreground outline-none focus:border-line-2"
            data-testid="wechat-reply-provider"
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
          class="mt-1 text-[10.5px] leading-relaxed text-destructive"
          data-testid="wechat-reply-provider-empty"
        >
          {{ t("remoteAssist.settings.replyProviderEmpty") }}
        </p>
        <p class="mt-1 text-[10.5px] leading-relaxed text-dim2">{{ t("remoteAssist.settings.replyProviderShared") }}</p>
        <button
          type="button"
          class="mt-2 h-7 w-fit cursor-pointer rounded-[7px] border border-line bg-panel-2 px-2.5 text-[11.5px] text-dim transition-colors hover:border-line-2 hover:text-foreground"
          data-testid="wechat-open-agent-settings"
          @click="openAgentSettings"
        >
          {{ t("remoteAssist.settings.openAgentSettings") }}
        </button>
      </template>
    </div>

    <p class="text-[10.5px] leading-relaxed text-dim2">{{ t("remoteAssist.settings.security") }}</p>
  </div>
</template>
