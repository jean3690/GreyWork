/**
 * 设置分区清单的唯一来源：key + 图标。文案统一取 `settings.sections.<key>.title/.desc`。
 * 设置弹窗与标题栏搜索都读这里，避免「设置里有一项、搜索却搜不到」的漂移。
 */
export interface SettingsSection {
  key: string;
  icon: string;
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { key: "agent", icon: "robot" },
  { key: "assistant", icon: "magic" },
  { key: "appearance", icon: "sun" },
  { key: "mode", icon: "hammer" },
  { key: "system", icon: "setting" },
  { key: "mcp", icon: "terminal" },
  { key: "skills", icon: "lightning" },
  { key: "storage", icon: "folder" },
  { key: "team", icon: "peoples" },
];
