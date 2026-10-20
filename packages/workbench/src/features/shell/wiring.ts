/**
 * 宿主外壳级接线表：由前端声明（`FrontShellSpec.wiring`）决定装哪几条。
 *
 * 为什么要有这个文件：这些接线原来散在 `Shell.vue` 的 `onMounted` 里无条件执行，
 * 于是 Web 端也会去订托盘事件、装关窗守卫 —— 既没有托盘也没有「点 X 关窗」这个动作，
 * 订阅纯属空转。搬出来之后，「这个宿主有没有这层集成」成了前端的一句声明。
 *
 * **两条时机的差别是真的，不是风格**：
 * - `setup`：必须在 mount 之前就位的那种。队列桥要在 store 触发补发之前挂好，
 *   否则补发会走错分支（见 `lib/queue-bridge.ts`）。
 * - `mount`：需要在组件挂载后才有意义的（要读 DOM / 订阅宿主事件）。
 * 调用方（Shell）在 setup 期、挂载前跑 `setup`，在 `onMounted` 跑 `mount`，
 * 卸载时统一调用返回的解绑函数。
 *
 * 注意 `setup` 里的 `watch()` 是在 **Shell 的 setup 作用域内**被调用的（Shell 同步调用本表），
 * 因此这些 watcher 正常绑定到 Shell 实例、随其卸载而停 —— 别把这里的调用挪进异步回调，
 * 那样 `getCurrentInstance()` 为 null，watcher 就永远不会被回收。
 */
import { watch } from "vue";
import { i18n } from "@/i18n";
import { useSettingsStore } from "@/stores/settings";
import { syncCloseToTray, syncTrayLabels, useTrayBridge, type TrayLabels } from "@/lib/tray-bridge";
import { useCloseGuard } from "@/lib/close-guard";
import { useHostNotifications } from "@/lib/host-notifications";
import { useQueueBridge } from "@/lib/queue-bridge";
import type { ShellWiringId } from "@/front/types";

/** 接线需要的应用内动作。由 Shell 提供 —— 它持有设置弹窗状态与会话创建。 */
export interface ShellWiringContext {
  onNewChat(): void;
  openSettings(): void;
}

export interface ShellWiring {
  setup?(ctx: ShellWiringContext): void;
  mount?(ctx: ShellWiringContext): (() => void) | void;
}

/**
 * 托盘菜单文案。宿主侧菜单是原生控件、不认 vue-i18n，所以每次切语言都要**整份重推**
 * （见 `lib/tray-bridge.ts` 的 syncTrayLabels）。别改成只推变化的字段：宿主拿不到 diff，
 * 它只会照最后一次收到的整份重建菜单。
 */
function currentTrayLabels(): TrayLabels {
  const t = i18n.global.t;
  return {
    toggleWindow: t("trayMenu.toggleWindow"),
    newChat: t("trayMenu.newChat"),
    settings: t("trayMenu.settings"),
    quit: t("trayMenu.quit"),
    hiddenHint: t("trayMenu.hiddenHint"),
  };
}

/**
 * 四条接线。键即 `ShellWiringId`，前端只能从这里挑 —— 加一条接线要同时加 id 与实现，
 * 漏了哪边都是编译错。
 */
export const SHELL_WIRINGS: Readonly<Record<ShellWiringId, ShellWiring>> = {
  /**
   * 命令队列的补发要经 dispatchIntent 分流（否则 ACP 会话的待发指令会走本地 LLM）。
   * 补发由 store 内触发，所以必须在 setup 期就位，不能等 onMounted。
   */
  queueBridge: {
    setup: () => useQueueBridge(),
  },

  /**
   * 系统托盘：菜单事件 → 应用内动作，另把「关闭到托盘」偏好与菜单文案同步给宿主。
   * 只有真的有窗口壳的宿主才有意义。
   */
  tray: {
    setup: () => {
      const settings = useSettingsStore();
      /**
       * 「关闭到托盘」同步给宿主：宿主在 CloseRequested 里读它决定拦不拦。
       * immediate 让默认 / 本地缓存值先落地；设置从 SQLite 水合完成后若真值不同会再触发一次，
       * 因此不会出现「偏好是关到托盘、宿主却按关闭即退出拦」的错配。
       * 宿主还会再叠一道可用性钳制：托盘没建出来时这个偏好不生效（否则窗口藏起来没入口恢复）。
       */
      watch(
        () => settings.closeToTray,
        (enabled) => void syncCloseToTray(enabled),
        { immediate: true },
      );
      // immediate 让启动时就落地，覆盖掉宿主构建菜单时用的那套占位文案。
      watch(
        () => i18n.global.locale.value,
        () => void syncTrayLabels(currentTrayLabels()),
        { immediate: true },
      );
    },
    // 宿主已先显示并聚焦窗口，订阅只是把菜单点击转成应用内动作。
    mount: (ctx) => useTrayBridge({ onNewChat: ctx.onNewChat, onOpenSettings: ctx.openSettings }),
  },

  /**
   * 关窗 / 退出守卫：拦下「有未保存改动」的退出，交给预览那套先保存再走。
   * 确认弹层的渲染点在 PreviewSider（它持有 saver 注册表，见 lib/close-guard.ts）。
   */
  closeGuard: {
    mount: () => useCloseGuard(),
  },

  /** 服务端的 `host://notify` → 系统通知（Electron 侧由主进程直接发，这里空转）。 */
  hostNotifications: {
    mount: () => useHostNotifications(),
  },
};
