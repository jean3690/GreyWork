<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { appEvents } from "../events";
import { peerKey, useRemoteAssistantStore, type RemoteChannel } from "../stores/remote-assistant";
import { useSettingsStore } from "../stores/settings";
import Icon from "../components/Icon.vue";

/**
 * 远程助手：通道现状 + 会话入口。
 *
 * 页面本身不配置任何东西 —— 扫码、开关、回复后端都在设置里（「打开设置」直接跳过去）。
 * 这里只回答两个问题：通道通不通、跟谁在聊（点进会话页）。
 */
const { t, locale } = useI18n();
const router = useRouter();
const store = useRemoteAssistantStore();
const settings = useSettingsStore();

/** 已接入的通道（页面按这个清单出卡片）。 */
const CHANNELS: RemoteChannel[] = ["wechat", "dingtalk", "feishu"];

/** 回复后端展示名：模型供应商取名字，ACP 取后端名（跟随对话页时另标）。 */
const replyBackendLabel = computed(() => {
  if (settings.remoteAssist.replyMode !== "acp") return t("remoteAssist.settings.replyLlm");
  const configured = settings.remoteAssist.replyProviderId;
  if (!configured) return t("remoteAssist.settings.replyProviderFollow");
  return configured;
});

/** 通道状态文案（与设置面板同一个映射）。 */
function channelState(channel: RemoteChannel): string {
  return t(`remoteAssist.status.${store.statusOf(channel).state}`);
}

function channelReady(channel: RemoteChannel): boolean {
  return store.statusOf(channel).ready;
}

function channelConnected(channel: RemoteChannel): boolean {
  return store.connectedOf(channel);
}

// 回到本页时拉一次两条通道的状态：状态可能是在别处（设置里扫码 / 断开）变的。
onMounted(() => {
  void store.refreshStatus().catch(() => undefined);
  void store.refreshDingTalkStatus().catch(() => undefined);
  void store.refreshFeishuStatus().catch(() => undefined);
});

function formatTime(at: number): string {
  if (!at) return "";
  return new Date(at).toLocaleTimeString(locale.value, { hour: "2-digit", minute: "2-digit", hour12: false });
}

function openSettings(): void {
  appEvents.emit("settings:open", { section: "assistant" });
}

function openConversation(key: string): void {
  void router.push(`/remote/${encodeURIComponent(key)}`);
}
</script>

<template>
  <section class="mx-auto min-h-0 h-full w-full max-w-[860px] overflow-y-auto px-4 py-6 sm:px-6">
    <div class="mb-5">
      <h1 class="font-display text-[20px] font-bold tracking-tight text-foreground">{{ t("remoteAssist.page.title") }}</h1>
      <p class="mt-1 text-[12px] text-dim2">{{ t("remoteAssist.page.desc") }}</p>
    </div>

    <div class="flex flex-col gap-2.5">
      <!-- 通道现状：每条通道一张卡（状态 + 回复后端 + 设置入口） -->
      <article
        v-for="(channel, index) in CHANNELS"
        :key="channel"
        class="rounded-[14px] border border-line bg-panel p-4"
        :data-testid="`channel-${channel}`"
      >
        <div class="flex items-center gap-2.5">
          <span class="grid size-8 shrink-0 place-items-center rounded-[9px] bg-panel-2 text-dim">
            <Icon name="message" :size="16" />
          </span>
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span class="text-[13px] font-medium text-foreground">{{ t(`remoteAssist.channels.${channel}`) }}</span>
              <span
                class="rounded-full border px-2 py-0.5 text-[11px]"
                :class="channelConnected(channel) ? 'border-mint/40 text-mint' : 'border-line text-dim2'"
                :data-testid="`${channel}-status-badge`"
              >
                {{ channelConnected(channel) ? t("remoteAssist.channels.online") : channelState(channel) }}
              </span>
            </div>
            <div class="truncate text-[11px] text-dim2" :data-testid="`${channel}-subtitle`">
              <template v-if="index === 0"> {{ t("remoteAssist.channels.backend") }}：{{ replyBackendLabel }} · </template>
              {{ channelReady(channel) ? store.statusOf(channel).account : t(`remoteAssist.channels.${channel}NotReady`) }}
              <template v-if="!store.available"> · {{ t("remoteAssist.channels.desktopOnly") }}</template>
            </div>
          </div>
          <button
            type="button"
            class="ml-auto h-7 shrink-0 cursor-pointer rounded-[7px] border border-line bg-panel-2 px-2.5 text-[11.5px] text-dim transition-colors hover:border-line-2 hover:text-foreground"
            :data-testid="`${channel}-open-settings`"
            @click="openSettings"
          >
            {{ t("remoteAssist.channels.goSettings") }}
          </button>
        </div>
      </article>

      <!-- 会话入口：每个联系人一段往来 -->
      <article class="rounded-[14px] border border-line bg-panel p-4">
        <div class="mb-2 text-[13px] font-medium text-foreground">{{ t("remoteAssist.conversation.peers") }}</div>
        <p v-if="store.peerList.length === 0" class="text-[11.5px] text-dim2" data-testid="remote-peers-empty">
          {{ t("remoteAssist.conversation.peersEmpty") }}
        </p>
        <ul v-else class="flex flex-col gap-1" data-testid="remote-peers">
          <li v-for="peer in store.peerList" :key="peer.id">
            <button
              type="button"
              class="flex w-full cursor-pointer items-center gap-2 rounded-[10px] border border-transparent px-2 py-2 text-left transition-colors hover:border-line hover:bg-panel-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
              :data-testid="`remote-peer-${peerKey(peer)}`"
              @click="openConversation(peerKey(peer))"
            >
              <span class="grid size-7 shrink-0 place-items-center rounded-[8px] bg-panel-2 text-dim">
                <Icon name="message" :size="14" />
              </span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-[12.5px] text-foreground">
                  <span class="text-dim2">{{ t(`remoteAssist.channels.${peer.channel}`) }}</span>
                  · {{ peer.nick }}
                </span>
                <span class="block truncate text-[11px] text-dim2">{{ peer.lastText }}</span>
              </span>
              <span class="shrink-0 text-[10.5px] text-dim2">{{ formatTime(peer.lastAt) }}</span>
              <span
                v-if="peer.lastAt > peer.readAt"
                class="size-1.5 shrink-0 rounded-full bg-accent"
                :aria-label="t('remoteAssist.conversation.peers')"
              />
            </button>
          </li>
        </ul>
      </article>
    </div>
  </section>
</template>
