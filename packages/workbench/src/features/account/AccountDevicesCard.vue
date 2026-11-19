<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { ControlPlaneDevice } from "@/lib/control-plane";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import GwButton from "@/features/shared/GwButton.vue";

const props = defineProps<{ devices: ControlPlaneDevice[]; loaded: boolean; busy: boolean; disabled: boolean }>();
const emit = defineEmits<{ refresh: []; revoke: [device: ControlPlaneDevice]; revokeOthers: [] }>();
const { t } = useI18n();
const hasOthers = computed(() => props.devices.some((device) => !device.current));
</script>

<template>
  <Card data-testid="account-devices">
    <CardHeader>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>{{ t("userAccount.devicesTitle") }}</CardTitle>
        <GwButton variant="outline" :disabled="busy" data-testid="account-devices-refresh" @click="emit('refresh')">{{
          t("userAccount.refreshDevices")
        }}</GwButton>
      </div>
      <CardDescription>{{ t("userAccount.devicesHint") }}</CardDescription>
    </CardHeader>
    <CardContent class="flex flex-col gap-3">
      <p v-if="!loaded" class="text-[12px] text-dim2">{{ busy ? t("userAccount.working") : t("userAccount.devicesNotLoaded") }}</p>
      <p v-else-if="!devices.length" class="text-[12px] text-dim2">{{ t("userAccount.noDevices") }}</p>
      <div
        v-for="device in devices"
        :key="device.id"
        class="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line p-3"
        :data-device-id="device.id"
      >
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <span class="break-all text-[13px] font-medium">{{ device.name }}</span>
            <Badge v-if="device.current" variant="secondary">{{ t("userAccount.currentDevice") }}</Badge>
          </div>
          <p class="mt-1 break-all text-[11px] text-dim2">
            {{ device.platform }} · {{ t("userAccount.lastActive") }}:
            {{ device.lastSeenAt?.replace("T", " ") ?? t("userAccount.unknownActivity") }}
          </p>
        </div>
        <GwButton
          v-if="!device.current"
          variant="danger"
          :disabled="busy || disabled"
          data-testid="account-device-revoke"
          @click="emit('revoke', device)"
          >{{ t("userAccount.revokeDevice") }}</GwButton
        >
      </div>
      <GwButton
        variant="danger"
        :disabled="busy || disabled || !hasOthers"
        data-testid="account-revoke-others"
        @click="emit('revokeOthers')"
        >{{ t("userAccount.revokeOthers") }}</GwButton
      >
    </CardContent>
  </Card>
</template>
