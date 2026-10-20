/**
 * 旧版 ACP 会话模式（`session/new` 回包的 `modes`）适配成合成 config option。
 *
 * 为什么适配而不是另起一套 UI：现代 agent 走 configOptions（`category: "mode"`），
 * 旧版 agent 只在会话回包里给 `modes`，切换方法也不同（`session/set_mode`）。统一成
 * 一条 config option 后，AcpSessionConfig、工作区记忆、全局默认都能复用同一条链路。
 */
import type { AcpSessionConfigOption, AcpSessionModeState } from "@greywork/acp";

/** 合成选项的保留 id：避开 agent 常用的 model / mode / session_mode。 */
export const ACP_LEGACY_MODE_OPTION_ID = "legacy_session_mode";

/** agent 自己是否已经暴露了模式选择器（config option 优先于旧版 modes）。 */
function hasModeConfigOption(options: readonly AcpSessionConfigOption[]): boolean {
  return options.some(
    (option) =>
      option.type === "select" &&
      (option.category === "mode" || option.id === "mode" || option.id === "session_mode" || option.id === ACP_LEGACY_MODE_OPTION_ID),
  );
}

/**
 * 用旧版 modes 补一条 select 型 config option；已有模式选择器 / 无可用模式时原样返回。
 * 返回新数组，调用方可直接覆写响应式快照。
 */
export function withLegacyModeOption(
  options: readonly AcpSessionConfigOption[],
  modes: AcpSessionModeState | null | undefined,
): AcpSessionConfigOption[] {
  const base = [...options];
  if (!modes || modes.availableModes.length === 0 || hasModeConfigOption(base)) return base;
  return [
    ...base,
    {
      id: ACP_LEGACY_MODE_OPTION_ID,
      name: "Session mode",
      category: "mode",
      type: "select",
      currentValue: modes.currentModeId,
      options: modes.availableModes.map((mode) => ({
        value: mode.id,
        name: mode.name,
        ...(mode.description ? { description: mode.description } : {}),
      })),
    },
  ];
}

/** 把 agent 确认 / 主动通知的当前模式回填到合成选项；没有合成选项时原样返回。 */
export function withLegacyModeValue(options: readonly AcpSessionConfigOption[], modeId: string): AcpSessionConfigOption[] {
  return options.map((option) => (option.id === ACP_LEGACY_MODE_OPTION_ID ? { ...option, currentValue: modeId } : option));
}
