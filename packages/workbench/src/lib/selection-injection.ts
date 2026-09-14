/**
 * 把「预览里选中的一段」注入对话：附件 + 预填提示词。
 *
 * 两条通道分开走已有的基础设施，不新造管线：
 * - 内容侧复用 `chat:attachText`（网页正文转发用的同一条）；
 * - 提示词侧走本轮新增的 `chat:prefill`。
 *
 * 唯一的前置条件是 `chatReceiverAvailable` —— 预览面板在团队/定时/助手等路由下也在，
 * 而那些页面没有输入框。没有这道判断，点击就会「看起来成功了、其实什么都没发生」。
 */
import { i18n } from "../i18n";
import { appEvents } from "../events";
import { chatReceiverAvailable } from "./chat-receiver";
import { findPrecedingHeading, type SemanticUnit } from "./selection";

export type SelectionAction = "ask" | "explain" | "rewrite";

/** 角色 → i18n key 尾段（连字符形式与 camelCase 不同，所以要映射）。 */
const ROLE_KEY: Readonly<Record<SemanticUnit["role"], string>> = {
  heading: "heading",
  paragraph: "paragraph",
  "list-item": "listItem",
  "table-cell": "tableCell",
  code: "code",
  block: "block",
};

export function selectionPrompt(action: SelectionAction): string {
  return i18n.global.t(`preview.selection.prompt.${action}`);
}

/**
 * 表格区域的引导语。
 *
 * 不并入 `SelectionAction`：「改写一段数据」没有意义，硬塞进那三个动作会让类型
 * 表达不出真实意图。表格只有一个动作，用一句固定的引导语即可。
 */
export function sheetSelectionPrompt(): string {
  return i18n.global.t("preview.selection.prompt.askRange");
}

export function selectionRoleLabel(role: SemanticUnit["role"]): string {
  return i18n.global.t(`preview.selection.role.${ROLE_KEY[role]}`);
}

export interface SelectionSource {
  selectionText: string;
  unit: SemanticUnit;
  /** 选区所在的正文根，用于向上找标题面包屑。表格区域没有 DOM，传 null。 */
  scope: Element | null;
  /** 来源文件名（tab.name）。 */
  sourceName: string;
  /**
   * 位置描述的直接覆盖。
   * 表格区域用范围标签（`Sheet1!A1:C3`）—— 它比「表格单元格」这个角色名信息量大得多，
   * 而 DOM 那套「向上找最近标题」对 canvas 渲染的表格无从下手。
   */
  location?: string;
}

export interface SelectionAttachment {
  name: string;
  text: string;
  mime: string;
}

/**
 * 附件正文 = 一行来源引用 + 选中的那段子串。
 *
 * 附带位置信息（最近的标题，否则角色名）是因为「解释这段」在模型侧缺少指代对象；
 * 一行引用足以让它知道这是文档里的哪一段，又不至于把上下文撑大。
 */
export function buildSelectionAttachment(source: SelectionSource): SelectionAttachment {
  const heading = findPrecedingHeading(source.unit.element, source.scope);
  const location = source.location ?? (heading || selectionRoleLabel(source.unit.role));
  return {
    name: `${i18n.global.t("preview.selection.attachmentName")} · ${source.sourceName}`,
    text: `> ${i18n.global.t("preview.selection.attachmentSource", { name: source.sourceName, location })}\n\n${source.selectionText}`,
    mime: "text/markdown",
  };
}

/**
 * 注入对话。返回 false 表示没有接收方、什么都没发生（调用方据此提示用户）。
 *
 * 第一参数是**已经翻译好的引导语**而不是动作名：不同渲染器的动作集不一样
 * （正文是问/解释/改写，表格区域只有一句引导），在这里按动作分支会把两种语义
 * 搅在一起。调用方自己决定说什么，这里只负责「怎么送进去」。
 *
 * 这里**再查一次**可用性而不是只依赖按钮的 disabled：按钮禁用是 UI 层的事，
 * 而「没有接收方时绝不发射」是正确性要求，不该只靠一层。
 */
export function injectSelectionIntoChat(prompt: string, source: SelectionSource): boolean {
  if (!chatReceiverAvailable.value) return false;
  appEvents.emit("chat:attachText", buildSelectionAttachment(source));
  appEvents.emit("chat:prefill", { text: prompt, mode: "append" });
  return true;
}
