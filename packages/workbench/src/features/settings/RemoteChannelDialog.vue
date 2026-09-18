<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { copyText } from "@/lib/clipboard";
import { useRemoteAssistantStore, type RemoteChannel } from "@/stores/remote-assistant";
import { useSettingsStore, type ChannelId } from "@/stores/settings";
import Icon from "@/features/shared/Icon.vue";
import ChannelActions from "@/features/channels/ChannelActions.vue";
import FeishuRegisterPanel from "@/features/channels/FeishuRegisterPanel.vue";
import DingTalkRegisterPanel from "@/features/channels/DingTalkRegisterPanel.vue";
import TelegramQrPanel from "@/features/channels/TelegramQrPanel.vue";
import WechatQrPanel from "@/features/channels/WechatQrPanel.vue";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

/**
 * 单条消息通道的配置弹窗（由远程助手集成清单点开）。
 *
 * 四条通道共用一套骨架：状态动作（连接 / 断开 / 退出）+ 凭证区（各自的形状）+
 * 三个行为开关。凭证保存后自动连一次——用户的期待就是「填完就能用」。
 * 密钥落宿主后即清空输入框：界面上不再留明文。
 */
const props = defineProps<{ open: boolean; channel: RemoteChannel }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const store = useRemoteAssistantStore();
const settings = useSettingsStore();

/**
 * 「应用凭证表单」的四条通道（微信走扫码、Telegram 走 token，都不在此列）。
 * 结构一致：一个非秘密的标识 + 一个密钥。
 */
const CREDENTIAL_CHANNELS = {
  dingtalk: {
    idLabel: "Client ID",
    secretLabel: "Client Secret",
    idPlaceholder: "dingxxxxxxxxxxxx",
    /** 凭据小标题的文案键：飞书多一条扫码路径，那里要说「或手动填」。 */
    credentialsKey: "credentials",
  },
  feishu: {
    idLabel: "App ID",
    secretLabel: "App Secret",
    idPlaceholder: "cli_xxxxxxxxxxxx",
    credentialsKey: "credentialsManual",
  },
  qq: {
    idLabel: "AppID",
    secretLabel: "AppSecret",
    idPlaceholder: "102xxxxxx",
    credentialsKey: "credentials",
  },
  wecom: {
    idLabel: "BotID",
    secretLabel: "Secret",
    idPlaceholder: "bot_xxxxxxxxxxxx",
    credentialsKey: "credentials",
  },
} as const;

/** 凭证类型：走「标识 + 密钥」表单的通道。 */
type CredentialChannel = keyof typeof CREDENTIAL_CHANNELS;

/** 当前通道的凭证字段定义（非凭证通道由调用处的 v-if 排除）。 */
const credentialFields = computed(() => CREDENTIAL_CHANNELS[props.channel as CredentialChannel]);

/** 只填一枚机密字符串的通道（Telegram / Discord）：字段名与提示各不相同，所以走表。 */
const TOKEN_CHANNELS = {
  telegram: {
    labelKey: "remoteAssist.telegram.token",
    keepKey: "remoteAssist.telegram.tokenKeep",
    hintKey: "remoteAssist.telegram.tokenHint",
    placeholder: "123456789:AAF-xxxxxxxxxxxxxxxx",
    testId: "telegram-token",
  },
  discord: {
    labelKey: "remoteAssist.discord.token",
    keepKey: "remoteAssist.discord.tokenKeep",
    hintKey: "remoteAssist.discord.tokenHint",
    placeholder: "MTA1NDU2Nzg5.GxYzAb.abcdefghijklmnopqrstuvwxyz0",
    testId: "discord-token",
  },
} as const;

/** 当前通道的 token 字段定义（凭证表单通道为 undefined）。 */
const tokenFields = computed(() => TOKEN_CHANNELS[props.channel as keyof typeof TOKEN_CHANNELS]);

