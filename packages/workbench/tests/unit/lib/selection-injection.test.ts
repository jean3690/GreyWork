/**
 * 注入对话的契约。
 *
 * 两条硬性要求：
 * 1. **没有接收方时绝不发射任何事件** —— 这是「不静默丢数据」的落点。附件被丢掉、
 *    而预填却成功了，是最坏的半成功状态。
 * 2. 附件的 name / text 形状稳定 —— 它是模型侧唯一的指代线索（哪份文件的哪一段）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appEvents } from "@/events";
import { zhCN } from "@/i18n/locales/zh-CN";
import { registerChatReceiver, resetChatReceiversForTest } from "@/lib/chat-receiver";
import {
  buildSelectionAttachment,
  injectSelectionIntoChat,
  selectionPrompt,
  selectionRoleLabel,
  sheetSelectionPrompt,
  type SelectionSource,
} from "@/lib/selection-injection";
import type { SemanticUnit } from "@/lib/selection";

/** 不带 element/scope：node 环境下没有 DOM，`findPrecedingHeading` 对 null 是安全的。 */
function source(overrides: Partial<SelectionSource> = {}): SelectionSource {
  const unit: SemanticUnit = { role: "paragraph", level: null, listLevel: null, element: null };
  return {
    selectionText: "被选中的那句话",
    unit,
    scope: null,
    sourceName: "report.docx",
    ...overrides,
  };
}

beforeEach(() => {
  resetChatReceiversForTest();
});

afterEach(() => {
  appEvents.clear();
});

describe("selectionPrompt", () => {
  it("三个动作各自取到文案，而不是回落到 key 原文", () => {
    for (const action of ["ask", "explain", "rewrite"] as const) {
      const text = selectionPrompt(action);
      expect(text).toBe(zhCN.preview.selection.prompt[action]);
      expect(text).not.toContain("preview.selection");
    }
  });
});

describe("sheetSelectionPrompt", () => {
  it("表格用单独的引导语：区域没有「改写」这类动作，措辞也不同", () => {
    const text = sheetSelectionPrompt();
    expect(text).toBe(zhCN.preview.selection.prompt.askRange);
    expect(text).not.toContain("preview.selection");
    // 与正文那句必须不同 —— 否则「这段内容」用在表格区域上就是错的指代
    expect(text).not.toBe(selectionPrompt("ask"));
  });
});

describe("selectionRoleLabel", () => {
  it("六种角色都有文案，且互不相同", () => {
    const roles: SemanticUnit["role"][] = ["heading", "paragraph", "list-item", "table-cell", "code", "block"];
    const labels = roles.map((role) => selectionRoleLabel(role));
    for (const label of labels) {
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toContain("preview.selection");
    }
    expect(new Set(labels).size).toBe(roles.length);
  });
});

describe("buildSelectionAttachment", () => {
  it("正文是「一行来源引用 + 选中子串」，且不掺入整段内容", () => {
    const attachment = buildSelectionAttachment(source());
    expect(attachment.mime).toBe("text/markdown");
    expect(attachment.name).toContain("report.docx");
    expect(attachment.text.startsWith("> ")).toBe(true);
    expect(attachment.text).toContain("report.docx");
    expect(attachment.text).toContain("被选中的那句话");
    // 只附选中的那段，不吸附到整块
    expect(attachment.text).not.toContain("\n\n\n");
  });

  it("找不到标题时用角色名兜底填位置（不让来源行缺一半）", () => {
    const attachment = buildSelectionAttachment(source());
    expect(attachment.text).toContain(selectionRoleLabel("paragraph"));
  });

  it("location 覆盖优先于标题与角色名（表格区域没有 DOM，位置只能由范围标签给）", () => {
    const attachment = buildSelectionAttachment(source({ location: "Sheet1!A1:C3" }));
    expect(attachment.text).toContain("Sheet1!A1:C3");
    expect(attachment.text).not.toContain(selectionRoleLabel("paragraph"));
  });
});

describe("injectSelectionIntoChat", () => {
  it("没有接收方时返回 false，且不发射任何事件", () => {
    const attached: unknown[] = [];
    const prefilled: unknown[] = [];
    appEvents.on("chat:attachText", (payload) => attached.push(payload));
    appEvents.on("chat:prefill", (payload) => prefilled.push(payload));

    expect(injectSelectionIntoChat(selectionPrompt("ask"), source())).toBe(false);
    expect(attached).toHaveLength(0);
    expect(prefilled).toHaveLength(0);
  });

  it("有接收方时先附内容再预填提示词，预填用 append 以免覆盖用户已写的内容", () => {
    const unregister = registerChatReceiver();
    const attached: { name: string; text: string; mime: string }[] = [];
    const prefilled: { text: string; mode?: string }[] = [];
    appEvents.on("chat:attachText", (payload) => attached.push(payload));
    appEvents.on("chat:prefill", (payload) => prefilled.push(payload));

    expect(injectSelectionIntoChat(selectionPrompt("explain"), source())).toBe(true);

    expect(attached).toHaveLength(1);
    expect(attached[0].text).toContain("被选中的那句话");
    expect(prefilled).toHaveLength(1);
    expect(prefilled[0].text).toBe(selectionPrompt("explain"));
    expect(prefilled[0].mode).toBe("append");

    unregister();
  });

  it("引导语由调用方给：表格那条路径传的是自己的文案", () => {
    const unregister = registerChatReceiver();
    const prefilled: { text: string }[] = [];
    appEvents.on("chat:prefill", (payload) => prefilled.push(payload));

    injectSelectionIntoChat(sheetSelectionPrompt(), source({ location: "Sheet1!A1:C3" }));

    expect(prefilled[0].text).toBe(sheetSelectionPrompt());
    unregister();
  });
});
