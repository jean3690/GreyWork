/**
 * 附件纯逻辑：类型判定、限额校验、旧数据归一化、文本内联格式。
 */

import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_LIMITS,
  attachmentKind,
  buildTextAttachment,
  clipText,
  createAttachment,
  extOf,
  formatBytes,
  inlineTextAttachment,
  mimeForFile,
  normalizeAttachments,
  safeAttachmentName,
  textFence,
  validateAttachment,
} from "../../../src/lib/attachments";
import type { Attachment } from "../../../src/types";

function image(overrides: Partial<Attachment> = {}): Attachment {
  return { id: "att-1", kind: "image", name: "shot.png", mime: "image/png", size: 1024, path: "/tmp/shot.png", ...overrides };
}

describe("attachmentKind", () => {
  it("mime 优先于扩展名", () => {
    expect(attachmentKind("mystery.bin", "image/png")).toBe("image");
    expect(attachmentKind("mystery.bin", "text/plain")).toBe("text");
  });

  it("mime 不认识时按扩展名兜底", () => {
    expect(attachmentKind("shot.PNG", "")).toBe("image");
    expect(attachmentKind("notes.md", "")).toBe("text");
    expect(attachmentKind("data.json", "")).toBe("text");
  });

  it("两者都不认识 → null", () => {
    expect(attachmentKind("archive.zip", "")).toBeNull();
    expect(attachmentKind("noext", "application/octet-stream")).toBeNull();
  });
});

describe("extOf / mimeForFile", () => {
  it("取小写扩展名，忽略目录与无扩展名", () => {
    expect(extOf("/a/b/photo.JPEG")).toBe("jpeg");
    expect(extOf("C:\\tmp\\a.txt")).toBe("txt");
    expect(extOf("README")).toBe("");
    expect(extOf(".gitignore")).toBe("");
  });

  it("未知扩展名回落到 fallback", () => {
    expect(mimeForFile("a.png")).toBe("image/png");
    expect(mimeForFile("a.unknownext")).toBe("");
    expect(mimeForFile("a.unknownext", "application/octet-stream")).toBe("application/octet-stream");
  });
});

describe("validateAttachment", () => {
  const meta = { name: "shot.png", mime: "image/png", size: 1024 };

  it("合法图片通过", () => {
    expect(validateAttachment(meta, [], true)).toBeNull();
  });

  it("不支持的扩展名被拒", () => {
    expect(validateAttachment({ ...meta, name: "a.zip", mime: "" }, [], true)?.key).toBe("chat.attachUnsupported");
  });

  it("数量超限被拒", () => {
    const existing = Array.from({ length: ATTACHMENT_LIMITS.maxCount }, (_, i) => image({ id: `att-${i}` }));
    expect(validateAttachment(meta, existing, true)?.key).toBe("chat.attachTooMany");
  });

  it("桌面态图片超 10MB 被拒，浏览器态阈值更严", () => {
    const big = { ...meta, size: 5 * 1024 * 1024 };
    expect(validateAttachment(big, [], true)).toBeNull();
    expect(validateAttachment(big, [], false)?.key).toBe("chat.attachTooLarge");
  });

  it("文本超 1MB 被拒", () => {
    const text = { name: "big.log", mime: "text/plain", size: ATTACHMENT_LIMITS.maxTextBytes + 1 };
    expect(validateAttachment(text, [], true)?.key).toBe("chat.attachTooLarge");
  });

  it("总字节超限被拒", () => {
    const existing = [image({ size: ATTACHMENT_LIMITS.maxTotalBytes })];
    expect(validateAttachment(meta, existing, true)?.key).toBe("chat.attachTotalTooLarge");
  });
});

describe("normalizeAttachments", () => {
  it("旧版 string[] 直接丢弃（无法还原文件）", () => {
    expect(normalizeAttachments(["a.png", "b.txt"])).toEqual([]);
  });

  it("非数组归零", () => {
    expect(normalizeAttachments(undefined)).toEqual([]);
    expect(normalizeAttachments("x")).toEqual([]);
  });

  it("缺字段的畸形对象被过滤，合法记录保留并补默认值", () => {
    const raw = [
      { id: "att-1", kind: "image", name: "a.png", path: "/tmp/a.png" },
      { id: "att-2", kind: "text", name: "b.txt" }, // 无 path/dataUrl/text → 丢弃
      { kind: "image", name: "c.png", path: "/tmp/c.png" }, // 无 id → 丢弃
      null,
    ];
    expect(normalizeAttachments(raw)).toEqual([{ id: "att-1", kind: "image", name: "a.png", mime: "", size: 0, path: "/tmp/a.png" }]);
  });

  it("text 内联副本保留", () => {
    const raw = [{ id: "att-3", kind: "text", name: "n.md", mime: "text/markdown", size: 12, text: "# hi", truncated: true }];
    expect(normalizeAttachments(raw)).toEqual([
      { id: "att-3", kind: "text", name: "n.md", mime: "text/markdown", size: 12, text: "# hi", truncated: true },
    ]);
  });
});

