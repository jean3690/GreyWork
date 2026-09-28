/**
 * 云端 Office 的宿主事实（`office_host_info`）：可内嵌 origin 白名单 + 凭证变量是否已设置。
 *
 * 为什么要一个 store 而不是各组件各调一次：这两样都是**宿主进程级**的静态事实
 * （白名单在桌面写死在打包配置里、在服务端来自启动配置；环境变量在进程启动后不变），
 * 一次会话取一次就够。预览决策与设置面板都要用，放一处省得各写一遍缓存与降级。
 *
 * **取不到不等于「什么都不许内嵌」**：浏览器预览态没有宿主命令，宿主机也可能临时失败 ——
 * 这时 [originsLoaded] 保持 false，调用方据此**跳过**校验（当作未知），而不是把所有
 * 云端预览都判死。宁可放行一次让 CSP 去拦（浏览器控制台有报错），也不要因为一次查询失败
 * 就让本来能用的功能全不可用。
 */
import { hasHostCommands, invoke } from "@greywork/host-ipc";
import { defineStore } from "pinia";
import { ref } from "vue";

/** 与 `crates/greywork-host/src/office.rs` 的 `HostInfo` 对齐（camelCase）。 */
interface OfficeHostInfo {
  embeddableFrameOrigins?: string[];
  envPresent?: string[];
  envMissing?: string[];
}

export const useOfficeHostStore = defineStore("office-host", () => {
  /** 宿主 CSP 允许内嵌的 origin（已由宿主归一化）。 */
  const embeddableFrameOrigins = ref<string[]>([]);
  /** 已设置（非空）的凭证环境变量名。 */
  const envPresent = ref<string[]>([]);
  /** 声明了但未设置的凭证环境变量名 —— 设置面板据此提示「先 export」。 */
  const envMissing = ref<string[]>([]);
  /** 白名单是否已取到；false = 未知，调用方应跳过内嵌校验。 */
  const originsLoaded = ref(false);

  /** 在飞的白名单查询（去重：预览与设置面板可能同时开口）。 */
  let originsInflight: Promise<void> | null = null;

  function apply(info: OfficeHostInfo): void {
    embeddableFrameOrigins.value = info.embeddableFrameOrigins ?? [];
    originsLoaded.value = true;
  }

  /** 预览决策用：确保白名单已就位。浏览器预览态/查询失败 → 保持「未知」。 */
  async function ensureOrigins(): Promise<void> {
    if (originsLoaded.value || !hasHostCommands()) return;
    originsInflight ??= invoke<OfficeHostInfo>("office_host_info", { envNames: [] })
      .then(apply)
      .catch(() => undefined)
      .finally(() => {
        originsInflight = null;
      });
    return originsInflight;
  }

  /**
   * 设置面板用：拉白名单 + 这批变量名的存在性。
   *
   * 每次调用都真发一次请求（变量名清单随用户增删服务商而变），不做「取过就不再取」——
   * 面板上「未设置」的提示必须跟着用户刚填的变量名走。
   */
  async function loadEnvPresence(envNames: readonly string[]): Promise<void> {
    if (!hasHostCommands()) return;
    const names = [...new Set(envNames.map((name) => name.trim()).filter(Boolean))];
    try {
      const info = await invoke<OfficeHostInfo>("office_host_info", { envNames: names });
      apply(info);
      envPresent.value = info.envPresent ?? [];
      envMissing.value = info.envMissing ?? [];
    } catch {
      // 宿主不可用：保持空清单，面板据此显示「当前运行时读不到环境变量」。
    }
  }

  return {
    embeddableFrameOrigins,
    envPresent,
    envMissing,
    originsLoaded,
    ensureOrigins,
    loadEnvPresence,
  };
});
