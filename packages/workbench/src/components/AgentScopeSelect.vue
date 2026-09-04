<script setup lang="ts">
/**
 * 权限档位胶囊（Read Only / Workspace / Full Access）——模型选择旁的操作范围控制。
 * 值即 settings.permissionTier（宿主 acp_host 按新三档语义执行）。
 * 切到 Full Access 必须经警告对话框二次确认。
 */
import { computed, ref } from "vue";
import { usePanelPlacement } from "../lib/panel-placement";
import { PERMISSION_TIERS, useSettingsStore, type PermTier } from "../stores/settings";
import { useI18n } from "vue-i18n";
import Icon from "./Icon.vue";

const settings = useSettingsStore();
const { t } = useI18n();

const open = ref(false);
const rootEl = ref<HTMLElement | null>(null);

/** 面板估算高：每档一项约 60px（档位名 + 两行说明）+ 内边距与边框 12；实测 zh-CN 三档 ≈184。 */
const { openUp, place: placePanel } = usePanelPlacement(rootEl, PERMISSION_TIERS.length * 60 + 12);

/** Full Access 确认对话框（pendingFull 为 true 且值合法才提交）。 */
const confirmingFull = ref(false);
const pendingFull = ref(false);

const current = computed(() => PERMISSION_TIERS.find((tier) => tier.value === settings.permissionTier) ?? PERMISSION_TIERS[0]);

const currentLabel = computed(() => t(current.value.label));

function toggle(): void {
  if (open.value) {
    open.value = false;
    return;
  }
  placePanel();
  open.value = true;
}

function choose(value: PermTier): void {
  if (value === settings.permissionTier) {
    open.value = false;
    return;
  }
  open.value = false;
  if (value === "full") {
    pendingFull.value = true;
    confirmingFull.value = true;
    return;
  }
  settings.permissionTier = value;
  settings.persist();
}

function confirmFull(): void {
  if (pendingFull.value) {
    settings.permissionTier = "full";
    settings.persist();
  }
  pendingFull.value = false;
  confirmingFull.value = false;
}

function cancelFull(): void {
  pendingFull.value = false;
  confirmingFull.value = false;
}
</script>

<template>
  <div ref="rootEl" class="relative">
    <button
      type="button"
      class="flex h-6 cursor-pointer items-center gap-1 rounded-full border border-line bg-panel-2 px-2.5 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
      :aria-haspopup="'menu'"
      :aria-expanded="open"
      @click="toggle"
    >
      <Icon name="shield" :size="11" class="text-dim" />
      <span class="max-w-[110px] truncate whitespace-nowrap">{{ currentLabel }}</span>
      <Icon name="down" :size="10" class="text-dim2" />
    </button>

    <div
      v-if="open"
      class="absolute right-0 z-30 w-[200px] rounded-[10px] border border-line bg-popover p-1 shadow-lg"
      :class="openUp ? 'bottom-full mb-1' : 'top-full mt-1'"
      @keydown.esc.prevent="open = false"
    >
      <button
        v-for="tier in PERMISSION_TIERS"
        :key="tier.value"
        type="button"
        role="menuitemradio"
        :aria-checked="settings.permissionTier === tier.value"
        class="flex w-full cursor-pointer items-start gap-2 rounded-[6px] px-2 py-1.5 text-left transition-colors hover:bg-panel-2"
        :class="settings.permissionTier === tier.value ? 'text-foreground' : 'text-dim hover:text-foreground'"
        @click="choose(tier.value)"
      >
        <Icon :name="settings.permissionTier === tier.value ? 'check-one' : 'circle'" :size="11" class="mt-0.5 shrink-0 text-dim" />
        <span class="min-w-0">
          <span class="block text-[12px] font-medium">{{ t(tier.label) }}</span>
          <span class="block text-[10.5px] leading-snug text-dim2">{{ t(tier.desc) }}</span>
        </span>
      </button>
    </div>

    <!-- Full Access 警告对话框 -->
    <div
      v-if="confirmingFull"
      class="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      :aria-label="t('settings.permissions.fullConfirmTitle')"
      @click.self="cancelFull"
    >
      <div class="w-full max-w-[380px] rounded-[14px] border border-line bg-popover p-4 shadow-xl">
        <div class="flex items-start gap-2.5">
          <span class="grid size-8 shrink-0 place-items-center rounded-[9px] bg-amber/15 text-amber">
            <Icon name="shield" :size="16" />
          </span>
          <div class="min-w-0">
            <h2 class="text-[14px] font-semibold text-foreground">{{ t("settings.permissions.fullConfirmTitle") }}</h2>
            <p class="mt-1 text-[12px] leading-relaxed text-dim">{{ t("settings.permissions.fullConfirmBody") }}</p>
          </div>
        </div>
        <div class="mt-4 flex justify-end gap-2">
          <button
            type="button"
            class="h-8 cursor-pointer rounded-[8px] border border-line bg-panel-2 px-3 text-[12px] text-dim transition-colors hover:border-line-2 hover:text-foreground"
            @click="cancelFull"
          >
            {{ t("settings.permissions.fullConfirmCancel") }}
          </button>
          <button
            type="button"
            class="h-8 cursor-pointer rounded-[8px] bg-amber px-3 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
            @click="confirmFull"
          >
            {{ t("settings.permissions.fullConfirmOk") }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
