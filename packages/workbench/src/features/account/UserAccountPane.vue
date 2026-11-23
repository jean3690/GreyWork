<script setup lang="ts">
import { computed, onMounted, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { AccountLoginInput, ControlPlaneDevice } from "@/lib/control-plane";
import { useUserAccountStore } from "@/stores/user-account";
import { useNoticeStore } from "@/stores/notice";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import GwButton from "@/features/shared/GwButton.vue";
import ConfirmDialog from "@/features/settings/ConfirmDialog.vue";
import AccountLoginForm from "./AccountLoginForm.vue";
import AccountProfileCard from "./AccountProfileCard.vue";
import AccountProfileForm from "./AccountProfileForm.vue";
import AccountDevicesCard from "./AccountDevicesCard.vue";
import PreferencesSyncPane from "./PreferencesSyncPane.vue";

const { t } = useI18n();
const account = useUserAccountStore();
const notice = useNoticeStore();
const confirmation = shallowRef<{ kind: "logout" | "device" | "others"; device?: ControlPlaneDevice } | null>(null);
watch([() => account.status?.baseUrl, () => account.session?.user.id, () => account.session?.device.id], () => {
  confirmation.value = null;
});
const confirmationText = computed(() => {
  if (confirmation.value?.kind === "device")
    return {
      title: t("userAccount.revokeDeviceTitle"),
      hint: t("userAccount.revokeDeviceHint", { name: confirmation.value.device?.name }),
      label: t("userAccount.revokeDevice"),
    };
  if (confirmation.value?.kind === "others")
    return { title: t("userAccount.revokeOthers"), hint: t("userAccount.revokeOthersHint"), label: t("userAccount.revokeOthers") };
  return { title: t("userAccount.logoutTitle"), hint: t("userAccount.logoutHint"), label: t("userAccount.logout") };
});

async function login(input: AccountLoginInput): Promise<void> {
  if (await account.login(input)) {
    notice.success(t("userAccount.loginSuccess"));
    await account.loadDevices();
  }
}

async function confirm(): Promise<void> {
  const selected = confirmation.value;
  if (!selected) return;
  const ok =
    selected.kind === "logout"
      ? await account.logout()
      : selected.kind === "device" && selected.device
        ? await account.revokeDevice(selected.device.id)
        : await account.revokeOtherSessions();
  if (ok) {
    confirmation.value = null;
    notice.info(t(selected.kind === "logout" ? "userAccount.logoutSuccess" : "userAccount.sessionsRevoked"));
  }
}

async function refresh(): Promise<void> {
  await account.refresh();
  await account.loadDevices();
}

async function saveProfile(name: string): Promise<void> {
  if (await account.saveProfile(name)) notice.success(t("userAccount.profileSaved"));
}

onMounted(() => {
  void refresh();
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
      @refresh="refresh"
      @logout="confirmation = { kind: 'logout' }"
    />
    <template v-if="account.session">
      <AccountProfileForm
        :display-name="account.session.user.displayName"
        :busy="account.busy"
        :disabled="account.envManaged"
        @save="saveProfile"
      />
      <AccountDevicesCard
        :devices="account.devices"
        :loaded="account.devicesLoaded"
        :busy="account.busy"
        :disabled="account.envManaged"
        @refresh="account.loadDevices()"
        @revoke="confirmation = { kind: 'device', device: $event }"
        @revoke-others="confirmation = { kind: 'others' }"
      />
      <PreferencesSyncPane />
    </template>
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
        @click="confirmation = { kind: 'logout' }"
        >{{ t("userAccount.logout") }}</GwButton
      >
    </template>

    <ConfirmDialog
      v-if="confirmation"
      :title="confirmationText.title"
      :message="confirmationText.hint"
      :confirm-label="confirmationText.label"
      :busy="account.busy"
      @confirm="confirm"
      @cancel="confirmation = null"
    />
  </div>
</template>
