// 微信纯文本转换契约：Markdown 标记必须消失、内容必须留下（这条通道不渲染 Markdown）。
import { describe, expect, it } from "vitest";
import { markdownToPlainText } from "@/lib/wechat-text";

describe("markdownToPlainText", () => {
  it("代码围栏留内容、去标记", () => {
    expect(markdownToPlainText("看这里：\n```ts\nconst a = 1;\n```\n完了")).toBe("看这里：\nconst a = 1;\n完了");
  });

  it("图片整段去掉，链接留文字", () => {
    const text = markdownToPlainText("![截图](https://x.test/a.png) 见 [文档](https://x.test/doc)");
    expect(text).toBe("见 文档");
  });

  it("表格去竖线、标题去井号、粗斜体去星号", () => {
    const text = markdownToPlainText("## 汇总\n| 项 | 值 |\n| --- | --- |\n| a | 1 |\n**重点** 与 *次重点*");
    expect(text).not.toContain("|");
    expect(text).not.toContain("#");
    expect(text).not.toContain("*");
    expect(text).toContain("汇总");
    expect(text).toContain("重点");
    expect(text).toContain("次重点");
  });

  it("纯文本与列表输入保持可读", () => {
    expect(markdownToPlainText("- 第一项\n- 第二项")).toBe("· 第一项\n· 第二项");
    expect(markdownToPlainText("普通一句话")).toBe("普通一句话");
  });

  it("收敛多余空行并去掉首尾空白", () => {
    expect(markdownToPlainText("\n\n第一段\n\n\n\n第二段\n\n")).toBe("第一段\n\n第二段");
  });
});
