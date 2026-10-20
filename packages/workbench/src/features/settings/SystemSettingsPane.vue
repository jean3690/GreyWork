<script setup lang="ts">
/** 设置 · system 分区：关于宿主诊断 + 托盘 / 关闭行为。 */
import { computed, onMounted, ref } from "vue";
import Icon from "@/features/shared/Icon.vue";
import { systemBackend, type SysInfo } from "@/lib/system-backend";
import { hasNativeShell, runtimeMode } from "@greywork/host-ipc";
import { useSettingsStore } from "@/stores/settings";
import { i18n } from "@/i18n";

const settings = useSettingsStore();
/** 设置面板不装 i18n 插件也要能渲染（测试直接 mount），故用全局实例而非 useI18n。 */
const t = i18n.global.t;

/** 系统诊断快照（桌面与服务端态从宿主拉取；浏览器预览态 null）。 */
const sysInfo = ref<SysInfo | null>(null);
const sysInfoFailed = ref(false);

/**
 * 关于卡的运行形态行：以前这里只能看到「版本」，说不清是桌面还是服务端。
 *
 * 判据用 `hasNativeShell()` 而不是 `runtimeMode() === "server"` —— Electron 壳跑的是 server
 * 态（命令经 sidecar），但对外它就是桌面应用，写成「自托管服务端」是误导。
 */
const runtimeLabel = computed(() => {
  if (hasNativeShell()) return "桌面应用";
  return runtimeMode() === "server" ? "自托管服务端" : "浏览器预览";
});

/** 关于卡没有数据时的占位：预览态是「本来就没有」，有宿主则只是还没拉到。 */
const aboutPlaceholder = computed(() => (systemBackend.active() ? "读取中…" : "浏览器预览：无宿主诊断面。"));

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
    <div class="rounded-[calc(14px*var(--gw-radius-scale))] border border-line bg-panel p-4">
      <div class="mb-3 text-[13px] font-medium text-foreground">关于</div>
      <div v-if="sysInfo" class="flex flex-col gap-1 font-mono text-[11px] text-dim2">
        <div class="flex justify-between">
          <span>版本</span><span class="text-foreground">{{ sysInfo.version }}</span>
        </div>
        <div class="flex justify-between">
          <span>运行形态</span><span class="text-foreground">{{ runtimeLabel }}</span>
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
        {{ sysInfoFailed ? "系统信息拉取失败（见控制台日志）" : aboutPlaceholder }}
      </div>
    </div>
    <!-- 沙盒档位已停用（agent 自带权限模型，宿主不再套 OS 沙箱），设置卡一并移除。 -->
    <!-- 关闭行为：宿主侧拦截 CloseRequested 的依据，经 lib/tray-bridge 同步过去。 -->
    <div class="rounded-[calc(14px*var(--gw-radius-scale))] border border-line bg-panel p-4">
      <div class="mb-1 text-[13px] font-medium text-foreground">{{ t("settings.tray.title") }}</div>
      <p class="mb-3 text-[11px] leading-[1.6] text-dim2">{{ t("settings.tray.description") }}</p>
      <!-- 没有托盘（浏览器预览态 / Linux 缺 AppIndicator 宿主）时两个档位都无效：宿主会把
           关闭行为钳回「关闭即退出」（否则窗口藏起来后没有入口恢复），这里若还给选就是
           一个骗人的开关。sysInfo 未返回前按可用渲染，避免加载期闪一下。 -->
      <p
        v-if="trayUnavailable"
        data-testid="tray-unavailable"
        class="rounded-[calc(10px*var(--gw-radius-scale))] bg-panel-2 px-3 py-2 text-[11px] leading-[1.6] text-dim2"
      >
        {{ t("settings.tray.unavailable") }}
      </p>
      <div v-else class="flex flex-col gap-1.5">
        <button
          type="button"
          data-testid="tray-close-to-tray"
          class="flex cursor-pointer items-start justify-between gap-3 rounded-[calc(10px*var(--gw-radius-scale))] px-3 py-2 text-left transition-colors hover:bg-panel-2"
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
          class="flex cursor-pointer items-start justify-between gap-3 rounded-[calc(10px*var(--gw-radius-scale))] px-3 py-2 text-left transition-colors hover:bg-panel-2"
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
