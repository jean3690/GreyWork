/**
 * docx 就地文本回写往返：parseDocx 标出 w:t 编号 → patchDocxText 只改命中节点 → 重解析核对。
 * 关键契约：命中文本变、其余 run 与表格结构不变、非文本部件字节保留；复合 run 不可编辑。
 * 用 jszip 现拼最小 docx，dom 环境提供 DOMParser / XMLSerializer。
 */
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { parseDocx, type DocxBlock } from "@/lib/docx-parse";
import { patchDocxText } from "@/lib/docx-serialize";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

async function buildDocx(body: string, extra: Record<string, string> = {}): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}</w:body></w:document>`);
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`,
  );
  for (const [path, content] of Object.entries(extra)) zip.file(path, content);
  return zip.generateAsync({ type: "uint8array" });
}

function paragraphTexts(block: DocxBlock | undefined): string[] {
  return block?.kind === "paragraph" ? block.runs.map((run) => run.text) : [];
}

describe("patchDocxText（就地文本回写往返）", () => {
  it("改一个 run：命中文本变，其余 run 与表格结构不变，非文本部件字节保留", async () => {
    const body =
      "<w:p><w:r><w:t>甲</w:t></w:r><w:r><w:t>乙</w:t></w:r></w:p>" +
      "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>格子</w:t></w:r></w:p></w:tc></w:tr></w:tbl>";
    const original = await buildDocx(body, { "customXml/item1.xml": "<x>keep</x>" });

    const parsed = await parseDocx(original);
    const runs = parsed.blocks[0]?.kind === "paragraph" ? parsed.blocks[0].runs : [];
    expect(runs.map((run) => run.text)).toEqual(["甲", "乙"]);
    expect(runs[0]?.editId).toBe(0);
    expect(runs[1]?.editId).toBe(1);

    const patched = await patchDocxText(original, new Map([[0, "改甲"]]));
    const reparsed = await parseDocx(patched);
    expect(paragraphTexts(reparsed.blocks[0])).toEqual(["改甲", "乙"]);

    const table = reparsed.blocks[1];
    const cellBlock = table?.kind === "table" ? table.rows[0]?.cells[0]?.blocks[0] : undefined;
    expect(paragraphTexts(cellBlock)).toEqual(["格子"]);

    const zip = await JSZip.loadAsync(patched);
    expect(await zip.file("customXml/item1.xml")?.async("string")).toBe("<x>keep</x>");
  });

  it("含 tab 的复合 run 不可编辑（editId 为 null）", async () => {
    const original = await buildDocx("<w:p><w:r><w:t>甲</w:t><w:tab/><w:t>乙</w:t></w:r></w:p>");
    const parsed = await parseDocx(original);
    const first = parsed.blocks[0]?.kind === "paragraph" ? parsed.blocks[0].runs[0] : undefined;
    expect(first?.editId ?? null).toBeNull();
  });

  it("首尾空白回写时补 xml:space=preserve", async () => {
    const original = await buildDocx("<w:p><w:r><w:t>x</w:t></w:r></w:p>");
    const patched = await patchDocxText(original, new Map([[0, "  两侧空白  "]]));
    const xml = await (await JSZip.loadAsync(patched)).file("word/document.xml")!.async("string");
    expect(xml).toContain('xml:space="preserve"');
    expect(xml).toContain("两侧空白");
  });
});
