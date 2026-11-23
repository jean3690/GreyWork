<script setup lang="ts">
import { computed } from "vue";
import type { PublicPreferences } from "@/lib/preferences-sync";
import { i18n } from "@/i18n";
const t = i18n.global.t;
const props = defineProps<{ local: PublicPreferences; cloud: PublicPreferences | null }>();
const fields = ["theme", "colorMode", "fontSize", "radius", "locale"] as const;
const rows = computed(() =>
  fields.map((key) => ({ key, label: t(`preferencesSync.fields.${key}`), local: props.local[key], cloud: props.cloud?.[key] ?? "—" })),
);
</script>

<template>
  <table class="w-full text-left text-[11px]" data-testid="preferences-sync-comparison">
    <thead class="text-dim2">
      <tr>
        <th class="py-1 font-normal">{{ t("preferencesSync.field") }}</th>
        <th class="font-normal">{{ t("preferencesSync.local") }}</th>
        <th class="font-normal">{{ t("preferencesSync.cloud") }}</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="row in rows" :key="row.key" class="border-t border-line">
        <td class="py-1.5 text-dim2">{{ row.label }}</td>
        <td class="font-mono text-foreground">{{ row.local }}</td>
        <td class="font-mono" :class="row.local === row.cloud ? 'text-dim2' : 'text-accent'">{{ row.cloud }}</td>
      </tr>
    </tbody>
  </table>
</template>
