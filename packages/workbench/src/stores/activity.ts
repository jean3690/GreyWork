import { createJsonStorage } from "@greywork/core";
import { defineStore } from "pinia";
import { ref } from "vue";

/**
 * 底部活动面板的宿主状态：展开 + 激活页签 + 可用性。
 *
 * store 是**哑 pref 持有者**：不订阅事件、不校验 loader、不解析贡献列表——
 * 面板贡献来自 seam，由 ActivityBand 在 computed 里过滤分区；持久化的 active
 * 失效时由显示层（resolveActiveTab）回退，store 只在用户点击后才重写存档。
 */
interface ActivityPrefs {
  open: boolean;
  /** 激活页签 id（如 "activity.artifacts"）；null = 未选过，由显示层取首个常驻。 */
  active: string | null;
}

function isPrefs(value: unknown): value is ActivityPrefs {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.open === "boolean" && (record.active === null || typeof record.active === "string");
}

const prefsStorage = createJsonStorage<ActivityPrefs>("greywork.activity.band", isPrefs);

export const useActivityStore = defineStore("activity", () => {
  const savedPrefs = prefsStorage.read();
  /** 默认收起：没有内容时底部带只是占位；用户从标题栏按钮展开。 */
  const open = ref(savedPrefs?.open ?? false);
  const activeTabId = ref<string | null>(savedPrefs?.active ?? null);
  /**
   * 当前视口是否渲染活动面板（窄屏不渲染）。
   *
   * 由 Shell 的视口同步回灌，与 preview.available 同一来源、同一断点 ——
   * 标题栏开关与宿主都读它，不再各写一处阈值（预览面板在这上面吃过两处断点漂移的亏）。
   */
  const available = ref(true);

  function persist(): void {
    prefsStorage.write({ open: open.value, active: activeTabId.value });
  }

  function setOpen(value: boolean): void {
    open.value = value;
    persist();
  }

  function toggle(): void {
    setOpen(!open.value);
  }

  /** 只收用户点击或显示层解析回退后的 id；不做存在性校验。 */
  function activate(id: string): void {
    activeTabId.value = id;
    persist();
  }

  /** 窄屏可用性回灌：不动 open 偏好（与 preview.setAvailable 同语义）。 */
  function setAvailable(value: boolean): void {
    available.value = value;
  }

  return { open, activeTabId, available, setOpen, toggle, activate, setAvailable };
});
