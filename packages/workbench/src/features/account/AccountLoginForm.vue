<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { AccountLoginInput } from "@/lib/control-plane";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import GwButton from "@/features/shared/GwButton.vue";

const props = defineProps<{ baseUrl: string | null; disabled: boolean; busy: boolean }>();
const emit = defineEmits<{ login: [input: AccountLoginInput] }>();
const { t } = useI18n();
const form = reactive({ baseUrl: "http://localhost:8080", email: "", code: "", displayName: "", deviceName: "" });
watch(
  () => props.baseUrl,
  (value) => {
    if (value) form.baseUrl = value;
  },
  { immediate: true },
);
const canSubmit = computed(() => !props.disabled && !props.busy && !!form.baseUrl.trim() && !!form.email.trim() && !!form.code.trim());

function submit(): void {
  if (!canSubmit.value) return;
  emit("login", {
    baseUrl: form.baseUrl.trim(),
    email: form.email.trim(),
    code: form.code.trim(),
    ...(form.displayName.trim() ? { displayName: form.displayName.trim() } : {}),
    ...(form.deviceName.trim() ? { deviceName: form.deviceName.trim() } : {}),
  });
  form.code = "";
}
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle>{{ t("userAccount.loginTitle") }}</CardTitle>
      <CardDescription>{{ t("userAccount.loginHint") }}</CardDescription>
    </CardHeader>
    <form data-testid="account-login-form" @submit.prevent="submit">
      <CardContent>
        <FieldGroup class="gap-4">
          <Field :data-disabled="disabled || busy">
            <FieldLabel for="account-url">{{ t("userAccount.server") }}</FieldLabel>
            <Input
              id="account-url"
              v-model="form.baseUrl"
              type="url"
              required
              :disabled="disabled || busy"
              placeholder="http://localhost:8080"
            />
            <FieldDescription>{{ t("userAccount.serverHint") }}</FieldDescription>
          </Field>
          <Field :data-disabled="disabled || busy">
            <FieldLabel for="account-email">{{ t("userAccount.email") }}</FieldLabel>
            <Input
              id="account-email"
              v-model="form.email"
              type="email"
              maxlength="254"
              autocomplete="username"
              required
              :disabled="disabled || busy"
              placeholder="you@example.com"
            />
          </Field>
          <Field :data-disabled="disabled || busy">
            <FieldLabel for="account-code">{{ t("userAccount.enrollCode") }}</FieldLabel>
            <Input id="account-code" v-model="form.code" type="password" autocomplete="off" required :disabled="disabled || busy" />
          </Field>
          <Field :data-disabled="disabled || busy">
            <FieldLabel for="account-name">{{ t("userAccount.displayName") }}</FieldLabel>
            <Input
              id="account-name"
              v-model="form.displayName"
              maxlength="128"
              autocomplete="nickname"
              :disabled="disabled || busy"
              :placeholder="t('userAccount.optional')"
            />
          </Field>
          <Field :data-disabled="disabled || busy">
            <FieldLabel for="account-device">{{ t("userAccount.deviceName") }}</FieldLabel>
            <Input
              id="account-device"
              v-model="form.deviceName"
              maxlength="128"
              :disabled="disabled || busy"
              :placeholder="t('userAccount.defaultDevice')"
            />
          </Field>
        </FieldGroup>
      </CardContent>
      <CardFooter class="mt-5 flex-wrap gap-3">
        <GwButton type="submit" variant="primary" size="md" :disabled="!canSubmit" data-testid="account-login">
          {{ busy ? t("userAccount.working") : t("userAccount.login") }}
        </GwButton>
        <p class="text-[11px] text-dim2">{{ t("userAccount.credentialHint") }}</p>
      </CardFooter>
    </form>
  </Card>
</template>
