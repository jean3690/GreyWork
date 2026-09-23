import type { ModelProviderConfig, ReasoningEffort } from "@greywork/shell";
import { ref } from "vue";
import type { LlmChatMessage, LlmContentPart } from "@greywork/llm";
import { inlineFileAttachment, inlineTextAttachment } from "../lib/attachments";
import { readAttachmentBase64, readAttachmentText } from "../state/attachment-library";
import { i18n } from "../i18n";
import { notify } from "../stores/notice";
import type { Attachment } from "../types";

const t = i18n.global.t;

/**
 * Local 路由的会话级思考强度覆盖（对话输入区选择器写入，不持久化）。
 *
 * 放在纯模块而不是 agent store：stream.ts 已依赖本模块，若反过来读 agent store
 * 会成环（agent/state.ts 已引用 chat store）。null = 跟随供应商配置。
 */
export const localReasoningOverride = ref<ReasoningEffort | null>(null);

/** 生效思考强度：会话覆盖 > 供应商配置 > auto。纯函数便于单测。 */
export function resolveLocalEffort(
  override: ReasoningEffort | null,
  provider: Pick<ModelProviderConfig, "reasoningEffort"> | null,
): ReasoningEffort {
  return override ?? provider?.reasoningEffort ?? "auto";
}

/** Phase 1 统一 openai-compatible 线格式：anthropic / ollama 均提供兼容端点，
 * kind 不作为路由条件，只要求启用且 baseUrl/model 已配置。 */
export function selectLlmProvider(providers: ModelProviderConfig[], preferredId?: string | null): ModelProviderConfig | null {
  const available = providers.filter((provider) => provider.enabled && !!provider.baseUrl?.trim() && !!provider.model.trim());
  return available.find((provider) => provider.id === preferredId) ?? available[0] ?? null;
}

export const LLM_SYSTEM_PROMPT = "你是 GreyWork 智能工作台中的助手。回答简洁准确；涉及数据或文件操作时，先给出简短计划再执行说明。";

/**
 * 历史里回放附件的上限：从最新往回最多 3 条带附件的 user 消息、图片总量 4 张。
 * 不回放全部附件是刻意的 —— 每轮请求都要重传 base64 图片，20 条历史全带上
 * 会让 token 与首字节延迟随对话长度线性恶化。
 */
const HISTORY_ATTACHMENT_MESSAGES = 3;
const HISTORY_IMAGE_LIMIT = 4;

interface HistorySource {
  role: string;
  content: string;
  attachments?: readonly Attachment[];
}

/**
 * 一条消息 + 它的附件 → 内容块数组；一个附件都没能带上时返回 null
 * （调用方回落纯文本 string，别让不支持 parts 的兼容端点白白吃一个 400）。
 */
async function toContentParts(
  message: HistorySource,
  attachments: readonly Attachment[],
  imageAllowance: number,
): Promise<LlmContentPart[] | null> {
  let text = message.content;
  const images: LlmContentPart[] = [];
  let attached = false;
  let budget = imageAllowance;
  for (const item of attachments) {
    try {
      if (item.kind === "image") {
        if (budget <= 0) continue;
        budget -= 1;
        const base64 = item.dataUrl ? null : await readAttachmentBase64(item);
        images.push({ type: "image_url", image_url: { url: item.dataUrl ?? `data:${item.mime || "image/png"};base64,${base64}` } });
        attached = true;
      } else if (item.kind === "text") {
        const { text: content, truncated } = await readAttachmentText(item);
        text += inlineTextAttachment(item.name, content, truncated);
        attached = true;
      } else {
        // 通用文件（PDF / 压缩包等）内容内联不了，只递一条路径引用 —— 至少让模型知道
        // 有这么个文件，而不是被无声吞掉。
        text += inlineFileAttachment(item.name, item.path);
        attached = true;
      }
    } catch (error) {
      // 附件文件可能已被移动/删除：跳过它，其余内容照常发给模型。
      notify({
        kind: "error",
        key: "attachment-read",
        title: t("errors.attachmentReadFailed"),
        detail: error instanceof Error ? `${item.name}：${error.message}` : item.name,
      });
    }
  }
  return attached ? [...(text.trim() ? [{ type: "text" as const, text }] : []), ...images] : null;
}

/**
 * 历史上下文整形：仅保留 user/assistant 非空消息，截取最近 cap 条，前置系统提示。
 * 空 content 的 assistant 占位消息（流式开始前）天然被过滤。
 *
 * 附件只对窗口内最近的若干条 user 消息展开（见上面的上限），更旧的只保留文字 ——
 * 模型仍能看到当时的对话，但不必为已经翻页的截图重复付费。图片额度按「从新到旧」
 * 分配：最新的截图优先拿到额度。
 */
export async function buildLlmHistory(messages: HistorySource[], cap = 20): Promise<LlmChatMessage[]> {
  const window = messages
    .filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") &&
        // 只有附件的消息也算有效输入（截图问答：图就是全部内容）。
        (message.content.trim().length > 0 || (message.attachments?.length ?? 0) > 0),
    )
    .slice(-cap);

  const allowance = new Map<number, number>();
  let imageLeft = HISTORY_IMAGE_LIMIT;
  let selected = 0;
  for (let i = window.length - 1; i >= 0 && selected < HISTORY_ATTACHMENT_MESSAGES; i -= 1) {
    const item = window[i];
    if (item.role !== "user" || !item.attachments?.length) continue;
    const images = item.attachments.filter((attachment) => attachment.kind === "image").length;
    allowance.set(i, Math.max(0, Math.min(images, imageLeft)));
    imageLeft = Math.max(0, imageLeft - images);
    selected += 1;
  }

  const history: LlmChatMessage[] = [];
  for (let i = 0; i < window.length; i += 1) {
    const item = window[i];
    const parts = allowance.has(i) ? await toContentParts(item, item.attachments ?? [], allowance.get(i) ?? 0) : null;
    const content = parts ?? item.content;
    // 纯附件消息的附件被窗口丢弃（或全部读取失败）后正文为空：留着会被端点拒（空 content），直接跳过。
    if (typeof content === "string" && !content.trim()) continue;
    history.push({ role: item.role as "user" | "assistant", content });
  }
  return [{ role: "system", content: LLM_SYSTEM_PROMPT }, ...history];
}
