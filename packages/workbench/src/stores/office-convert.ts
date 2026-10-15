/**
 * LibreOffice 是否可用的宿主事实（`office_convert_info`）。
 *
 * 与 `office-host.ts` 同一思路：这是**宿主进程级**的静态事实（启动时根据 PATH / 配置解析一次），
 * 一次会话取一次就够。渲染端据此决定 Office 文档的默认呈现方式 —— soffice 在就默认「高保真(PDF)」，
 * 不在就默认「原生 viewer」，避免一打开文件就撞一次失败。
 *
 * **取不到不等于「不可用」**：浏览器预览态没有宿主命令、或宿主临时失败 → `loaded` 保持 false，
 * 调用方按「未知」处理（默认走原生 viewer，不报错）。
 */
import { hasHostCommands, invoke } from "@greywork/host-ipc";
import { defineStore } from "pinia";
import { ref } from "vue";

/** 与 `crates/greywork-host/src/services/office/convert.rs` 的 `ConvertInfo` 对齐（camelCase）。 */
interface ConvertInfo {
  available?: boolean;
  path?: string;
  source?: string;
}

export const useOfficeConvertStore = defineStore("office-convert", () => {
  /** 宿主是否具备可用的 soffice。 */
  const available = ref(false);
  /** 是否已取到事实；false = 未知，调用方应跳过「按可用性决策」。 */
  const loaded = ref(false);

  /** 在飞查询（去重：preview 与设置面板可能同时开口）。 */
  let inflight: Promise<void> | null = null;

  /** 确保可用性已就位；浏览器预览态 / 查询失败 → 保持「未知」。 */
  async function ensure(): Promise<void> {
    if (loaded.value || !hasHostCommands()) return;
    inflight ??= invoke<ConvertInfo>("office_convert_info", {})
      .then((info) => {
        available.value = !!info.available;
        loaded.value = true;
      })
      .catch(() => {
        // 宿主不可用：保持 unknown（loaded 仍置位，避免反复重试）。
        loaded.value = true;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  return { available, loaded, ensure };
});
