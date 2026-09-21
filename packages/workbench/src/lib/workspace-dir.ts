import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@greywork/core";
import { useSettingsStore } from "../stores/settings";
import { i18n } from "../i18n";
import { activeConversationFolder } from "./conversation-folder";
import { activeWorkspaceFolder } from "./artifact-dir";

const t = i18n.global.t;

/**
 * 解析 ACP 工作区目录：设置项优先；桌面端默认使用宿主私有且已授权的
 * `~/.greyWork`，不再把完整 HOME 暴露给 agent。浏览器态没有本机工作区。
 */
export async function resolveWorkspaceDir(): Promise<string> {
  const configured = useSettingsStore().workspaceDir.trim();
  if (configured) return configured;
  if (isTauriRuntime()) return await invoke<string>("store_default_root");
  throw new Error(t("errors.workspaceUnresolvable"));
}

/** 工作区根目录解析结果：`bound` 区分用户绑定目录与设置项/应用私有根兜底。 */
export interface WorkspaceRootResolution {
  dir: string;
  bound: boolean;
}

/**
 * 解析「当前该看哪个文件夹」，优先级从窄到宽：
 * 1. 当前对话所属工作区绑定的文件夹；
 * 2. 当前激活工作区绑定的文件夹；
 * 3. 设置项或宿主私有 `~/.greyWork`。
 *
 * `bound=false` 表示没有用户显式绑定项目目录。
 */
export async function resolveWorkspaceRoot(): Promise<WorkspaceRootResolution> {
  const conversation = activeConversationFolder();
  if (conversation) return { dir: conversation, bound: true };
  const active = activeWorkspaceFolder();
  if (active) return { dir: active, bound: true };
  return { dir: await resolveWorkspaceDir(), bound: false };
}

/** worktree_provision 返回的宿主契约（kind：git = 真实 worktree / copy = 目录复制兜底 / direct = 数据根直通）。 */
export interface WorktreeProvision {
  root: string;
  kind: "git" | "copy" | "direct";
  source: string;
}

/**
 * 按 runMode 给本轮 ACP 会话套上运行环境隔离，返回真正该用的工作区目录。
 *
 * 只做「判定 + 派生」，**不解析 base** —— base 由调用点按自己的会话归属给出：
 * 单 Agent 对话与团队协作取当前对话绑定的文件夹，编排子任务取设置项。
 * 早先把两者揉进一个 `resolveRunWorkspace()` 时，runs.ts 顺带被塞进了
 * 「跟随当前打开的对话」的语义，那不是它的意图。
 *
 * 非桌面端、或档位不是 worktree，一律原样返回 base。
 */
export async function isolateForRun(base: string): Promise<string> {
  if (useSettingsStore().runMode !== "worktree" || !isTauriRuntime()) return base;
  const provisioned = await invoke<WorktreeProvision>("worktree_provision", { source: base });
  return provisioned.root;
}
