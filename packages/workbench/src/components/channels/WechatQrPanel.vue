<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { useRemoteAssistantStore } from "../../stores/remote-assistant";
import QrSvg from "./QrSvg.vue";

/**
 * 微信登录二维码面板（远程助手页与设置面板共用）。
 *
 * 二维码内容来自宿主（腾讯 iLink 下发的一条链接），这里只负责摆出码图与等待提示：
 * 扫码在手机上完成，桌面端不碰任何凭据。
 */
const { t } = useI18n();
const store = useRemoteAssistantStore();
</script>

<template>
  <div class="rounded-[12px] border border-line bg-panel-2 p-3.5" data-testid="wechat-qr-panel">
    <div v-if="store.qr" class="flex flex-col items-center gap-2.5">
      <QrSvg :content="store.qr.content" data-testid="wechat-qr-svg" />
      <p class="text-center text-[11.5px] leading-relaxed text-dim2">
        {{ store.qr.phase === "scaned" ? t("remoteAssist.wechat.scannedHint") : t("remoteAssist.wechat.scanHint") }}
      </p>
      <button
        type="button"
        class="h-7 cursor-pointer rounded-[7px] border border-line bg-panel px-3 text-[11.5px] text-dim transition-colors hover:bg-panel-2 hover:text-foreground"
        data-testid="wechat-qr-cancel"
        @click="store.cancelLogin()"
      >
        {{ t("remoteAssist.wechat.cancel") }}
      </button>
    </div>

    <div v-else-if="store.qrError" class="flex flex-col items-center gap-2.5">
      <p class="text-center text-[11.5px] text-destructive" data-testid="wechat-qr-error">{{ store.qrError }}</p>
      <button
        type="button"
        class="h-7 cursor-pointer rounded-[7px] border border-line bg-panel px-3 text-[11.5px] text-dim transition-colors hover:bg-panel-2 hover:text-foreground"
        data-testid="wechat-qr-retry"
        @click="void store.startLogin()"
      >
        {{ t("remoteAssist.wechat.refreshQr") }}
      </button>
    </div>
  </div>
</template>