const drafts = reactive<Record<string, { id: string; secret: string; error: string | null; saved: boolean }>>({
  dingtalk: { id: "", secret: "", error: null, saved: false },
  feishu: { id: "", secret: "", error: null, saved: false },
  telegram: { id: "", secret: "", error: null, saved: false },
  discord: { id: "", secret: "", error: null, saved: false },
  qq: { id: "", secret: "", error: null, saved: false },
  wecom: { id: "", secret: "", error: null, saved: false },
});

/** 某条通道的凭证是否已保存（用于占位提示「留空表示沿用」）。 */
function credentialsStored(channel: RemoteChannel): boolean {
  if (channel === "dingtalk") return store.dingtalkStatus.configured;
  if (channel === "feishu") return store.feishuStatus.configured;
  if (channel === "telegram") return store.telegramStatus.configured;
  if (channel === "qq") return store.qqStatus.configured;
  if (channel === "discord") return store.discordStatus.configured;
  return store.wecomStatus.configured;
}

async function saveCredentials(channel: RemoteChannel): Promise<void> {
  const draft = drafts[channel];
  if (!draft) return;
  draft.error = null;
  draft.saved = false;
  const failure =
    channel === "dingtalk"
      ? await store.saveDingTalkCredentials(draft.id, draft.secret)
      : channel === "feishu"
        ? await store.saveFeishuCredentials(draft.id, draft.secret)
        : channel === "telegram"
          ? await store.saveTelegramCredentials(draft.id)
          : channel === "discord"
            ? await store.saveDiscordCredentials(draft.id)
            : channel === "qq"
              ? await store.saveQqCredentials(draft.id, draft.secret)
              : await store.saveWecomCredentials(draft.id, draft.secret);
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
  else if (channel === "feishu") await store.connectFeishu();
  else if (channel === "telegram") await store.connectTelegram();
  else if (channel === "discord") await store.connectDiscord();
  else if (channel === "qq") await store.connectQq();
  else await store.connectWecom();
}

/* ===== 三个行为开关 ===== */
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

/** Discord 开发者门户：bot token 只能到那里拿（同样没有扫码取凭证）。 */
const DISCORD_PORTAL_URL = "https://discord.com/developers/applications";

/** 钉钉开放平台控制台：AppKey / AppSecret 只能到那里复制（平台不提供扫码取凭证）。 */
const DINGTALK_CONSOLE_URL = "https://open-dev.dingtalk.com/";
const copiedConsole = ref(false);

async function copyConsoleUrl(): Promise<void> {
  await copyText(DINGTALK_CONSOLE_URL).catch(() => undefined);
  copiedConsole.value = true;
}

/** Discord 开发者门户：bot token 只能到那里拿，同样没有「扫码取凭证」这回事。 */
const copiedPortal = ref(false);

async function copyPortalUrl(): Promise<void> {
  await copyText(DISCORD_PORTAL_URL).catch(() => undefined);
  copiedPortal.value = true;
}

/** Dialog 收下 Esc / 点遮罩后关闭；open 归 false 即通知父级收起（受控：prop 是真源）。 */
function onOpenChange(next: boolean): void {
  if (!next) emit("close");
}

const inputClass =
  "min-w-0 flex-1 rounded-[8px] border border-line bg-panel-2 px-2 py-1.5 font-mono text-[12px] text-foreground outline-none focus:border-line-2";
</script>

