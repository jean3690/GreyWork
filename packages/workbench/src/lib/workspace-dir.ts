import { desktopHomeDir } from "@greywork/acp";
import { useSettingsStore } from "../stores/settings";
import { i18n } from "../i18n";
import { activeConversationFolder } from "./conversation-folder";
import { activeWorkspaceFolder } from "./artifact-dir";

const t = i18n.global.t;

/**
 * 解析 ACP 工作区目录：设置项优先，否则取桌面主目录。
 * 此前 agent store 与 MarketView 各写一份逐字相同的实现。
 */
export async function resolveWorkspaceDir(): Promise<string> {
  const configured = useSettingsStore().workspaceDir.trim();
  if (configured) return configured;
  const home = await desktopHomeDir();
  if (!home) throw new Error(t("errors.workspaceUnresolvable"));
  return home;
}

/** 工作区根目录解析结果：`bound` 区分「用户显式绑定的文件夹」与「设置项/主目录兜底」。 */
export interface WorkspaceRootResolution {
  dir: string;
  bound: boolean;
}

/**
 * 解析「当前该看哪个文件夹」，优先级从窄到宽：
 * 1. 当前对话所属工作区绑定的文件夹 —— ACP agent 就在这里读写，最贴近用户此刻的上下文；
 * 2. 当前激活工作区绑定的文件夹 —— 产物也落在它的 `artifacts/` 下（见 lib/artifact-dir.ts）；
 * 3. `resolveWorkspaceDir()` 兜底（设置项 → 桌面主目录）。
 *
 * 返回 `bound` 而不只是路径：兜底到主目录时界面要能提示「未绑定」并给出绑定入口，
 * 否则用户看到的是一棵与自己项目无关的 home 目录树，还以为是 bug。
 */
export async function resolveWorkspaceRoot(): Promise<WorkspaceRootResolution> {
  const conversation = activeConversationFolder();
  if (conversation) return { dir: conversation, bound: true };
  const active = activeWorkspaceFolder();
  if (active) return { dir: active, bound: true };
  return { dir: await resolveWorkspaceDir(), bound: false };
}
