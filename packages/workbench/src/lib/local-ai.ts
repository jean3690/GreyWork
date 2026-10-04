/**
 * 本地 AI 的**注入逻辑**（工作区检索上下文 / 语音附件转写）。
 *
 * 刻意做成「依赖注入的纯模块」而不是 Pinia store：远程助手切片持有的是 plain state
 * （测试里没有 active Pinia），会话切片持有 settings store —— 两处都要用同一套逻辑，
 * 所以这里只收 `{ config, providers, selectedProviderId, llm }`，不自己去取 store。
 *
 * 索引管理（构建 / 状态 / 清空）在 `stores/local-ai.ts`；宿主侧实现在
 * `crates/greywork-host/src/rag.rs` 与 `llm.rs`（`llm_embed` / `llm_transcribe`）。
 */
import { invoke } from "@greywork/host-ipc";
import type { LlmClient, LlmConnection } from "@greywork/llm";
import type { ModelProviderConfig } from "@greywork/shell";
import { createBoundedMap } from "./bounded-map";
import { selectLlmProvider } from "./llm-provider";
import { notify } from "../stores/notice";
import { i18n } from "../i18n";
import type { Attachment } from "../types";

const t = i18n.global.t;

/** 语音转写结果的内存缓存：一份音频转一次即可，跨回合复用（键 `path|size`）。 */
const TRANSCRIPT_CACHE_LIMIT = 200;
const transcripts = createBoundedMap<string, string>(TRANSCRIPT_CACHE_LIMIT);

/** 检索注入的默认片段数（与 settings 的默认值一致，配置缺字段时兜底）。 */
const DEFAULT_TOP_K = 6;

/** `rag_search` 命中的一块。 */
export interface RagHit {
  path: string;
  chunkIndex: number;
  text: string;
  score: number;
}

/**
 * 本地 AI 配置的**宽松**读取：设置快照可能来自旧版本（无 localAi 字段），
 * 或来自测试里的 plain settings 桩（字段更少）。缺字段一律按「未启用」。
 */
export interface LocalAiConfigLike {
  rag?: { enabled?: boolean; providerId?: string | null; embeddingModel?: string; topK?: number };
  stt?: { enabled?: boolean; providerId?: string | null; model?: string };
}

export interface LocalAiDeps {
  config: LocalAiConfigLike | undefined;
  providers: readonly ModelProviderConfig[];
  /** 当前选中的对话供应商（配置里 providerId 为空时跟随它）。 */
  selectedProviderId: string | null;
  llm: LlmClient;
}

/** 解析连接：优先配置里的 providerId，否则跟当前选中的对话供应商。 */
function connectionOf(deps: LocalAiDeps, providerId: string | null | undefined): LlmConnection | null {
  const provider = selectLlmProvider([...deps.providers], providerId ?? deps.selectedProviderId);
  if (!provider?.baseUrl?.trim()) return null;
  return { baseUrl: provider.baseUrl, apiKeyEnv: provider.apiKeyEnv, headers: provider.headers };
}

/** RAG 目标：连接 + embedding 模型 + 注入片段数；不可用时 null。 */
export function ragTarget(deps: LocalAiDeps): { connection: LlmConnection; model: string; topK: number } | null {
  const config = deps.config?.rag;
  const connection = connectionOf(deps, config?.providerId);
  const model = config?.embeddingModel?.trim();
  if (!connection || !model) return null;
  const topK = typeof config?.topK === "number" && config.topK > 0 ? config.topK : DEFAULT_TOP_K;
  return { connection, model, topK };
}

/** STT 目标：连接 + whisper 模型；不可用时 null。 */
export function sttTarget(deps: LocalAiDeps): { connection: LlmConnection; model: string } | null {
  const config = deps.config?.stt;
  const connection = connectionOf(deps, config?.providerId);
  const model = config?.model?.trim();
  if (!connection || !model) return null;
  return { connection, model };
}

/** 语义检索（宿主 `rag_search`：内部先给 query 取向量，再暴力余弦）。 */
export async function searchWorkspace(
  target: { connection: LlmConnection; model: string; topK: number },
  query: string,
): Promise<RagHit[]> {
  return invoke<RagHit[]>("rag_search", {
    query,
    baseUrl: target.connection.baseUrl,
    model: target.model,
    apiKeyEnv: target.connection.apiKeyEnv ?? "",
    headers: target.connection.headers ?? {},
    topK: target.topK,
  });
}

/**
 * 检索并组装成注入历史的一段系统补充；未启用 / 无命中 / 出错都返回 undefined
 * （检索是增强，不该拦住回合）。
 */
export async function retrieveContext(deps: LocalAiDeps, query: string): Promise<string | undefined> {
  if (deps.config?.rag?.enabled !== true || !query.trim() || !deps.llm.isAvailable()) return undefined;
  const target = ragTarget(deps);
  if (!target) return undefined;
  try {
    const hits = (await searchWorkspace(target, query)).filter((hit) => hit.score > 0);
    if (hits.length === 0) return undefined;
    const body = hits.map((hit) => `--- ${hit.path}（第 ${hit.chunkIndex + 1} 块）\n${hit.text.trim()}`).join("\n\n");
    return `以下是从当前工作区检索到的相关片段（按相关度排序，仅供引用；与问题无关时请忽略）：\n\n${body}`;
  } catch (error) {
    notify({
      kind: "warning",
      key: "rag-search",
      title: t("errors.ragSearchFailed"),
      detail: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/** 转写一个语音附件（带内存缓存）；未启用 / 无路径 / 失败都返回 null，回落路径引用。 */
export async function transcribeAttachment(deps: LocalAiDeps, attachment: Attachment): Promise<string | null> {
  if (deps.config?.stt?.enabled !== true || !attachment.path || !deps.llm.isAvailable()) return null;
  const cacheKey = `${attachment.path}|${attachment.size}`;
  const cached = transcripts.get(cacheKey);
  if (cached !== undefined) return cached;
  const target = sttTarget(deps);
  if (!target) return null;
  try {
    const result = await deps.llm.transcribe({ ...target.connection, model: target.model, path: attachment.path });
    const text = result.text ?? "";
    transcripts.set(cacheKey, text);
    return text;
  } catch (error) {
    notify({
      kind: "warning",
      key: "stt-fail",
      title: t("errors.sttFailed"),
      detail: `${attachment.name}：${error instanceof Error ? error.message : String(error)}`,
    });
    return null;
  }
}
