<script setup lang="ts">
/** 只组合同步状态、比较表与确认弹窗；网络和版本基线属于 composable。 */
import { onMounted, shallowRef, watch } from "vue";
import type { PreferencesSnapshot } from "@/lib/preferences-sync";
import ConfirmDialog from "@/features/settings/ConfirmDialog.vue";
import PreferencesSyncComparison from "./PreferencesSyncComparison.vue";
import { usePreferencesSync } from "./usePreferencesSync";
import { i18n } from "@/i18n";
const t = i18n.global.t;
const sync = usePreferencesSync();
const confirmation = shallowRef<{ kind: "cloud" | "local"; snapshot: PreferencesSnapshot; fingerprint: string } | null>(null);
watch(
  sync.identity,
  () => {
    confirmation.value = null;
  },
  { flush: "sync" },
);
onMounted(() => {
  if (sync.ready.value) void sync.inspect();
});
function ask(kind: "cloud" | "local"): void {
  if (!sync.remote.value || sync.busy.value) return;
  confirmation.value = { kind, snapshot: sync.remote.value, fingerprint: sync.fingerprint.value };
}
async function confirm(): Promise<void> {
  const selected = confirmation.value;
  if (!selected) return;
  confirmation.value = null;
  if (selected.kind === "cloud") await sync.useCloud(selected.snapshot, selected.fingerprint);
  else await sync.keepLocal(selected.snapshot, selected.fingerprint);
}
</script>

<template>
  <section class="rounded-[calc(14px*var(--gw-radius-scale))] border border-line bg-panel p-4" data-testid="preferences-sync-pane">
    <div class="mb-2 flex items-center justify-between gap-2">
      <h2 class="text-[13px] font-medium text-foreground">{{ t("preferencesSync.title") }}</h2>
      <span class="text-[10.5px] text-dim2">{{
        sync.busy.value ? t("preferencesSync.busy") : sync.dirty.value ? t("preferencesSync.pending") : t("preferencesSync.synced")
      }}</span>
    </div>
    <p class="mb-3 text-[11px] leading-relaxed text-dim2">{{ t("preferencesSync.description") }}</p>
    <p v-if="!sync.ready.value" class="text-[11px] text-dim2">{{ t("preferencesSync.loginHint") }}</p>
    <template v-else>
      <PreferencesSyncComparison :local="sync.local.value" :cloud="sync.remote.value?.payload ?? null" />
      <p class="mt-2 break-all font-mono text-[10px] text-dim2">
        {{ t("preferencesSync.baseline") }}：{{ sync.baseline.value?.revision ?? t("preferencesSync.none") }} ·
        {{ t("preferencesSync.cloudVersion") }}：{{
          sync.remote.value ? (sync.remote.value.revision ?? t("preferencesSync.none")) : t("preferencesSync.unknown")
        }}
      </p>
      <p
        v-if="sync.conflict.value || sync.remoteChanged.value"
        class="mt-2 text-[11px] text-accent"
        data-testid="preferences-sync-conflict"
      >
        {{ t("preferencesSync.conflict") }}
      </p>
      <div class="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          class="rounded-[calc(8px*var(--gw-radius-scale))] border border-line px-2.5 py-1.5 text-[11px] text-dim disabled:opacity-50"
          :disabled="sync.busy.value"
          data-testid="preferences-sync-check"
          @click="sync.inspect"
        >
          {{ t("preferencesSync.check") }}
        </button>
        <button
          type="button"
          class="rounded-[calc(8px*var(--gw-radius-scale))] bg-accent px-2.5 py-1.5 text-[11px] text-accent-ink disabled:opacity-50"
          :disabled="sync.busy.value || !sync.dirty.value"
          data-testid="preferences-sync-push"
          @click="sync.pushLocal"
        >
          {{ t("preferencesSync.push") }}
        </button>
        <button
          v-if="sync.remote.value?.payload"
          type="button"
          class="rounded-[calc(8px*var(--gw-radius-scale))] border border-line px-2.5 py-1.5 text-[11px] text-dim disabled:opacity-50"
          :disabled="sync.busy.value"
          data-testid="preferences-sync-use-cloud"
          @click="ask('cloud')"
        >
          {{ t("preferencesSync.apply") }}
        </button>
        <button
          v-if="sync.remote.value && (sync.conflict.value || sync.remoteChanged.value)"
          type="button"
          class="rounded-[calc(8px*var(--gw-radius-scale))] border border-line px-2.5 py-1.5 text-[11px] text-destructive disabled:opacity-50"
          :disabled="sync.busy.value"
          data-testid="preferences-sync-keep-local"
          @click="ask('local')"
        >
          {{ t("preferencesSync.keep") }}
        </button>
      </div>
    </template>
    <p v-if="sync.error.value" class="mt-2 text-[11px] text-destructive" data-testid="preferences-sync-error">{{ sync.error.value }}</p>
    <p v-if="sync.notice.value" class="mt-2 text-[11px] text-dim2" data-testid="preferences-sync-notice">{{ sync.notice.value }}</p>
    <ConfirmDialog
      v-if="confirmation"
      :title="confirmation.kind === 'cloud' ? t('preferencesSync.applyTitle') : t('preferencesSync.keepTitle')"
      :message="confirmation.kind === 'cloud' ? t('preferencesSync.applyHint') : t('preferencesSync.keepHint')"
      :confirm-label="confirmation.kind === 'cloud' ? t('preferencesSync.confirmApply') : t('preferencesSync.confirmKeep')"
      :busy="sync.busy.value"
      @confirm="confirm"
      @cancel="confirmation = null"
    />
  </section>
</template>
