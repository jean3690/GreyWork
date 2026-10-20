<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { hasNativeShell, logout, runtimeMode } from "@greywork/host-ipc";
import ConfirmDialog from "@/features/settings/ConfirmDialog.vue";
import Icon from "@/features/shared/Icon.vue";
import GwButton from "@/features/shared/GwButton.vue";

const { t } = useI18n();

const emit = defineEmits<{ openSettings: []; navigate: [path: string] }>();

/**
 * 行按钮共享残留：GwButton 的 `subtle` 变体已给出 text-dim / hover:text-foreground /
 * 焦点环 / 过渡，这里只补行特有的尺寸与左对齐；`hover:bg-panel` 覆盖变体默认的 panel-2。
 */
const rowClass = "h-[34px] w-full justify-start gap-2 px-2 text-[13px] hover:bg-panel";

/**
 * 只有**浏览器经服务端托管**时才有会话可退：桌面壳（Tauri / Electron）是本地壳，
 * 登出会把自己锁到登录门，重启前进不来；浏览器预览态没有宿主。
 *
 * 判据不能只看 `runtimeMode() === "server"` —— Electron 壳跑的正是 server 态（sidecar），
 * 但它有自己的登录流程，不归这里管。
 */
const canSignOut = computed(() => runtimeMode() === "server" && !hasNativeShell());

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
    <GwButton variant="subtle" radius="xl" :class="rowClass" data-testid="sider-settings" @click="emit('openSettings')">
      <span class="grid size-5 place-items-center rounded-[calc(5px*var(--gw-radius-scale))] bg-panel text-dim">
        <Icon name="setting" :size="14" />
      </span>
      {{ t(`settings.title`) }}
    </GwButton>

    <div class="flex items-center gap-0.5">
      <GwButton
        variant="subtle"
        radius="xl"
        :class="[rowClass, 'min-w-0 flex-1']"
        data-testid="sider-account"
        @click="emit('navigate', '/assistants')"
      >
        <span class="grid size-5 shrink-0 place-items-center rounded-full bg-panel font-medium text-dim">
          <span class="text-[10px]">{{ avatarChar }}</span>
        </span>
        <span class="truncate">{{ accountLabel }}</span>
      </GwButton>

      <GwButton
        v-if="canSignOut"
        variant="subtle"
        radius="xl"
        :class="[rowClass, 'w-auto shrink-0 justify-center px-1.5']"
        :title="t('account.signOut')"
        :aria-label="t('account.signOut')"
        data-testid="sider-signout"
        @click="confirmOpen = true"
      >
        <Icon name="external" :size="14" />
      </GwButton>
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