<template>
  <Dialog :open="props.open" @update:open="onOpenChange">
    <DialogContent
      :show-close-button="false"
      class="flex max-h-[88vh] flex-col gap-0 overflow-hidden rounded-[14px] border-line bg-panel p-0 shadow-xl sm:max-w-[520px]"
      :data-testid="`channel-dialog-${props.channel}`"
    >
      <div class="flex items-center justify-between px-4 pb-2 pt-3.5">
        <div class="flex min-w-0 items-center gap-2.5">
          <span class="grid size-7 shrink-0 place-items-center rounded-[8px] border border-line bg-panel-2 text-dim">
            <Icon name="message" :size="14" />
          </span>
          <div class="min-w-0">
            <DialogTitle class="text-[13px] font-medium text-foreground">
              {{ t(`remoteAssist.channels.${props.channel}`) }}
            </DialogTitle>
            <DialogDescription class="mt-0.5 line-clamp-2 text-[10.5px] leading-relaxed text-dim2">
              {{ t(`remoteAssist.rows.${props.channel}Desc`) }}
            </DialogDescription>
          </div>
        </div>
        <button
          type="button"
          class="grid size-6 shrink-0 cursor-pointer place-items-center rounded-[6px] text-dim transition-colors hover:bg-panel-2 hover:text-foreground"
          aria-label="关闭"
          data-testid="channel-dialog-close"
          @click="emit('close')"
        >
          <Icon name="close" :size="13" />
        </button>
      </div>

      <div class="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4 pt-1">
        <ChannelActions :channel="props.channel" />
        <p class="text-[10.5px] leading-relaxed text-dim2">{{ t(`remoteAssist.${props.channel}.requirement`) }}</p>

        <!-- 微信：扫码登录 -->
        <template v-if="props.channel === 'wechat'">
          <p class="rounded-[10px] border border-line bg-panel-2 px-3 py-2 text-[11px] leading-relaxed text-dim2">
            {{ t("remoteAssist.wechat.scanHint") }}
          </p>
          <div v-if="store.qr || store.qrError">
            <WechatQrPanel />
          </div>
        </template>

        <!-- Telegram：已配置 → 扫码绑定；未配置 → 扫 BotFather 建机器人 -->
        <TelegramQrPanel v-else-if="props.channel === 'telegram'" />

        <!-- QQ / 企业微信的能力边界提示：都在长连接协议里，提前说清楚比事后报错好 -->
        <p
          v-if="props.channel === 'qq'"
          class="rounded-[10px] border border-line bg-panel-2 px-3 py-2 text-[10.5px] leading-relaxed text-dim2"
          data-testid="qq-passive-hint"
        >
          {{ t("remoteAssist.qq.passiveHint") }}
        </p>
        <p
          v-else-if="props.channel === 'discord'"
          class="rounded-[10px] border border-line bg-panel-2 px-3 py-2 text-[10.5px] leading-relaxed text-dim2"
          data-testid="discord-dm-hint"
        >
          {{ t("remoteAssist.discord.dmOnlyHint") }}
        </p>
        <p
          v-else-if="props.channel === 'wecom'"
          class="rounded-[10px] border border-line bg-panel-2 px-3 py-2 text-[10.5px] leading-relaxed text-dim2"
          data-testid="wecom-takeover-hint"
        >
          {{ t("remoteAssist.wecom.takenOverHint") }}
        </p>

        <!-- 飞书：扫码创建是首选入口（省掉去控制台建应用抄密钥） -->
        <FeishuRegisterPanel v-else-if="props.channel === 'feishu'" />

        <!-- 钉钉：扫码创建与手动填凭证并列（钉钉官方也走这条一键创建路径） -->
        <DingTalkRegisterPanel v-else-if="props.channel === 'dingtalk'" />

        <div v-if="props.channel !== 'wechat'" class="flex flex-col gap-2 border-t border-line pt-3">
          <span class="text-[12px] text-foreground" :data-testid="`${props.channel}-credentials-label`">
            {{ tokenFields ? t(tokenFields.labelKey) : t(`remoteAssist.${props.channel}.${credentialFields.credentialsKey}`) }}
          </span>

          <template v-if="tokenFields">
            <input
              v-model="drafts[props.channel].id"
              :class="inputClass"
              type="password"
              :placeholder="credentialsStored(props.channel) ? t(tokenFields.keepKey) : tokenFields.placeholder"
              :data-testid="tokenFields.testId"
            />
            <p class="text-[10.5px] leading-relaxed text-dim2">{{ t(tokenFields.hintKey) }}</p>
            <!-- Discord 的 token 只能从开发者门户拿，把地址摆在这里省一次切换 -->
            <div v-if="props.channel === 'discord'" class="flex items-center gap-1.5">
              <code class="min-w-0 flex-1 truncate rounded-[7px] bg-panel-2 px-2 py-1 font-mono text-[10.5px] text-dim2">
                {{ DISCORD_PORTAL_URL }}
              </code>
              <button
                type="button"
                class="h-7 shrink-0 cursor-pointer rounded-[7px] border border-line bg-panel px-2.5 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-foreground"
                data-testid="discord-copy-portal"
                @click="copyPortalUrl"
              >
                {{ copiedPortal ? t("remoteAssist.discord.copied") : t("remoteAssist.discord.copyPortal") }}
              </button>
            </div>
          </template>

          <template v-else>
            <div v-if="props.channel === 'dingtalk'" class="flex items-center gap-1.5">
              <code class="min-w-0 flex-1 truncate rounded-[7px] bg-panel-2 px-2 py-1 font-mono text-[10.5px] text-dim2">
                {{ DINGTALK_CONSOLE_URL }}
              </code>
              <button
                type="button"
                class="h-7 shrink-0 cursor-pointer rounded-[7px] border border-line bg-panel px-2.5 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-foreground"
                data-testid="dingtalk-copy-console"
                @click="copyConsoleUrl"
              >
                {{ copiedConsole ? t("remoteAssist.dingtalk.copied") : t("remoteAssist.dingtalk.copyConsole") }}
              </button>
            </div>
            <label class="flex items-center gap-2">
              <span class="w-24 shrink-0 text-[11.5px] text-dim2">{{ credentialFields.idLabel }}</span>
              <input
                v-model="drafts[props.channel].id"
                :class="inputClass"
                :placeholder="credentialFields.idPlaceholder"
                :data-testid="`${props.channel}-client-id`"
              />
            </label>
            <label class="flex items-center gap-2">
              <span class="w-24 shrink-0 text-[11.5px] text-dim2">{{ credentialFields.secretLabel }}</span>
              <input
                v-model="drafts[props.channel].secret"
                :class="inputClass"
                type="password"
                :placeholder="credentialsStored(props.channel) ? t(`remoteAssist.${props.channel}.secretKeep`) : '******'"
                :data-testid="`${props.channel}-client-secret`"
              />
            </label>
            <p class="text-[10.5px] leading-relaxed text-dim2">{{ t(`remoteAssist.${props.channel}.secretHint`) }}</p>
          </template>

          <p v-if="drafts[props.channel].error" class="text-[11px] text-destructive" :data-testid="`${props.channel}-save-error`">
            {{ drafts[props.channel].error }}
          </p>
          <p v-else-if="drafts[props.channel].saved" class="text-[11px] text-mint" :data-testid="`${props.channel}-saved`">
            {{ t(`remoteAssist.${props.channel}.saved`) }}
          </p>
          <button
            type="button"
            class="h-7 w-fit cursor-pointer rounded-[7px] bg-accent px-3 text-[11.5px] font-medium text-accent-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="!drafts[props.channel].id.trim()"
            :data-testid="`${props.channel}-save`"
            @click="void saveCredentials(props.channel)"
          >
            {{ t(`remoteAssist.${props.channel}.save`) }}
          </button>
        </div>

        <div class="flex flex-col gap-2.5 border-t border-line pt-3">
          <label v-for="item in SWITCHES" :key="item.key" class="flex cursor-pointer items-center justify-between gap-3">
            <span>
              <span class="block text-[12.5px] text-foreground">{{ t(`remoteAssist.settings.${item.key}`) }}</span>
              <span class="text-[11px] text-dim2">{{ t(`remoteAssist.settings.${item.key}Hint`) }}</span>
            </span>
            <input
              type="checkbox"
              class="size-4 cursor-pointer accent-[var(--accent)]"
              :checked="settings.remoteAssist.channels[props.channel][item.key]"
              :aria-label="t(`remoteAssist.settings.${item.key}`)"
              :data-testid="`${props.channel}-${item.testId}`"
              @change="onToggle(props.channel, item.key, ($event.target as HTMLInputElement).checked)"
            />
          </label>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
