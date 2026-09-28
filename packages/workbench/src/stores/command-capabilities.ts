/**
 * 命令能力表：本宿主「哪条命令真的可调」（`/api/commands` 的 `available`）。
 *
 * 为什么是 store：目录是**宿主进程级**的静态事实（桌面专属集合随包走、服务端黑名单
 * 在启动配置里），一次会话取一次就够。预览决策、设置面板、启动期同步都要用，放一处
 * 省得各写一遍缓存与降级。
 *
 * **unknown ≠ deny**：目录拉不到（非服务端态、HTTP 失败）时 `available()` 回 null，
 * 调用方应按「未知」处理 —— 宁可放行让命令端点自己报错，也不要因为一次查询失败就让
 * 本来能用的功能全禁掉。唯一例外是「已知服务端禁用」的写路径（见 agent 目录同步）：
 * 那里 unknown 按不可写，因为禁用是服务端的确定性行为，赌 fail-open 每次都是一次
 * 必然的报错。
 */
import { loadCommandCatalog, runtimeMode, type CommandCatalogEntry } from "@greywork/host-ipc";
import { defineStore } from "pinia";
import { ref } from "vue";

export const useCommandCapabilitiesStore = defineStore("command-capabilities", () => {
  /** 命令名 → 能力描述；空表 = 尚未拉到。 */
  const entries = ref<Map<string, CommandCatalogEntry>>(new Map());
  /** 是否已结束本轮拉取（成功与否都算）；false = 未知。 */
  const loaded = ref(false);

  /** 在飞的拉取（去重：启动同步与设置面板可能同时开口）。 */
  let inflight: Promise<void> | null = null;

  /** 确保目录就位。非服务端态立即返回；HTTP 失败也标记 loaded（本轮不再重试）。 */
  function ensureCatalog(): Promise<void> {
    if (loaded.value || runtimeMode() !== "server") return Promise.resolve();
    inflight ??= loadCommandCatalog()
      .then((catalog) => {
        if (catalog) entries.value = new Map(catalog.map((entry) => [entry.name, entry]));
        loaded.value = true;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  /**
   * 本宿主能否调用该命令：true/false；**null = 未知**（未加载 / 不在目录里），
   * 语义由调用方决定（读路径 fail-open，服务端写路径 fail-closed，见模块注释）。
   */
  function available(name: string): boolean | null {
    return entries.value.get(name)?.available ?? null;
  }

  // 首用即拉：store 第一次被实例化就发请求（仅服务端态），之后会话内不重复。
  void ensureCatalog();

  return { loaded, ensureCatalog, available };
});
