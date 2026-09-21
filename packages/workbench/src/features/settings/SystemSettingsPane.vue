<script setup lang="ts">
/** 设置 · system 分区：关于宿主诊断 + 沙盒档位。 */
import { computed, onMounted, ref } from "vue";
import Icon from "@/features/shared/Icon.vue";
import { systemBackend, type SysInfo } from "@/lib/system-backend";
import { SANDBOX_MODES, useSettingsStore } from "@/stores/settings";
import { PERM_TIER_LABELS, SANDBOX_DESCS, SANDBOX_LABELS, usePermissionSandbox } from "@/lib/permission-sandbox";
import { i18n } from "@/i18n";

const settings = useSettingsStore();
/** 设置面板不装 i18n 插件也要能渲染（测试直接 mount），故用全局实例而非 useI18n。 */
const t = i18n.global.t;
const { suggestedSandbox, applySandboxMode } = usePermissionSandbox();

/** 系统诊断快照（桌面态从 Rust 拉取；浏览器态 null）。 */
const sysInfo = ref<SysInfo | null>(null);
const sysInfoFailed = ref(false);

/**
 * 本机是否没有可用的 OS 沙盒。
 *
 * bwrap 只有 Linux 有：Windows/macOS 上任何档位都会被宿主降级为「关闭」（只记日志），
 * 这里必须把这件事说出来 —— 否则用户会以为自己处在隔离里。浏览器预览态（sysInfo 为
 * null）不判断，避免误报。
 */
const sandboxUnavailable = computed(() => sysInfo.value !== null && sysInfo.value.os !== "linux");

/**
 * 托盘不可用：浏览器预览态（没有宿主）或宿主明确回报没建出托盘。
 *
 * sysInfo 还是 null（加载中 / 拉取失败）时按「可用」渲染 —— 拿不准就别把正常机器
 * 误判成没托盘，宿主侧本来也会兜底钳制。
 */
const trayUnavailable = computed(() => !systemBackend.active() || sysInfo.value?.trayAvailable === false);

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
      <p
        v-if="sandboxUnavailable"
        class="mt-3 border-t border-line-2 pt-3 text-[11px] leading-[1.6] text-dim"
        data-testid="sandbox-unavailable"
      >
        OS 沙盒依赖 Linux 的 bwrap，当前宿主（{{ sysInfo?.os }}）不可用：任何档位都会在启动 agent 时降级为「关闭」。
        权限档位仍然生效，但进程不再有 OS 级隔离。
      </p>
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
    <!-- 关闭行为：宿主侧拦截 CloseRequested 的依据，经 lib/tray-bridge 同步过去。 -->
    <div class="rounded-[14px] border border-line bg-panel p-4">
      <div class="mb-1 text-[13px] font-medium text-foreground">{{ t("settings.tray.title") }}</div>
      <p class="mb-3 text-[11px] leading-[1.6] text-dim2">{{ t("settings.tray.description") }}</p>
      <!-- 没有托盘（浏览器预览态 / Linux 缺 AppIndicator 宿主）时两个档位都无效：宿主会把
           关闭行为钳回「关闭即退出」（否则窗口藏起来后没有入口恢复），这里若还给选就是
           一个骗人的开关。sysInfo 未返回前按可用渲染，避免加载期闪一下。 -->
      <p
        v-if="trayUnavailable"
        data-testid="tray-unavailable"
        class="rounded-[10px] bg-panel-2 px-3 py-2 text-[11px] leading-[1.6] text-dim2"
      >
        {{ t("settings.tray.unavailable") }}
      </p>
      <div v-else class="flex flex-col gap-1.5">
        <button
          type="button"
          data-testid="tray-close-to-tray"
          class="flex cursor-pointer items-start justify-between gap-3 rounded-[10px] px-3 py-2 text-left transition-colors hover:bg-panel-2"
          :class="settings.closeToTray ? 'bg-panel-2' : ''"
          :aria-pressed="settings.closeToTray"
          @click="settings.setCloseToTray(true)"
        >
          <span class="min-w-0">
            <span class="block text-[13px] text-foreground">{{ t("settings.tray.closeToTray.label") }}</span>
            <span class="block text-[11px] leading-[1.5] text-dim2">{{ t("settings.tray.closeToTray.desc") }}</span>
          </span>
          <Icon :name="settings.closeToTray ? 'check-one' : 'close-one'" :size="14" class="mt-0.5 shrink-0 text-dim" />
        </button>
        <button
          type="button"
          data-testid="tray-quit-on-close"
          class="flex cursor-pointer items-start justify-between gap-3 rounded-[10px] px-3 py-2 text-left transition-colors hover:bg-panel-2"
          :class="settings.closeToTray ? '' : 'bg-panel-2'"
          :aria-pressed="!settings.closeToTray"
          @click="settings.setCloseToTray(false)"
        >
          <span class="min-w-0">
            <span class="block text-[13px] text-foreground">{{ t("settings.tray.quitOnClose.label") }}</span>
            <span class="block text-[11px] leading-[1.5] text-dim2">{{ t("settings.tray.quitOnClose.desc") }}</span>
          </span>
          <Icon :name="settings.closeToTray ? 'close-one' : 'check-one'" :size="14" class="mt-0.5 shrink-0 text-dim" />
        </button>
      </div>
    </div>
  </div>
</template>
