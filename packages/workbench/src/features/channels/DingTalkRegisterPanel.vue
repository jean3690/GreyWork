<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { useRemoteAssistantStore } from "@/stores/remote-assistant";
import QrSvg from "@/features/channels/QrSvg.vue";

/**
 * 钉钉「扫码创建应用」面板。
 *
 * 与「去开放平台手工建应用再抄两串密钥」并列的入口：手机钉钉扫码 → 确认 →
 * 服务端把 Client ID / Client Secret 直接交给宿主落盘（0600）。这里只显示二维码、配对码与结果，
 * 密钥从不出现在界面上。
 */
const { t } = useI18n();
const store = useRemoteAssistantStore();
</script>

<template>
  <div class="rounded-[12px] border border-line bg-panel-2 p-3.5" data-testid="dingtalk-register-panel">
    <!-- 浏览器态没有宿主：如实说明，而不是给一个点了没反应的按钮 -->
    <p v-if="!store.available" class="text-[11.5px] text-dim2" data-testid="dingtalk-register-unsupported">
      {{ t("remoteAssist.channels.desktopOnly") }}
    </p>

    <div v-else-if="store.dingtalkRegister.phase === 'idle'" class="flex flex-col items-start gap-2">
      <span class="text-[12.5px] text-foreground">{{ t("remoteAssist.dingtalk.registerTitle") }}</span>
      <span class="text-[10.5px] leading-relaxed text-dim2">{{ t("remoteAssist.dingtalk.registerHint") }}</span>
      <button
        type="button"
        class="h-7 cursor-pointer rounded-[7px] bg-accent px-3 text-[11.5px] font-medium text-accent-ink transition-opacity hover:opacity-90"
        data-testid="dingtalk-register-start"
        @click="void store.startDingTalkRegistration()"
      >
        {{ t("remoteAssist.dingtalk.registerStart") }}
      </button>
    </div>

    <div v-else-if="store.dingtalkRegister.phase === 'waiting'" class="flex flex-col items-center gap-2.5">
      <QrSvg v-if="store.dingtalkRegister.qrUrl" :content="store.dingtalkRegister.qrUrl" data-testid="dingtalk-register-qr" />
      <p class="text-center text-[11.5px] leading-relaxed text-dim2" data-testid="dingtalk-register-scan-hint">
        {{ t("remoteAssist.dingtalk.registerScanHint") }}
      </p>
      <p v-if="store.dingtalkRegister.userCode" class="font-mono text-[12px] text-foreground" data-testid="dingtalk-register-code">
        {{ t("remoteAssist.dingtalk.registerUserCode", { code: store.dingtalkRegister.userCode }) }}
      </p>
      <button
        type="button"
        class="h-7 cursor-pointer rounded-[7px] border border-line bg-panel px-3 text-[11.5px] text-dim transition-colors hover:bg-panel-2 hover:text-foreground"
        data-testid="dingtalk-register-cancel"
        @click="store.cancelDingTalkRegistration()"
      >
        {{ t("remoteAssist.dingtalk.registerCancel") }}
      </button>
    </div>

    <p v-else-if="store.dingtalkRegister.phase === 'done'" class="text-[11.5px] text-mint" data-testid="dingtalk-register-done">
      {{ t("remoteAssist.dingtalk.registerDone") }}
    </p>

    <div v-else class="flex flex-col items-start gap-2">
      <p class="text-[11.5px] text-destructive" data-testid="dingtalk-register-error">
        {{ store.dingtalkRegister.detail ?? t("remoteAssist.dingtalk.registerFailed") }}
      </p>
      <button
        type="button"
        class="h-7 cursor-pointer rounded-[7px] border border-line bg-panel px-3 text-[11.5px] text-dim transition-colors hover:bg-panel-2 hover:text-foreground"
        data-testid="dingtalk-register-retry"
        @click="void store.startDingTalkRegistration()"
      >
        {{ t("remoteAssist.dingtalk.registerRetry") }}
      </button>
    </div>
  </div>
</template>
