<script setup lang="ts">
import { computed, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field";
import GwButton from "@/features/shared/GwButton.vue";

const props = defineProps<{ displayName: string | null; busy: boolean; disabled: boolean }>();
const emit = defineEmits<{ save: [displayName: string] }>();
const { t } = useI18n();
const name = shallowRef("");
watch(
  () => props.displayName,
  (value) => {
    name.value = value ?? "";
  },
  { immediate: true },
);
const canSave = computed(
  () =>
    !props.busy &&
    !props.disabled &&
    !!name.value.trim() &&
    name.value.trim().length <= 128 &&
    name.value.trim() !== (props.displayName ?? ""),
);

function submit(): void {
  if (canSave.value) emit("save", name.value.trim());
}
</script>

<template>
  <Card>
    <CardHeader
      ><CardTitle>{{ t("userAccount.editProfile") }}</CardTitle></CardHeader
    >
    <CardContent>
      <form class="flex flex-col gap-4" data-testid="account-profile-form" @submit.prevent="submit">
        <Field>
          <FieldLabel for="account-display-name">{{ t("userAccount.displayName") }}</FieldLabel>
          <Input id="account-display-name" v-model="name" maxlength="128" required autocomplete="nickname" :disabled="busy || disabled" />
          <FieldDescription>{{ t("userAccount.profileHint") }}</FieldDescription>
        </Field>
        <GwButton type="submit" variant="primary" :disabled="!canSave" data-testid="account-save-profile">{{
          t("userAccount.saveProfile")
        }}</GwButton>
      </form>
    </CardContent>
  </Card>
</template>
