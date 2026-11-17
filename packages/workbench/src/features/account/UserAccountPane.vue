<script setup lang="ts">
import { onMounted, shallowRef } from "vue";
import { useI18n } from "vue-i18n";
import type { AccountLoginInput } from "@/lib/control-plane";
import { useUserAccountStore } from "@/stores/user-account";
import { useNoticeStore } from "@/stores/notice";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import GwButton from "@/features/shared/GwButton.vue";
import ConfirmDialog from "@/features/settings/ConfirmDialog.vue";
import AccountLoginForm from "./AccountLoginForm.vue";
import AccountProfileCard from "./AccountProfileCard.vue";

const { t } = useI18n();
const account = useUserAccountStore();
const notice = useNoticeStore();
const confirmOpen = shallowRef(false);

async function login(input: AccountLoginInput): Promise<void> {
  if (await account.login(input)) notice.success(t("userAccount.loginSuccess"));
}

async function logout(): Promise<void> {
  if (await account.logout()) {
    confirmOpen.value = false;
    notice.info(t("userAccount.logoutSuccess"));
  }
}

onMounted(() => {
  void account.refresh();
});
</script>

<template>
  <div class="flex flex-col gap-4">
    <Alert v-if="!account.available">
      <AlertTitle>{{ t("userAccount.previewTitle") }}</AlertTitle>
      <AlertDescription>{{ t("userAccount.previewHint") }}</AlertDescription>
    </Alert>
    <Alert v-if="account.envManaged">
      <AlertTitle>{{ t("userAccount.envTitle") }}</AlertTitle>
      <AlertDescription>{{ t("userAccount.envHint") }}</AlertDescription>
    </Alert>
    <Alert v-if="account.error" variant="destructive" data-testid="account-error">
      <AlertTitle>{{ t("userAccount.failed") }}</AlertTitle>
      <AlertDescription class="break-words">{{ account.error }}</AlertDescription>
    </Alert>

    <AccountProfileCard
      v-if="account.session"
      :session="account.session"
      :status="account.status"
      :busy="account.busy"
      :env-managed="account.envManaged"
      @refresh="account.refresh()"
      @logout="confirmOpen = true"
    />
    <template v-else>
      <div v-if="account.available" class="flex items-center justify-between gap-2">
        <span class="text-[12px] text-dim2">{{ account.busy ? t("userAccount.working") : t("userAccount.notLoggedIn") }}</span>
        <GwButton variant="outline" :disabled="account.busy" data-testid="account-refresh" @click="account.refresh()">{{
          t("userAccount.refresh")
        }}</GwButton>
      </div>
      <AccountLoginForm
        :base-url="account.status?.baseUrl ?? null"
        :disabled="!account.available || account.envManaged"
        :busy="account.busy"
        @login="login"
      />
      <GwButton
        v-if="account.status?.configured && !account.envManaged"
        variant="danger"
        :disabled="account.busy"
        data-testid="account-logout"
        @click="confirmOpen = true"
        >{{ t("userAccount.logout") }}</GwButton
      >
    </template>

    <ConfirmDialog
      v-if="confirmOpen"
      :title="t('userAccount.logoutTitle')"
      :message="t('userAccount.logoutHint')"
      :confirm-label="t('userAccount.logout')"
      :busy="account.busy"
      @confirm="logout"
      @cancel="confirmOpen = false"
    />
  </div>
</template>
