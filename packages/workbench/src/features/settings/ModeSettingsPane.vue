<script setup lang="ts">
/** 设置 · mode 分区：运行模式 / 权限档位（含临时只读）。 */
import { useI18n } from "vue-i18n";
import { useAgentStore } from "@/stores/agent";
import { PERMISSION_TIERS, RUN_MODES, useSettingsStore } from "@/stores/settings";
import { PERM_TIER_DESCS, PERM_TIER_LABELS, SANDBOX_LABELS, usePermissionSandbox } from "@/lib/permission-sandbox";
import WorktreeSnapshotsCard from "@/features/settings/WorktreeSnapshotsCard.vue";

const settings = useSettingsStore();
const agent = useAgentStore();
const { suggestedSandbox } = usePermissionSandbox();
// 运行模式的 hint 是 i18n key（RUN_MODES 存 key、渲染处转译，同 AppearanceSettingsPane 的 FONT_SIZES）；
// 本 pane 其余权限 / 沙盒文案仍走 permission-sandbox 的字面量，不在此次转 i18n 的范围内。
const { t } = useI18n();

function applyPermissionTier(tier: (typeof PERMISSION_TIERS)[number]["value"]): void {
  settings.permissionTier = tier;
  settings.persist();
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="rounded-[14px] border border-line bg-panel p-4">
      <div class="mb-3 text-[13px] font-medium text-foreground">运行模式</div>
      <div class="flex flex-col gap-1.5">
        <button
          v-for="mode in RUN_MODES"
          :key="mode.value"
          :data-testid="`run-mode-${mode.value}`"
          class="flex cursor-pointer items-center gap-3 rounded-[10px] px-3 py-2 text-left transition-colors hover:bg-panel-2"
          :class="settings.runMode === mode.value ? 'bg-panel-2' : ''"
          @click="settings.setRunMode(mode.value)"
        >
          <span class="text-[13px] text-foreground">{{ mode.label }}</span>
          <span class="text-[11px] text-dim2">{{ t(mode.hint) }}</span>
        </button>
      </div>
      <p v-if="settings.runMode === 'worktree'" class="mt-2 text-[11px] leading-relaxed text-amber-400">
        本轮会话跑在快照里：agent 的写入不会出现在工作区文件树 / Git 面板。跑完在下面的「隔离快照」里释放。
      </p>
    </div>
    <WorktreeSnapshotsCard />
    <div class="rounded-[14px] border border-line bg-panel p-4">
      <div class="mb-3 text-[13px] font-medium text-foreground">权限档位</div>
      <div class="flex gap-2">
        <button
          v-for="tier in PERMISSION_TIERS"
          :key="tier.value"
          class="flex flex-1 cursor-pointer flex-col gap-1 rounded-[10px] border border-line px-3 py-2.5 text-left transition-colors"
          :class="settings.permissionTier === tier.value ? 'bg-panel-2' : 'hover:bg-panel-2'"
          :aria-pressed="settings.permissionTier === tier.value"
          @click="applyPermissionTier(tier.value)"
        >
          <span class="text-[12px] font-medium text-foreground">{{ PERM_TIER_LABELS[tier.value] }}</span>
          <span class="text-[11px] leading-[1.5] text-dim2">{{ PERM_TIER_DESCS[tier.value] }}</span>
        </button>
      </div>
      <p v-if="settings.permissionTier === 'full'" class="mt-2 text-[11px] text-amber-400">
        完全访问不设工作区边界：agent 可读写任意路径。建议配合沙盒「{{
          SANDBOX_LABELS[suggestedSandbox]
        }}」，或用下面的临时只读跑高风险回合。
      </p>
      <label class="mt-3 flex cursor-pointer items-center justify-between gap-3 border-t border-line-2 pt-3">
        <span>
          <span class="block text-[13px] font-medium text-foreground">临时只读</span>
          <span class="block text-[11px] text-dim2">在途会话立即降为只读，跑完再关掉回到基线档位（不持久化）</span>
        </span>
        <input
          v-model="settings.tempReadOnly"
          data-testid="temp-readonly-toggle"
          type="checkbox"
          class="size-4 cursor-pointer accent-[var(--accent)]"
          aria-label="临时只读"
          @change="void agent.applyPermissionTier()"
        />
      </label>
      <p class="mt-2 text-[11px] text-dim">
        当前生效档位：{{ PERM_TIER_LABELS[settings.effectivePermissionTier] }}
        <span v-if="settings.tempReadOnly">（基线 {{ PERM_TIER_LABELS[settings.permissionTier] }} 已临时降级）</span>
      </p>
    </div>
  </div>
</template>
