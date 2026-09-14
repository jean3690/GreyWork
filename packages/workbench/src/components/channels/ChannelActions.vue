<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useRemoteAssistantStore, type RemoteChannel } from "../../stores/remote-assistant";

/**
 * 通道状态徽章 + 连接动作（远程助手页与设置面板共用，两条通道同一套交互）。
 *
 * 浏览器态没有宿主：按钮禁用并写明原因 —— 点了没反应比禁用更让人困惑。
 * 钉钉还多一层前提：没保存应用凭证时连接没有意义，这里如实提示去填。
 */
const props = defineProps<{ channel: RemoteChannel }>();

const { t } = useI18n();
const store = useRemoteAssistantStore();

/** 状态键必须显式映射：动态拼 key 会绕过 i18n 的类型检查。 */
const STATUS_LABELS = {
  stopped: "remoteAssist.status.stopped",
  connecting: "remoteAssist.status.connecting",
  connected: "remoteAssist.status.connected",
  paused: "remoteAssist.status.paused",
  error: "remoteAssist.status.error",
} as const;

const status = computed(() => store.statusOf(props.channel));

const badge = computed(() => {
  const state = status.value.state;
  const tone =
    state === "connected"
      ? "border-mint/40 text-mint"
      : state === "error"
        ? "border-destructive/40 text-destructive"
        : state === "paused"
          ? "border-amber/40 text-amber"
          : "border-line text-dim2";
  return { label: t(STATUS_LABELS[state]), className: tone };
});

/** 通道名（未就绪提示按通道取文案）。 */
const CHANNEL_HINT_KEYS: Record<RemoteChannel, string> = {
  wechat: "remoteAssist.wechat.scanFirst",
  dingtalk: "remoteAssist.dingtalk.credentialsFirst",
  feishu: "remoteAssist.feishu.credentialsFirst",
};

/** 未就绪时的原因：微信要扫码，钉钉 / 飞书要先填应用凭证。 */
const blockedHint = computed(() => (status.value.ready ? "" : t(CHANNEL_HINT_KEYS[props.channel])));

const buttonClass =
  "h-7 cursor-pointer rounded-[7px] border border-line bg-panel-2 px-2.5 text-[11.5px] text-dim transition-colors hover:border-line-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40";

function connect(): void {
  if (props.channel === "wechat") void store.connect();
  else if (props.channel === "dingtalk") void store.connectDingTalk();
  else void store.connectFeishu();
}

function disconnect(): void {
  if (props.channel === "wechat") void store.disconnect();
  else if (props.channel === "dingtalk") void store.disconnectDingTalk();
  else void store.disconnectFeishu();
}

function forget(): void {
  if (props.channel === "wechat") void store.logout();
  else if (props.channel === "dingtalk") void store.clearDingTalkCredentials();
  else void store.clearFeishuCredentials();
}
</script>

<template>
  <div class="flex flex-col gap-2" :data-testid="`${props.channel}-channel-actions`">
    <div class="flex flex-wrap items-center gap-2">
      <span class="rounded-full border px-2 py-0.5 text-[11px]" :class="badge.className" :data-testid="`${props.channel}-status-badge`">
        {{ badge.label }}
      </span>
      <span v-if="status.account" class="truncate text-[11px] text-dim2">
        {{ t("remoteAssist.channels.account", { account: status.account }) }}
      </span>
    </div>

    <p v-if="status.detail" class="text-[11px] leading-relaxed text-dim2" :data-testid="`${props.channel}-status-detail`">
      {{ status.detail }}
    </p>

    <div class="flex flex-wrap items-center gap-1.5">
      <template v-if="!store.available">
        <span class="text-[11px] text-dim2">{{ t("remoteAssist.channels.desktopOnly") }}</span>
      </template>

      <template v-else-if="!status.ready">
        <span class="text-[11px] text-dim2" :data-testid="`${props.channel}-blocked-hint`">{{ blockedHint }}</span>
        <button
          v-if="props.channel === 'wechat'"
          type="button"
          class="bg-accent text-accent-ink hover:opacity-90"
          :class="buttonClass"
          data-testid="wechat-connect"
          @click="void store.startLogin()"
        >
          {{ t("remoteAssist.wechat.connect") }}
        </button>
      </template>

      <template v-else>
        <button
          v-if="status.state === 'connected' || status.state === 'connecting'"
          type="button"
          :class="buttonClass"
          :data-testid="`${props.channel}-disconnect`"
          @click="disconnect"
        >
          {{ t("remoteAssist.wechat.disconnect") }}
        </button>
        <button v-else type="button" :class="buttonClass" :data-testid="`${props.channel}-connect`" @click="connect">
          {{ t("remoteAssist.wechat.connectAction") }}
        </button>
        <button type="button" :class="buttonClass" :data-testid="`${props.channel}-forget`" @click="forget">
          {{ props.channel === "wechat" ? t("remoteAssist.wechat.logout") : t("remoteAssist.dingtalk.clear") }}
        </button>
      </template>
    </div>
  </div>
</template>
