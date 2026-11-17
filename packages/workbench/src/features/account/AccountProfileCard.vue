<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { ControlPlaneSession, ControlPlaneStatus } from "@/lib/control-plane";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import GwButton from "@/features/shared/GwButton.vue";

const props = defineProps<{ session: ControlPlaneSession; status: ControlPlaneStatus | null; busy: boolean; envManaged: boolean }>();
const emit = defineEmits<{ refresh: []; logout: [] }>();
const { t } = useI18n();
const name = computed(() => props.session.user.displayName || props.session.user.email);
const role = computed(() => (props.session.user.role === "admin" ? t("userAccount.admin") : t("userAccount.user")));
</script>

<template>
  <Card data-testid="account-profile">
    <CardHeader>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <CardTitle class="break-all">{{ name }}</CardTitle>
        <Badge variant="secondary">{{ role }}</Badge>
      </div>
      <CardDescription>{{ session.user.email }}</CardDescription>
    </CardHeader>
    <CardContent>
      <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-3 text-[12px]">
        <dt class="text-dim2">{{ t("userAccount.userId") }}</dt>
        <dd class="break-all font-mono">{{ session.user.id }}</dd>
        <dt class="text-dim2">{{ t("userAccount.server") }}</dt>
        <dd class="break-all font-mono">{{ status?.baseUrl }}</dd>
        <dt class="text-dim2">{{ t("userAccount.currentDevice") }}</dt>
        <dd class="break-words">{{ session.device.name }} · {{ session.device.platform }}</dd>
        <dt class="text-dim2">{{ t("userAccount.hostStatus") }}</dt>
        <dd>{{ status?.registered ? t("userAccount.hostOnline") : t("userAccount.hostPending") }}</dd>
      </dl>
    </CardContent>
    <CardFooter class="flex-wrap gap-2">
      <GwButton variant="outline" size="md" :disabled="busy" data-testid="account-refresh" @click="emit('refresh')">{{
        t("userAccount.refresh")
      }}</GwButton>
      <GwButton variant="danger" size="md" :disabled="busy || envManaged" data-testid="account-logout" @click="emit('logout')">{{
        t("userAccount.logout")
      }}</GwButton>
    </CardFooter>
  </Card>
</template>
