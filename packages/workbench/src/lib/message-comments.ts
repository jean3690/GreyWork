/**
 * 选区评论的提示词拼装与摘要（纯逻辑，可单测）。
 *
 * 一条评论的职责分两半：
 * - **批注**（`{ quote, note }`）挂在消息上，渲染为「针对哪一段说了什么」的注解，供人回看；
 * - **让模型知道指代对象**：批注文本本身已随输入框草稿成为正文，唯一缺的是被引用的原文，
 *   所以这里只把 `> 引用` 拼在正文前。模型先看到引用、再看到用户的话，指代就清楚了。
 *
 * 没有评论时原样返回正文，不引入任何噪声。
 */
import type { MessageComment } from "../types";

/** 引用片段折成单行（注解 chip 与提示词都不该被多行引用撑开）。 */
export function quoteSummary(quote: string, max = 80): string {
  const flat = quote.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 把评论引用拼到正文前：每条渲染成 `> 引用`，多条以空行分隔。 */
export function buildCommentPrompt(text: string, comments: readonly MessageComment[]): string {
  if (comments.length === 0) return text;
  const quoted = comments.map((comment) => `> ${comment.quote.trim().replace(/\n/g, "\n> ")}`).join("\n\n");
  return text.trim() ? `${quoted}\n\n${text}` : quoted;
}
