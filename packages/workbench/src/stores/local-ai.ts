/**
 * 本地索引管理：构建 / 状态 / 清空（设置页「本地 AI」分区用）。
 *
 * 检索与转写的**注入逻辑**在 `lib/local-ai.ts`（依赖注入的纯模块，会话切片与远程助手
 * 切片共用）；这里只管索引进度与状态这类 UI 关注点。宿主侧实现在
 * `crates/greywork-host/src/rag.rs`。
 */
import { ref } from "vue";
import { defineStore } from "pinia";
import { hasHostCommands, invoke, listen } from "@greywork/host-ipc";
import { ragTarget, searchWorkspace, type LocalAiDeps, type RagHit } from "../lib/local-ai";
import { resolveWorkspaceRoot } from "../lib/workspace-dir";
import { useSettingsStore } from "./settings";
import { notify } from "./notice";
import { createLlmClient } from "@greywork/llm";
import { i18n } from "../i18n";

const t = i18n.global.t;

/** `rag_status` 返回。 */
export interface RagStatus {
  chunks: number;
  files: number;
  model: string | null;
  dim: number | null;
}

/** `rag_index_build` 进度（`rag://event` 的 progress 帧）。 */
export interface RagProgress {
  done: number;
  total: number;
}

export const useLocalAiStore = defineStore("local-ai", () => {
  const settings = useSettingsStore();
  const llm = createLlmClient();

  const status = ref<RagStatus>({ chunks: 0, files: 0, model: null, dim: null });
  const building = ref(false);
  const progress = ref<RagProgress>({ done: 0, total: 0 });
  let listening = false;

  /** 组装注入逻辑的依赖（provider 连接 / 配置 / 客户端）。 */
  function deps(): LocalAiDeps {
    return {
      config: settings.localAi,
      providers: settings.modelProviders,
      selectedProviderId: settings.selectedModelProviderId,
      llm,
    };
  }

  /** 订阅一次 `rag://event`（构建进度）。 */
  function ensureListener(): void {
    if (listening || !hasHostCommands()) return;
    listening = true;
    void listen<{ kind?: string; done?: number; total?: number }>("rag://event", (event) => {
      if (event.payload.kind === "progress") {
        progress.value = { done: event.payload.done ?? 0, total: event.payload.total ?? 0 };
      }
    }).catch(() => {
      listening = false;
    });
  }

  /** 读一次索引状态（打开设置页 / 构建结束后调用）。 */
  async function refreshStatus(): Promise<void> {
    if (!hasHostCommands()) return;
    try {
      status.value = await invoke<RagStatus>("rag_status");
    } catch {
      // 状态读取失败不该弹错（可能只是还没建过索引）。
    }
  }

  /** 构建（或增量更新）索引：根 = 当前工作区目录（宿主只接受已授权根）。 */
  async function buildIndex(force = false): Promise<void> {
    const target = ragTarget(deps());
    if (!target) {
      notify({ kind: "warning", title: t("errors.ragProviderMissing"), key: "rag-no-provider" });
      return;
    }
    const root = (await resolveWorkspaceRoot()).dir;
    building.value = true;
    progress.value = { done: 0, total: 0 };
    ensureListener();
    try {
      await invoke("rag_index_build", {
        root,
        baseUrl: target.connection.baseUrl,
        model: target.model,
        apiKeyEnv: target.connection.apiKeyEnv ?? "",
        headers: target.connection.headers ?? {},
        force,
      });
    } catch (error) {
      notify({
        kind: "error",
        key: "rag-build",
        title: t("errors.ragBuildFailed"),
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      building.value = false;
      await refreshStatus();
    }
  }

  /** 清空索引。 */
  async function clearIndex(): Promise<void> {
    if (!hasHostCommands()) return;
    try {
      await invoke("rag_clear");
      await refreshStatus();
    } catch (error) {
      notify({
        kind: "error",
        key: "rag-clear",
        title: t("errors.ragClearFailed"),
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 语义检索（设置页测试 / 调试用；对话注入走 `lib/local-ai` 的 retrieveContext）。 */
  async function search(query: string, topK?: number): Promise<RagHit[]> {
    const target = ragTarget(deps());
    if (!target) return [];
    return searchWorkspace({ ...target, topK: topK ?? target.topK }, query);
  }

  return { status, building, progress, ensureListener, refreshStatus, buildIndex, clearIndex, search };
});
