/**
 * 设置分区清单的唯一来源：key + 图标。文案统一取 `settings.sections.<key>.title/.desc`。
 * 分区按 SETTINGS_SECTION_GROUPS 分组，设置弹窗侧栏按组渲染小标题；标题栏搜索仍读扁平
 * 的 SETTINGS_SECTIONS，避免「设置里有一项、搜索却搜不到」的漂移。
 */
export interface SettingsSection {
  key: string;
  icon: string;
}

export interface SettingsSectionGroup {
  /** 分组文案键：`settings.groups.<key>`。 */
  key: string;
  sections: readonly SettingsSection[];
}

/** 分组顺序即侧栏顺序；组内顺序即组内条目顺序。 */
export const SETTINGS_SECTION_GROUPS: readonly SettingsSectionGroup[] = [
  {
    key: "general",
    sections: [
      { key: "appearance", icon: "sun" },
      { key: "system", icon: "setting" },
    ],
  },
  {
    key: "agent",
    sections: [
      { key: "agent", icon: "robot" },
      { key: "mode", icon: "hammer" },
      { key: "localai", icon: "search" },
    ],
  },
  {
    key: "extensions",
    sections: [
      { key: "mcp", icon: "terminal" },
      { key: "skills", icon: "lightning" },
      { key: "plugins", icon: "magic" },
    ],
  },
  {
    key: "collaboration",
    sections: [
      { key: "account", icon: "peoples" },
      { key: "assistant", icon: "magic" },
      { key: "team", icon: "peoples" },
      { key: "controlplane", icon: "shield" },
    ],
  },
];

/** 扁平清单：搜索索引与「未知分区」校验按它读，顺序沿用分组顺序。 */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = SETTINGS_SECTION_GROUPS.flatMap((group) => group.sections);
