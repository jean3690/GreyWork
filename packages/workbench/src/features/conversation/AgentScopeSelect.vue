<script setup lang="ts">
/**
 * 权限档位胶囊（Read Only / Workspace / Full Access）——模型选择旁的操作范围控制。
 * 值即 settings.permissionTier（宿主 acp_host 按新三档语义执行）。
 * 切到 Full Access 必须经警告对话框二次确认。
 */
import { computed, ref } from "vue";
import { PERMISSION_TIERS, useSettingsStore, type PermTier } from "@/stores/settings";
import { useI18n } from "vue-i18n";
import Icon from "@/features/shared/Icon.vue";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const settings = useSettingsStore();
const { t } = useI18n();

const open = ref(false);
/** 触发胶囊：确认框关闭后焦点归位的锚点。 */
const triggerEl = ref<HTMLButtonElement | null>(null);

/**
 * 档位菜单已交给 DropdownMenu：Esc / 点外部收回、方向键漫游、aria-checked 与
 * menuitemradio 语义都由它负责，原先那份手写 keydown 与 usePanelPlacement 上下翻转已删。
 */
function openFullConfirm(): void {
  pendingFull.value = true;
  confirmingFull.value = true;
}

/** 确认框统一关闭路径（Esc / 取消按钮 / 点叉都经 update:open）。 */
function onConfirmOpenChange(next: boolean): void {
  if (next) return;
  pendingFull.value = false;
  confirmingFull.value = false;
}

/** Full Access 确认对话框（pendingFull 为 true 且值合法才提交）。 */
const confirmingFull = ref(false);
const pendingFull = ref(false);

const current = computed(() => PERMISSION_TIERS.find((tier) => tier.value === settings.permissionTier) ?? PERMISSION_TIERS[0]);

const currentLabel = computed(() => t(current.value.label));

/**
 * 只处理选中语义 —— 菜单的开合/焦点归位由 DropdownMenuTrigger 自己管。
 *
 * 「完全访问」先弹确认框、确认后才改档：这条路径不能走 RadioGroup 的 v-model，
 * 否则选中即写 store，警告框就形同虚设。所以模板里 RadioGroup 只吃单向 model-value
 * （指示器反映 store 的真值），落库一律经这里。
 */
function choose(value: PermTier): void {
  if (value === settings.permissionTier) return;
  // 先把焦点放回胶囊：紧接着弹出确认框，其「关闭后归位」锚点就是此刻的焦点元素。
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
</script>

<template>
  <div class="relative">
    <DropdownMenu v-model:open="open">
      <DropdownMenuTrigger as-child>
        <button
          ref="triggerEl"
          type="button"
          class="flex h-6 cursor-pointer items-center gap-1 rounded-full border border-line bg-panel-2 px-2.5 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
        >
          <Icon name="shield" :size="11" class="text-dim" />
          <span class="max-w-[140px] truncate whitespace-nowrap">权限 · {{ currentLabel }}</span>
          <Icon name="down" :size="10" class="text-dim2" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" class="w-[200px] border-line">
        <!-- 单向 model-value：指示器跟着 store 走，但选中不直接落库（见 choose 的注释）。 -->
        <DropdownMenuRadioGroup :model-value="settings.permissionTier">
          <DropdownMenuRadioItem
            v-for="tier in PERMISSION_TIERS"
            :key="tier.value"
            :value="tier.value"
            class="cursor-pointer items-start gap-2 rounded-[6px] py-1.5 pr-2 pl-2 text-[12px]"
            :class="settings.permissionTier === tier.value ? 'text-foreground' : 'text-dim'"
            @select="choose(tier.value)"
          >
            <!-- 内置指示器是绝对定位居中的圆点，与本项目「勾选贴首行」的两行版式不合，这里留空，
                 改用在流内的自绘图标（与迁移前一致）。 -->
            <template #indicator-icon><span></span></template>
            <Icon :name="settings.permissionTier === tier.value ? 'check-one' : 'circle'" :size="11" class="mt-0.5 shrink-0 text-dim" />
            <span class="min-w-0">
              <span class="block text-[12px] font-medium">{{ t(tier.label) }}</span>
              <span class="block text-[10.5px] leading-snug text-dim2">{{ t(tier.desc) }}</span>
            </span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>

    <!-- Full Access 警告对话框 -->
    <AlertDialog :open="confirmingFull" @update:open="onConfirmOpenChange">
      <AlertDialogContent class="max-w-[380px] gap-0 rounded-[14px] border-line bg-popover p-4 shadow-xl sm:max-w-[380px]">
        <div class="flex items-start gap-2.5">
          <span class="grid size-8 shrink-0 place-items-center rounded-[9px] bg-amber/15 text-amber">
            <Icon name="shield" :size="16" />
          </span>
          <div class="min-w-0">
            <AlertDialogTitle class="text-[14px] font-semibold text-foreground">
              {{ t("settings.permissions.fullConfirmTitle") }}
            </AlertDialogTitle>
            <AlertDialogDescription class="mt-1 text-[12px] leading-relaxed text-dim">
              {{ t("settings.permissions.fullConfirmBody") }}
            </AlertDialogDescription>
          </div>
        </div>
        <div class="mt-4 flex justify-end gap-2">
          <!-- dark: 三连不是冗余：AlertDialogCancel 内层是 outline 变体，带 dark:bg-input/30 等，
               而 dark 变体特异性 (0,2,0) 高于无变体的 bg-panel-2 (0,1,0)。 -->
          <AlertDialogCancel
            type="button"
            class="h-8 cursor-pointer rounded-[8px] border border-line bg-panel-2 px-3 text-[12px] text-dim shadow-none transition-colors hover:border-line-2 hover:bg-panel-2 hover:text-foreground dark:border-line dark:bg-panel-2 dark:hover:bg-panel-2"
          >
            {{ t("settings.permissions.fullConfirmCancel") }}
          </AlertDialogCancel>
          <button
            type="button"
            class="h-8 cursor-pointer rounded-[8px] bg-amber px-3 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
            @click="confirmFull"
          >
            {{ t("settings.permissions.fullConfirmOk") }}
          </button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
