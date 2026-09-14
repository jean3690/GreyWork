/**
 * 未保存的表格草稿：tab id → 一份足以原地重建编辑器状态的记录。
 *
 * **为什么放模块级 Map 而不是 pinia**：快照是几 MB 的普通对象，进 store 会被深度代理、
 * 并随会话快照一起序列化，代价与收益完全不成比例 —— 与 preview store「内容不入 store」
 * 是同一条立场。
 *
 * **为什么整条记录都要留**：`applyUniverEdits` 要「原始字节 + 基准快照 + 当前快照」三件套
 * 才求得出差量。只留 current 的话，切回来时基准只能重猜 —— 转换器的输出**没经过 Univer 规范化**
 * （补行列数、重排样式 id、丢空格），拿它当基准会把规范化差异全当成用户改动。三者同源存下，
 * 切多少次回来都能接着保存。
 *
 * 消费节奏（决定了这里为什么是 peek 而不是 take）：挂载时读、卸载时按脏标记覆盖或丢弃、
 * 保存成功时丢弃。peek 让「初始化失败」也不至于把草稿吃掉。
 */
import type { IWorkbookData } from "@univerjs/core";

export interface SheetDraft {
  /** 上次保存后（或初次打开时）经 Univer 规范化取到的基准快照。 */
  base: IWorkbookData;
  /** 用户改到一半的当前快照。 */
  current: IWorkbookData;
  /** 与 current 配套的原始字节，写回时的底。 */
  source: Uint8Array;
}

const drafts = new Map<string, SheetDraft>();

export function stashSheetDraft(tabId: string, draft: SheetDraft): void {
  drafts.set(tabId, draft);
}

/** 读草稿，**不删除** —— 删除与否由「卸载时脏不脏 / 保存成不成功」决定。 */
export function readSheetDraft(tabId: string): SheetDraft | null {
  return drafts.get(tabId) ?? null;
}

export function dropSheetDraft(tabId: string): void {
  drafts.delete(tabId);
}

/** 判断某 tab 是否留有草稿（供测试与排查用）。 */
export function hasSheetDraft(tabId: string): boolean {
  return drafts.has(tabId);
}