describe("createAttachment", () => {
  it("分配唯一 id 并保留载荷", () => {
    const a = createAttachment({ kind: "image", name: "a.png", mime: "image/png", size: 1, dataUrl: "data:x" });
    const b = createAttachment({ kind: "image", name: "b.png", mime: "image/png", size: 1, dataUrl: "data:y" });
    expect(a.id).not.toBe(b.id);
    expect(a.dataUrl).toBe("data:x");
  });
});

describe("clipText", () => {
  it("未超限原样返回", () => {
    expect(clipText("abc", 10)).toEqual({ text: "abc", truncated: false });
  });

  it("超限截断并标记", () => {
    const result = clipText("a".repeat(20), 5);
    expect(result).toEqual({ text: "aaaaa", truncated: true });
  });
});

describe("textFence", () => {
  it("无冲突时用三反引号", () => {
    expect(textFence("plain text")).toBe("```");
  });

  it("内容含反引号串时围栏加长", () => {
    expect(textFence("a ``` b")).toBe("````");
    expect(textFence("a ```` b")).toBe("`````");
  });
});

describe("inlineTextAttachment", () => {
  it("带文件名头与围栏", () => {
    expect(inlineTextAttachment("notes.md", "# 标题", false)).toBe("\n\n---\n[附件：notes.md]\n```\n# 标题\n```\n");
  });

  it("截断时追加标记", () => {
    expect(inlineTextAttachment("a.txt", "x", true)).toContain("[...内容过长已截断]");
  });

  it("内容含围栏时加长围栏，避免提前闭合", () => {
    const out = inlineTextAttachment("a.md", "```js\ncode\n```", false);
    expect(out).toContain("````\n```js\ncode\n```\n````");
  });
});

describe("formatBytes", () => {
  it("按量级换算", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

function fakeExisting(count: number): Attachment[] {
  return Array.from({ length: count }, (_, i) =>
    createAttachment({ kind: "text", name: `a${i}.md`, mime: "text/markdown", size: 1, text: "x" }),
  );
}

describe("safeAttachmentName", () => {
  it("去分隔符与控制字符、统一成 .md、空标题走兜底", () => {
    expect(safeAttachmentName("A/B: C")).toBe("A B C.md");
    expect(safeAttachmentName("Page.html")).toBe("Page.md");
    expect(safeAttachmentName("   ")).toBe("web-article.md");
  });
});

describe("buildTextAttachment", () => {
  it("构造文本附件：内容与 .md 名、size 按 UTF-8 计", () => {
    const result = buildTextAttachment("标题", "正文内容", [], true);
    expect("attachment" in result).toBe(true);
    if (!("attachment" in result)) return;
    expect(result.attachment.kind).toBe("text");
    expect(result.attachment.name).toBe("标题.md");
    expect(result.attachment.text).toBe("正文内容");
    expect(result.attachment.mime).toBe("text/markdown");
    expect(result.attachment.size).toBe(new TextEncoder().encode("正文内容").length);
  });

  it("超内联上限时截断并标记 truncated", () => {
    const long = "字".repeat(ATTACHMENT_LIMITS.maxInlineTextChars + 10);
    const result = buildTextAttachment("长文", long, [], true);
    if (!("attachment" in result)) throw new Error("应通过");
    expect(result.attachment.text?.length).toBe(ATTACHMENT_LIMITS.maxInlineTextChars);
    expect(result.attachment.truncated).toBe(true);
  });

  it("附件数已满时返回拒绝（不抛异常）", () => {
    const result = buildTextAttachment("标题", "正文", fakeExisting(ATTACHMENT_LIMITS.maxCount), true);
    expect("rejection" in result).toBe(true);
    if (!("rejection" in result)) return;
    expect(result.rejection.key).toBe("chat.attachTooMany");
  });
});
