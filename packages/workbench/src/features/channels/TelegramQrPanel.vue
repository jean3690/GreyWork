<script setup lang="ts">
import { computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRemoteAssistantStore } from "@/stores/remote-assistant";
import QrSvg from "@/features/channels/QrSvg.vue";

/**
 * Telegram 扫码面板（设置 · 远程助手 → Telegram 弹窗）。
 *
 * 平台能力边界：
 * - **能扫码**：机器人身份由 token 决定，宿主用 `getMe` 拿到 @username 就能拼出
 *   `t.me/<username>`——手机扫码即打开与机器人的对话，发一条消息就完成「归属人认领」
 *   （第一个来消息的 chat 成为默认主人）。这就是这条通道的「扫码连接」。
 * - **不能扫码**：Telegram 没有「扫码创建机器人 / 扫码取 token」的官方流程，创建只能
 *   在 @BotFather 里对话完成，所以未配置时这里给的是 BotFather 的二维码 + 手填 token。
 */
const { t } = useI18n();
const store = useRemoteAssistantStore();

const configured = computed(() => store.telegramStatus.configured);
const link = computed(() => store.telegramBotLink.link);
const linkError = computed(() => store.telegramBotLink.error);
/** 已收到过消息 = 绑定完成（宿主侧归属人已认领）。 */
const bound = computed(() => store.telegramStatus.peerCount > 0);

/** BotFather 的 t.me 链接：手机扫它就能开始建机器人（内容公开、不含任何凭据）。 */
const BOTFATHER_URL = "https://t.me/BotFather";

// 已配置就要有码可扫：弹窗打开时取一次，**保存 token 之后就地从 BotFather 引导切过来**
// （组件不会因为 configured 变化而重挂载，所以这里必须 watch 而不是 onMounted）。
watch(
  configured,
  (ready) => {
    if (ready && !link.value) void store.refreshTelegramBotLink();
  },
  { immediate: true },
);
</script>

<template>
  <div class="rounded-[12px] border border-line bg-panel-2 p-3.5" data-testid="telegram-qr-panel">
    <!-- 已配置：扫码绑定（归属人认领） -->
    <template v-if="configured">
      <div v-if="link" class="flex flex-col items-center gap-2.5">
        <QrSvg :content="link.url" data-testid="telegram-bind-qr" />
        <p class="text-center text-[11.5px] leading-relaxed text-dim2" data-testid="telegram-bind-url">
          {{ t("remoteAssist.telegram.bindHint", { url: link.url }) }}
        </p>
        <p
          class="rounded-full border px-2 py-0.5 text-[10.5px]"
          :class="bound ? 'border-mint/40 text-mint' : 'border-line text-dim2'"
          data-testid="telegram-bind-state"
        >
          {{ bound ? t("remoteAssist.telegram.bound", { count: store.telegramStatus.peerCount }) : t("remoteAssist.telegram.bindWaiting") }}
        </p>
        <button
          type="button"
          class="h-7 cursor-pointer rounded-[7px] border border-line bg-panel px-3 text-[11.5px] text-dim transition-colors hover:bg-panel-2 hover:text-foreground"
          data-testid="telegram-bind-refresh"
          @click="void store.refreshTelegramBotLink()"
        >
          {{ t("remoteAssist.telegram.refreshLink") }}
        </button>
      </div>

      <div v-else class="flex flex-col items-center gap-2.5">
        <p class="text-center text-[11.5px] text-destructive" data-testid="telegram-bind-error">
          {{ linkError ?? t("remoteAssist.telegram.linkFailed") }}
        </p>
        <button
          type="button"
          class="h-7 cursor-pointer rounded-[7px] border border-line bg-panel px-3 text-[11.5px] text-dim transition-colors hover:bg-panel-2 hover:text-foreground"
          data-testid="telegram-bind-retry"
          @click="void store.refreshTelegramBotLink()"
        >
          {{ t("remoteAssist.telegram.refreshLink") }}
        </button>
      </div>
    </template>

    <!-- 未配置：先去 BotFather 建机器人（这一步只能对话完成，扫码省掉找入口） -->
    <div v-else class="flex flex-col items-center gap-2.5">
      <QrSvg :content="BOTFATHER_URL" data-testid="telegram-botfather-qr" />
      <p class="text-center text-[11.5px] leading-relaxed text-dim2">{{ t("remoteAssist.telegram.createHint") }}</p>
    </div>
  </div>
</template>
