<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { useRemoteAssistantStore } from "@/stores/remote-assistant";
import QrSvg from "@/features/channels/QrSvg.vue";

/**
 * 飞书「扫码创建应用」面板。
 *
 * 与「去开放平台手工建应用再抄两串密钥」并列的入口：手机飞书扫码 → 确认 →
 * 服务端把 AppID/AppSecret 直接交给宿主落盘（0600）。这里只显示二维码、配对码与结果，
 * 密钥从不出现在界面上。
 */
const { t } = useI18n();
const store = useRemoteAssistantStore();
</script>

<template>
  <div class="rounded-[12px] border border-line bg-panel-2 p-3.5" data-testid="feishu-register-panel">
    <!-- 浏览器态没有宿主：如实说明，而不是给一个点了没反应的按钮 -->
    <p v-if="!store.available" class="text-[11.5px] text-dim2" data-testid="feishu-register-unsupported">
      {{ t("remoteAssist.channels.desktopOnly") }}
    </p>

    <div v-else-if="store.feishuRegister.phase === 'idle'" class="flex flex-col items-start gap-2">
      <span class="text-[12.5px] text-foreground">{{ t("remoteAssist.feishu.registerTitle") }}</span>
      <span class="text-[10.5px] leading-relaxed text-dim2">{{ t("remoteAssist.feishu.registerHint") }}</span>
      <button
        type="button"
        class="h-7 cursor-pointer rounded-[7px] bg-accent px-3 text-[11.5px] font-medium text-accent-ink transition-opacity hover:opacity-90"
        data-testid="feishu-register-start"
        @click="void store.startFeishuRegistration()"
      >
        {{ t("remoteAssist.feishu.registerStart") }}
      </button>
    </div>

    <div v-else-if="store.feishuRegister.phase === 'waiting'" class="flex flex-col items-center gap-2.5">
      <QrSvg v-if="store.feishuRegister.qrUrl" :content="store.feishuRegister.qrUrl" data-testid="feishu-register-qr" />
      <p class="text-center text-[11.5px] leading-relaxed text-dim2" data-testid="feishu-register-scan-hint">
        {{ t("remoteAssist.feishu.registerScanHint") }}
      </p>
      <p v-if="store.feishuRegister.userCode" class="font-mono text-[12px] text-foreground" data-testid="feishu-register-code">
        {{ t("remoteAssist.feishu.registerUserCode", { code: store.feishuRegister.userCode }) }}
      </p>
      <button
        type="button"
        class="h-7 cursor-pointer rounded-[7px] border border-line bg-panel px-3 text-[11.5px] text-dim transition-colors hover:bg-panel-2 hover:text-foreground"
        data-testid="feishu-register-cancel"
        @click="store.cancelFeishuRegistration()"
      >
        {{ t("remoteAssist.feishu.registerCancel") }}
      </button>
    </div>

    <p v-else-if="store.feishuRegister.phase === 'done'" class="text-[11.5px] text-mint" data-testid="feishu-register-done">
      {{ t("remoteAssist.feishu.registerDone") }}
    </p>

    <div v-else class="flex flex-col items-start gap-2">
      <p class="text-[11.5px] text-destructive" data-testid="feishu-register-error">
        {{ store.feishuRegister.detail ?? t("remoteAssist.feishu.registerFailed") }}
      </p>
      <button
        type="button"
        class="h-7 cursor-pointer rounded-[7px] border border-line bg-panel px-3 text-[11.5px] text-dim transition-colors hover:bg-panel-2 hover:text-foreground"
        data-testid="feishu-register-retry"
        @click="void store.startFeishuRegistration()"
      >
        {{ t("remoteAssist.feishu.registerRetry") }}
      </button>
    </div>
  </div>
</template>
