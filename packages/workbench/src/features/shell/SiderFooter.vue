<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { logout, runtimeMode } from "@greywork/host-ipc";
import ConfirmDialog from "@/features/settings/ConfirmDialog.vue";
import Icon from "@/features/shared/Icon.vue";

const { t } = useI18n();

const emit = defineEmits<{ openSettings: []; navigate: [path: string] }>();

/** 行按钮统一样式：34px 高、8px 圆角，与 GreyWork Sider 一致。 */
const rowClass =
  "flex h-[34px] cursor-pointer items-center gap-2 rounded-[calc(8px*var(--gw-radius-scale))] px-2 text-[13px] transition-colors text-dim hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan";

/** 只有服务端态有会话可退：桌面壳是本地壳，浏览器预览没有宿主。 */
const canSignOut = computed(() => runtimeMode() === "server");

const accountLabel = computed(() => t("account.label"));
/** 头像占位取身份标签首字，中英两语言都不为空。 */
const avatarChar = computed(() => accountLabel.value.slice(0, 1));

const confirmOpen = ref(false);
const signingOut = ref(false);

/**
 * 登出：`logout()` 内部无条件发出「会话失效」信号，`AuthGate` 据此重挂登录门，
 * 本组件随之被卸载 —— 所以这里不需要（也不该）自己做跳转。
 */
async function confirmSignOut(): Promise<void> {
  if (signingOut.value) return;
  signingOut.value = true;
  try {
    await logout();
  } finally {
    signingOut.value = false;
    confirmOpen.value = false;
  }
}
</script>

<template>
  <div class="flex shrink-0 flex-col gap-0.5 border-t border-line-2 p-2">
    <button :class="rowClass" data-testid="sider-settings" @click="emit('openSettings')">
      <span class="grid size-5 place-items-center rounded-[calc(5px*var(--gw-radius-scale))] bg-panel text-dim">
        <Icon name="setting" :size="14" />
      </span>
      {{ t(`settings.title`) }}
    </button>

    <div class="flex items-center gap-0.5">
      <button :class="[rowClass, 'min-w-0 flex-1']" data-testid="sider-account" @click="emit('navigate', '/assistants')">
        <span class="grid size-5 shrink-0 place-items-center rounded-full bg-panel font-medium text-dim">
          <span class="text-[10px]">{{ avatarChar }}</span>
        </span>
        <span class="truncate">{{ accountLabel }}</span>
      </button>

      <button
        v-if="canSignOut"
        :class="[rowClass, 'shrink-0 px-1.5']"
        :title="t('account.signOut')"
        :aria-label="t('account.signOut')"
        data-testid="sider-signout"
        @click="confirmOpen = true"
      >
        <Icon name="external" :size="14" />
      </button>
    </div>

    <ConfirmDialog
      v-if="confirmOpen"
      :title="t('account.signOutTitle')"
      :message="t('account.signOutMessage')"
      :confirm-label="t('account.signOutConfirm')"
      :busy="signingOut"
      @confirm="confirmSignOut"
      @cancel="confirmOpen = false"
    />
  </div>
</template>
