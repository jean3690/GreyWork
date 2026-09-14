/**
 * docx 解析器的**已知保真度边界**（characterization test）。
 *
 * 这里断言的「当前行为」不是期望行为，而是决策依据：自研解析器覆盖了流式正文该有的东西
 * （段落 / 表格 / 列表 / 内联图片 / 超链接 / 样式 —— 见 docx-parse.dom.test.ts），
 * 但**页眉页脚、分栏、分页符、脚注、域、浮动对象**这几类没有实现。
 *
 * 为什么要把它写成测试而不是一段说明：Agent 自己生成的产物只会用到已覆盖的那部分，
 * 而用户从磁盘打开的外部文档几乎一定带页眉页脚和分页符 —— 这两条路径的差距决定了
 * 「要不要引入 LibreOffice 转 PDF」这条重决策。把它固定下来，将来任何一侧发生变化
 * （无论是补了实现，还是改用外部转换）都会在这里显形。
 *
 * 补上某项实现时**必须同步改本文件**，而不是让它默默开始通过。
 */
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { parseDocx, type DocxBlock } from "@/lib/docx-parse";

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const R_NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** 一页 A4 的 sectPr：页宽 11906 twip、左右页边距 1440 twip。 */
const A4_SECT_PR = '<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>';

interface DocxFixture {
  body: string;
  /** 额外的包内部件（页眉 / 脚注等）。 */
  parts?: Record<string, string>;
  rels?: string;
}

async function buildDocx(fixture: DocxFixture): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document ${W_NS} ${R_NS}><w:body>${fixture.body}</w:body></w:document>`);
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${fixture.rels ?? ""}</Relationships>`,
  );
  for (const [path, xml] of Object.entries(fixture.parts ?? {})) {
    zip.file(path, `<?xml version="1.0"?>${xml}`);
  }
  return zip.generateAsync({ type: "uint8array" });
}

/** 递归收集所有 run 文本，用来断言「某段文字有没有进入渲染结果」。 */
function allText(blocks: DocxBlock[]): string {
  let out = "";
  for (const block of blocks) {
    if (block.kind === "paragraph") {
      for (const run of block.runs) out += run.text;
    } else {
      for (const row of block.rows) {
        for (const cell of row.cells) out += allText(cell.blocks);
      }
    }
  }
  return out;
}

describe("docx 保真度边界", () => {
  it("页眉页脚不参与渲染：头部部件根本不读", async () => {
    const doc = await parseDocx(
      await buildDocx({
        body: `<w:p><w:r><w:t>正文</w:t></w:r></w:p><w:sectPr><w:headerReference r:id="rId1" w:type="default"/><w:footerReference r:id="rId2" w:type="default"/>${A4_SECT_PR}</w:sectPr>`,
        parts: {
          "word/header1.xml": `<w:hdr ${W_NS}><w:p><w:r><w:t>公司内部资料</w:t></w:r></w:p></w:hdr>`,
          "word/footer1.xml": `<w:ftr ${W_NS}><w:p><w:r><w:t>第 1 页</w:t></w:r></w:p></w:ftr>`,
        },
        rels: '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>',
      }),
    );

    const text = allText(doc.blocks);
    expect(text).toContain("正文");
    // 已知边界：页眉页脚文本丢失。真实文档里这意味着每页的抬头与页码都不显示。
    expect(text).not.toContain("公司内部资料");
    expect(text).not.toContain("第 1 页");
  });

  it("分页符退化成换行：不拆段，也不产生页边界", async () => {
    const doc = await parseDocx(
      await buildDocx({
        body: `<w:p><w:r><w:t>第一页</w:t></w:r><w:r><w:br w:type="page"/></w:r><w:r><w:t>第二页</w:t></w:r></w:p><w:sectPr>${A4_SECT_PR}</w:sectPr>`,
      }),
    );

    // 已知边界：w:br 一律当换行处理（解析器里 `name === "br"` 只追加 "\n"），
    // 分页语义丢失 —— 两页内容会连排在同一段落里。
    expect(doc.blocks).toHaveLength(1);
    const paragraph = doc.blocks[0];
    if (paragraph.kind !== "paragraph") throw new Error("应为段落");
    const text = paragraph.runs.map((run) => run.text).join("");
    expect(text).toContain("第一页");
    expect(text).toContain("第二页");
    expect(text).toContain("\n");
  });

  it("分栏被忽略：正文宽度只由页宽与页边距决定", async () => {
    const single = await parseDocx(await buildDocx({ body: `<w:p><w:r><w:t>正文</w:t></w:r></w:p><w:sectPr>${A4_SECT_PR}</w:sectPr>` }));
    const twoColumns = await parseDocx(
      await buildDocx({
        body: `<w:p><w:r><w:t>正文</w:t></w:r></w:p><w:sectPr>${A4_SECT_PR}<w:cols w:num="2" w:space="708"/></w:sectPr>`,
      }),
    );

    // 已知边界：w:cols 不参与计算，双栏文档会被排成单栏、宽度按整页算。
    expect(twoColumns.contentWidth).toBe(single.contentWidth);
  });

  it("脚注与批注连部件都不读", async () => {
    const doc = await parseDocx(
      await buildDocx({
        body: `<w:p><w:r><w:t>带脚注的正文</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p><w:sectPr>${A4_SECT_PR}</w:sectPr>`,
        parts: {
          "word/footnotes.xml": `<w:footnotes ${W_NS}><w:footnote w:id="1"><w:p><w:r><w:t>脚注内容</w:t></w:r></w:p></w:footnote></w:footnotes>`,
        },
      }),
    );

    const text = allText(doc.blocks);
    expect(text).toContain("带脚注的正文");
    // 已知边界：脚注标记与脚注正文都丢失。
    expect(text).not.toContain("脚注内容");
  });
});
