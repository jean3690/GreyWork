<script setup lang="ts">
/**
 * 权限档位胶囊（Read Only / Workspace / Full Access）——模型选择旁的操作范围控制。
 * 值即 settings.permissionTier（宿主 acp_host 按新三档语义执行）。
 * 切到 Full Access 必须经警告对话框二次确认。
 */
import { computed, nextTick, ref } from "vue";
import { usePanelPlacement } from "../lib/panel-placement";
import { PERMISSION_TIERS, useSettingsStore, type PermTier } from "../stores/settings";
import { useI18n } from "vue-i18n";
import Icon from "./Icon.vue";

const settings = useSettingsStore();
const { t } = useI18n();

const open = ref(false);
const rootEl = ref<HTMLElement | null>(null);
/** 触发按钮与菜单容器：菜单/对话框的焦点管理锚点。 */
const triggerEl = ref<HTMLButtonElement | null>(null);
const menuEl = ref<HTMLElement | null>(null);
const dialogEl = ref<HTMLElement | null>(null);
const dialogCancelEl = ref<HTMLButtonElement | null>(null);

/** 打开菜单后把焦点移进第一项：挂在 div 上的 keydown 才收得到后续 Esc/方向键。 */
function openMenu(): void {
  placePanel();
  open.value = true;
  void nextTick(() => {
    const first = menuEl.value?.querySelector<HTMLButtonElement>("button[role=menuitemradio]");
    first?.focus();
  });
}

function onMenuKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    open.value = false;
    triggerEl.value?.focus();
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  const items = Array.from(menuEl.value?.querySelectorAll<HTMLButtonElement>("button[role=menuitemradio]") ?? []);
  if (items.length === 0) return;
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
  items[next]?.focus();
}

/** 打开确认框：焦点进「取消」；Escape 关闭；Tab 在框内循环；关闭后焦点还给触发按钮。 */
function onDialogKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    cancelFull();
    return;
  }
  if (event.key !== "Tab" || !dialogEl.value) return;
  const focusables = Array.from(
    dialogEl.value.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
  ).filter((element) => !element.hasAttribute("disabled"));
  if (focusables.length === 0) return;
  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !dialogEl.value.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

function openFullConfirm(): void {
  pendingFull.value = true;
  confirmingFull.value = true;
  void nextTick(() => dialogCancelEl.value?.focus());
}

/** 面板估算高：每档一项约 60px（档位名 + 两行说明）+ 内边距与边框 12；实测 zh-CN 三档 ≈184。 */
const { openUp, alignLeft, place: placePanel } = usePanelPlacement(rootEl, PERMISSION_TIERS.length * 60 + 12, 200);

/** Full Access 确认对话框（pendingFull 为 true 且值合法才提交）。 */
const confirmingFull = ref(false);
const pendingFull = ref(false);

const current = computed(() => PERMISSION_TIERS.find((tier) => tier.value === settings.permissionTier) ?? PERMISSION_TIERS[0]);

const currentLabel = computed(() => t(current.value.label));

function toggle(): void {
  if (open.value) {
    open.value = false;
    triggerEl.value?.focus();
    return;
  }
  openMenu();
}

function choose(value: PermTier): void {
  if (value === settings.permissionTier) {
    open.value = false;
    return;
  }
  open.value = false;
  triggerEl.value?.focus();
  if (value === "full") {
    openFullConfirm();
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
  // 焦点还给触发胶囊（键盘用户回到打开前的落点）。
  void nextTick(() => triggerEl.value?.focus());
}
</script>

<template>
  <div ref="rootEl" class="relative">
    <button
      ref="triggerEl"
      type="button"
      class="flex h-6 cursor-pointer items-center gap-1 rounded-full border border-line bg-panel-2 px-2.5 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
      :aria-haspopup="'menu'"
      :aria-expanded="open"
      @click="toggle"
    >
      <Icon name="shield" :size="11" class="text-dim" />
      <span class="max-w-[140px] truncate whitespace-nowrap">权限 · {{ currentLabel }}</span>
      <Icon name="down" :size="10" class="text-dim2" />
    </button>

    <div
      v-if="open"
      ref="menuEl"
      role="menu"
      class="absolute z-40 w-[200px] rounded-[10px] border border-line bg-popover p-1 shadow-lg"
      :class="[openUp ? 'bottom-full mb-1' : 'top-full mt-1', alignLeft ? 'left-0' : 'right-0']"
      @keydown="onMenuKeydown"
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
      ref="dialogEl"
      class="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      :aria-label="t('settings.permissions.fullConfirmTitle')"
      @keydown="onDialogKeydown"
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
            ref="dialogCancelEl"
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
