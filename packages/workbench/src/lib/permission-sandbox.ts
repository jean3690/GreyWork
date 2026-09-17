/**
 * 权限档位 / 沙盒档位的展示文案与联动（grey 外壳直接写字面量，不走 i18n key）。
 * mode 与 system 两个设置分区共用同一份文案与「按权限档位建议沙盒」逻辑。
 */
import { computed } from "vue";
import { recommendedSandboxMode, useSettingsStore, type PermTier, type SandboxMode } from "../stores/settings";

export const PERM_TIER_LABELS: Record<PermTier, string> = {
  "read-only": "只读",
  workspace: "工作区",
  full: "完全访问",
};

export const PERM_TIER_DESCS: Record<PermTier, string> = {
  "read-only": "禁止一切写入与执行类操作，仅允许读取",
  workspace: "自动执行，写入仅限当前工作区文件夹内",
  full: "可读写任意路径，不设工作区边界",
};

export const SANDBOX_LABELS: Record<SandboxMode, string> = {
  auto: "自动（推荐）",
  off: "关闭",
  fs: "文件系统隔离",
  full: "隔离 + 网络",
};

export const SANDBOX_DESCS: Record<SandboxMode, string> = {
  auto: "检测到 bwrap 时启用文件系统隔离并关闭网络；不可用时宿主记录明确告警。",
  off: "显式直启 agent 进程，不做 OS 级隔离（高风险）。",
  fs: "bwrap 包裹：仅必要 Agent 配置只读、工作区可写、/tmp 隔离、网络关闭。",
  full: "同文件系统隔离，但放行网络（agent 可联网搜索 / MCP）。",
};

/**
 * 与当前权限档位配套的沙盒档位及其应用动作。
 * mode / system 两个分区共用：提示不一致时给出「按权限档位联动」入口。
 */
export function usePermissionSandbox() {
  const settings = useSettingsStore();

  const suggestedSandbox = computed(() => recommendedSandboxMode(settings.permissionTier));

  function applySandboxMode(mode: SandboxMode): void {
    settings.sandboxMode = mode;
    settings.persist();
  }

  return { suggestedSandbox, applySandboxMode };
}
