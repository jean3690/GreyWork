/**
 * 权限档位的展示文案（grey 外壳直接写字面量，不走 i18n key）。
 * mode 与 system 两个设置分区共用同一份文案。
 *
 * 沙盒档位已停用（2026-10-13 用户决策）：agent 自带权限 / 审批模型，宿主不再套 OS 沙箱，
 * 相关的选择 UI、文案与「按权限档位联动」一并移除。agent 启动恒为无沙箱（`off`）。
 */
import type { PermTier } from "../stores/settings";

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
