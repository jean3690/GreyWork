<script setup lang="ts">
/** 设置 · system 分区：关于宿主诊断 + 沙盒档位。 */
import { onMounted, ref } from "vue";
import Icon from "@/features/shared/Icon.vue";
import { systemBackend, type SysInfo } from "@/lib/system-backend";
import { SANDBOX_MODES, useSettingsStore } from "@/stores/settings";
import { PERM_TIER_LABELS, SANDBOX_DESCS, SANDBOX_LABELS, usePermissionSandbox } from "@/lib/permission-sandbox";

const settings = useSettingsStore();
const { suggestedSandbox, applySandboxMode } = usePermissionSandbox();

/** 系统诊断快照（桌面态从 Rust 拉取；浏览器态 null）。 */
const sysInfo = ref<SysInfo | null>(null);
const sysInfoFailed = ref(false);

onMounted(() => {
  if (!systemBackend.active()) return;
  void systemBackend
    .info()
    .then((info) => {
      sysInfo.value = info;
    })
    .catch((error: unknown) => {
      sysInfoFailed.value = true;
      console.error("[settings] 系统信息拉取失败", error);
    });
});
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="rounded-[14px] border border-line bg-panel p-4">
      <div class="mb-3 text-[13px] font-medium text-foreground">关于</div>
      <div v-if="sysInfo" class="flex flex-col gap-1 font-mono text-[11px] text-dim2">
        <div class="flex justify-between">
          <span>版本</span><span class="text-foreground">{{ sysInfo.version }}</span>
        </div>
        <div class="flex justify-between">
          <span>数据 schema</span><span class="text-foreground">v{{ sysInfo.schemaVersion }}</span>
        </div>
        <div class="flex justify-between">
          <span>活跃 ACP 后端</span><span class="text-foreground">{{ sysInfo.activeAgents }}</span>
        </div>
        <div class="flex justify-between">
          <span>宿主 OS</span><span class="text-foreground">{{ sysInfo.os }}</span>
        </div>
        <div v-if="sysInfo.logDir" class="mt-1 flex flex-col gap-0.5">
          <span>日志目录</span>
          <span class="break-all text-dim">{{ sysInfo.logDir }}</span>
        </div>
      </div>
      <div v-else class="text-[11px] text-dim2">
        {{ sysInfoFailed ? "系统信息拉取失败（见控制台日志）" : "浏览器预览：无宿主诊断面。" }}
      </div>
    </div>
    <div class="rounded-[14px] border border-line bg-panel p-4">
      <div class="mb-1 text-[13px] font-medium text-foreground">沙盒</div>
      <p class="mb-3 text-[11px] leading-[1.6] text-dim2">
        沙盒档位与权限档位是两条独立边界：权限三档是宿主在 ACP 工具调用层的<b class="font-medium text-dim">授权</b>判定（越界直接拒），
        沙盒档位是 bwrap 在 <b class="font-medium text-dim">OS 层</b>的隔离（进程连看都看不到）。两者互不替代 —— 「完全访问 +
        沙盒关闭」等于没有任何边界。
      </p>
      <div class="flex flex-col gap-1.5">
        <button
          v-for="mode in SANDBOX_MODES"
          :key="mode.value"
          class="flex cursor-pointer items-start justify-between gap-3 rounded-[10px] px-3 py-2 text-left transition-colors hover:bg-panel-2"
          :class="settings.sandboxMode === mode.value ? 'bg-panel-2' : ''"
          :aria-pressed="settings.sandboxMode === mode.value"
          @click="applySandboxMode(mode.value)"
        >
          <span class="min-w-0">
            <span class="block text-[13px] text-foreground">{{ SANDBOX_LABELS[mode.value] }}</span>
            <span class="block text-[11px] leading-[1.5] text-dim2">{{ SANDBOX_DESCS[mode.value] }}</span>
          </span>
          <Icon :name="settings.sandboxMode === mode.value ? 'check-one' : 'close-one'" :size="14" class="mt-0.5 shrink-0 text-dim" />
        </button>
      </div>
      <div v-if="settings.sandboxMode !== suggestedSandbox" class="mt-3 flex items-center gap-2 border-t border-line-2 pt-3">
        <span class="min-w-0 flex-1 text-[11px] text-dim">
          当前权限档位「{{ PERM_TIER_LABELS[settings.permissionTier] }}」建议沙盒「{{ SANDBOX_LABELS[suggestedSandbox] }}」
        </span>
        <button
          type="button"
          data-testid="sandbox-recommend"
          class="flex h-7 shrink-0 cursor-pointer items-center rounded-[8px] border border-line-2 bg-panel-2 px-3 text-[12px] text-foreground transition-colors hover:border-cyan"
          @click="applySandboxMode(suggestedSandbox)"
        >
          按权限档位联动
        </button>
      </div>
    </div>
  </div>
</template>
