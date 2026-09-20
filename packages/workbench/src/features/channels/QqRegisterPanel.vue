<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { useRemoteAssistantStore } from "@/stores/remote-assistant";
import QrSvg from "@/features/channels/QrSvg.vue";

/**
 * QQ「扫码创建机器人」面板。
 *
 * 与「去 q.qq.com 手工建机器人再抄 AppID / AppSecret」并列的入口：手机 QQ 扫码 → 确认 →
 * 服务端把 AppID 与加密的 AppSecret 交给宿主，本地解密后落盘（0600）。这里只显示二维码与结果，
 * 密钥从不出现在界面上。
 */
const { t } = useI18n();
const store = useRemoteAssistantStore();
</script>

<template>
  <div class="rounded-[12px] border border-line bg-panel-2 p-3.5" data-testid="qq-register-panel">
    <!-- 浏览器态没有宿主：如实说明，而不是给一个点了没反应的按钮 -->
    <p v-if="!store.available" class="text-[11.5px] text-dim2" data-testid="qq-register-unsupported">
      {{ t("remoteAssist.channels.desktopOnly") }}
    </p>

    <div v-else-if="store.qqRegister.phase === 'idle'" class="flex flex-col items-start gap-2">
      <span class="text-[12.5px] text-foreground">{{ t("remoteAssist.qq.registerTitle") }}</span>
      <span class="text-[10.5px] leading-relaxed text-dim2">{{ t("remoteAssist.qq.registerHint") }}</span>
      <button
        type="button"
        class="h-7 cursor-pointer rounded-[7px] bg-accent px-3 text-[11.5px] font-medium text-accent-ink transition-opacity hover:opacity-90"
        data-testid="qq-register-start"
        @click="void store.startQqRegistration()"
      >
        {{ t("remoteAssist.qq.registerStart") }}
      </button>
    </div>

    <div v-else-if="store.qqRegister.phase === 'waiting'" class="flex flex-col items-center gap-2.5">
      <QrSvg v-if="store.qqRegister.qrUrl" :content="store.qqRegister.qrUrl" data-testid="qq-register-qr" />
      <p class="text-center text-[11.5px] leading-relaxed text-dim2" data-testid="qq-register-scan-hint">
        {{ t("remoteAssist.qq.registerScanHint") }}
      </p>
      <button
        type="button"
        class="h-7 cursor-pointer rounded-[7px] border border-line bg-panel px-3 text-[11.5px] text-dim transition-colors hover:bg-panel-2 hover:text-foreground"
        data-testid="qq-register-cancel"
        @click="store.cancelQqRegistration()"
      >
        {{ t("remoteAssist.qq.registerCancel") }}
      </button>
    </div>

    <p v-else-if="store.qqRegister.phase === 'done'" class="text-[11.5px] text-mint" data-testid="qq-register-done">
      {{ t("remoteAssist.qq.registerDone") }}
    </p>

    <div v-else class="flex flex-col items-start gap-2">
      <p class="text-[11.5px] text-destructive" data-testid="qq-register-error">
        {{ store.qqRegister.detail ?? t("remoteAssist.qq.registerFailed") }}
      </p>
      <button
        type="button"
        class="h-7 cursor-pointer rounded-[7px] border border-line bg-panel px-3 text-[11.5px] text-dim transition-colors hover:bg-panel-2 hover:text-foreground"
        data-testid="qq-register-retry"
        @click="void store.startQqRegistration()"
      >
        {{ t("remoteAssist.qq.registerRetry") }}
      </button>
    </div>
  </div>
</template>
