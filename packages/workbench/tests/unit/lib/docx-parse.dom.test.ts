import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { parseDocx, type DocxParagraph, type DocxTable } from "@/lib/docx-parse";

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const R_NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const WP_NS = 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';

/** 20 twip = 1pt，15 twip = 1px。 */
const TWIP_PER_PX = 15;

interface DocxFixture {
  body: string;
  styles?: string;
  numbering?: string;
  /** 关系表条目（图片 / 外链）。 */
  rels?: string;
  /** 额外的包内文件（图片字节）。 */
  media?: Record<string, Uint8Array>;
}

async function buildDocx(fixture: DocxFixture): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<?xml version="1.0"?><w:document ${W_NS} ${R_NS} ${A_NS} ${WP_NS}><w:body>${fixture.body}</w:body></w:document>`,
  );
  if (fixture.styles) zip.file("word/styles.xml", `<?xml version="1.0"?><w:styles ${W_NS}>${fixture.styles}</w:styles>`);
  if (fixture.numbering) {
    zip.file("word/numbering.xml", `<?xml version="1.0"?><w:numbering ${W_NS}>${fixture.numbering}</w:numbering>`);
  }
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${fixture.rels ?? ""}</Relationships>`,
  );
  for (const [path, bytes] of Object.entries(fixture.media ?? {})) zip.file(path, bytes);
  return zip.generateAsync({ type: "uint8array" });
}

const paragraphs = (blocks: { kind: string }[]): DocxParagraph[] =>
  blocks.filter((block): block is DocxParagraph => block.kind === "paragraph");

describe("parseDocx", () => {
  it("run 级格式：粗体/斜体/下划线/删除线/字号（半磅）/颜色/字体", async () => {
    const doc = await parseDocx(
      await buildDocx({
        body: `<w:p>
          <w:r><w:rPr><w:b/><w:sz w:val="28"/><w:color w:val="FF0000"/><w:rFonts w:ascii="Inter"/></w:rPr><w:t>粗体</w:t></w:r>
          <w:r><w:rPr><w:i/><w:u w:val="single"/><w:strike/></w:rPr><w:t>其它</w:t></w:r>
        </w:p>`,
      }),
    );

    const [first, second] = paragraphs(doc.blocks)[0].runs;
    expect(first).toMatchObject({ text: "粗体", bold: true, sizePt: 14, color: "#FF0000", font: "Inter" });
    expect(second).toMatchObject({ text: "其它", italic: true, underline: true, strike: true });
  });

  it('`<w:b w:val="0"/>` 能关掉样式里继承来的粗体', async () => {
    const doc = await parseDocx(
      await buildDocx({
        styles: `<w:style w:styleId="Strong"><w:name w:val="Strong"/><w:rPr><w:b/></w:rPr></w:style>`,
        body: `<w:p><w:pPr><w:pStyle w:val="Strong"/></w:pPr>
          <w:r><w:t>继承粗体</w:t></w:r>
          <w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t>显式取消</w:t></w:r>
        </w:p>`,
      }),
    );

    const runs = paragraphs(doc.blocks)[0].runs;
    expect(runs[0].bold).toBe(true);
    expect(runs[1].bold).toBe(false);
  });

  it("标题层级从样式链解析：outlineLvl 与样式名都认，basedOn 可继承", async () => {
    const doc = await parseDocx(
      await buildDocx({
        styles: `
          <w:style w:styleId="H1"><w:name w:val="heading 1"/></w:style>
          <w:style w:styleId="Base"><w:name w:val="Base"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr></w:style>
          <w:style w:styleId="Derived"><w:name w:val="Derived"/><w:basedOn w:val="Base"/></w:style>`,
        body: `<w:p><w:pPr><w:pStyle w:val="H1"/></w:pPr><w:r><w:t>一级标题</w:t></w:r></w:p>
               <w:p><w:pPr><w:pStyle w:val="Derived"/></w:pPr><w:r><w:t>三级标题</w:t></w:r></w:p>
               <w:p><w:r><w:t>正文</w:t></w:r></w:p>`,
      }),
    );

    const list = paragraphs(doc.blocks);
    expect(list[0].heading).toBe(1);
    // outlineLvl 是 0 基：2 → 三级标题；且经 basedOn 继承而来
    expect(list[1].heading).toBe(3);
    expect(list[2].heading).toBeNull();
  });

  it("表格结构成形：列宽、gridSpan、vMerge 折算成 rowSpan、单元格底色", async () => {
    const doc = await parseDocx(
      await buildDocx({
        body: `<w:tbl>
          <w:tblGrid><w:gridCol w:w="${30 * TWIP_PER_PX}"/><w:gridCol w:w="${60 * TWIP_PER_PX}"/></w:tblGrid>
          <w:tr>
            <w:tc><w:tcPr><w:vMerge w:val="restart"/><w:shd w:fill="1C1917"/></w:tcPr><w:p><w:r><w:t>纵跨</w:t></w:r></w:p></w:tc>
            <w:tc><w:p><w:r><w:t>右上</w:t></w:r></w:p></w:tc>
          </w:tr>
          <w:tr>
            <w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc>
            <w:tc><w:p><w:r><w:t>右下</w:t></w:r></w:p></w:tc>
          </w:tr>
          <w:tr>
            <w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>横跨</w:t></w:r></w:p></w:tc>
          </w:tr>
        </w:tbl>`,
      }),
    );

    const table = doc.blocks.find((block): block is DocxTable => block.kind === "table");
    expect(table).toBeDefined();
    expect(table!.colWidths).toEqual([30, 60]);

    const [firstRow, secondRow, thirdRow] = table!.rows;
    // restart 的格吃掉下一行的 continue 格 → rowSpan 2，续格标 covered 不渲染
    expect(firstRow.cells[0]).toMatchObject({ rowSpan: 2, covered: false, fill: "#1C1917" });
    expect(secondRow.cells[0].covered).toBe(true);
    expect(thirdRow.cells[0].colSpan).toBe(2);
    // 单元格内容仍是块列表（可再嵌套表格）
    expect(paragraphs(firstRow.cells[0].blocks)[0].runs[0].text).toBe("纵跨");
  });

  it("表格里的段落不再被拍平成顶层段落（旧正则实现的主要缺陷）", async () => {
    const doc = await parseDocx(
      await buildDocx({
        body: `<w:p><w:r><w:t>正文</w:t></w:r></w:p>
               <w:tbl><w:tr><w:tc><w:p><w:r><w:t>格内文字</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`,
      }),
    );

    expect(doc.blocks.map((block) => block.kind)).toEqual(["paragraph", "table"]);
    expect(paragraphs(doc.blocks).map((p) => p.runs[0]?.text)).toEqual(["正文"]);
  });

  it("有序列表按层级计数，进入浅层时重置深层编号", async () => {
    const numbering = `
      <w:abstractNum w:abstractNumId="0">
        <w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>
        <w:lvl w:ilvl="1"><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2)"/></w:lvl>
      </w:abstractNum>
      <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`;
    const item = (ilvl: number, text: string) =>
      `<w:p><w:pPr><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
    const body = `${item(0, "一")}${item(1, "甲")}${item(1, "乙")}${item(0, "二")}${item(1, "丙")}`;
    const doc = await parseDocx(await buildDocx({ numbering, body }));

    const markers = paragraphs(doc.blocks).map((p) => p.list?.marker);
    expect(markers).toEqual(["1.", "a)", "b)", "2.", "a)"]);
  });

  it("项目符号列表：私用区码位（Wingdings）换成通用符号", async () => {
    const numbering = `
      <w:abstractNum w:abstractNumId="0">
        <w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="\uF0B7"/></w:lvl>
      </w:abstractNum>
      <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`;
    const doc = await parseDocx(
      await buildDocx({
        numbering,
        body: `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>要点</w:t></w:r></w:p>`,
      }),
    );

    const list = paragraphs(doc.blocks)[0].list;
    expect(list).toMatchObject({ ordered: false, level: 0, marker: "•" });
  });

  it("编号超出单字符范围：字母走双射 26 进制（z→aa），中文计数补到两位", async () => {
    const numbering = `
      <w:abstractNum w:abstractNumId="0">
        <w:lvl w:ilvl="0"><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%1."/></w:lvl>
      </w:abstractNum>
      <w:abstractNum w:abstractNumId="1">
        <w:lvl w:ilvl="0"><w:numFmt w:val="chineseCounting"/><w:lvlText w:val="%1、"/></w:lvl>
      </w:abstractNum>
      <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
      <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>`;
    const item = (numId: number, text: string) =>
      `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;

    const letters = paragraphs(
      (await parseDocx(await buildDocx({ numbering, body: Array.from({ length: 27 }, (_, i) => item(1, `L${i}`)).join("") }))).blocks,
    ).map((p) => p.list?.marker);
    // 第 26 项 z、第 27 项回绕到 aa（旧实现 (index-1)%26 会退回 "a"）
    expect(letters[25]).toBe("z.");
    expect(letters[26]).toBe("aa.");

    const chinese = paragraphs(
      (await parseDocx(await buildDocx({ numbering, body: Array.from({ length: 11 }, (_, i) => item(2, `C${i}`)).join("") }))).blocks,
    ).map((p) => p.list?.marker);
    // 第 10 项十、第 11 项十一（旧实现从第 11 项起退回阿拉伯数字）
    expect(chinese[9]).toBe("十、");
    expect(chinese[10]).toBe("十一、");
  });

  it("具名高亮映射成 hex：CSS 认不出 darkYellow 这类关键字，直接照搬会让高亮消失", async () => {
    const doc = await parseDocx(
      await buildDocx({
        body: `<w:p>
          <w:r><w:rPr><w:highlight w:val="darkYellow"/></w:rPr><w:t>深黄</w:t></w:r>
          <w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>黄</w:t></w:r>
        </w:p>`,
      }),
    );
    const runs = paragraphs(doc.blocks)[0].runs;
    expect(runs[0].highlight).toBe("#808000");
    expect(runs[1].highlight).toBe("#FFFF00");
  });

  it("内联图片解析成 data URL，超链接只留外部目标", async () => {
    const doc = await parseDocx(
      await buildDocx({
        rels: `<Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/pic.png"/>
               <Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/>`,
        media: { "word/media/pic.png": new Uint8Array([1, 2, 3]) },
        body: `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="${96 * 9525}" cy="${48 * 9525}"/>
                 <wp:docPr descr="示意图"/><a:graphic><a:graphicData><a:blip r:embed="rIdImg"/></a:graphicData></a:graphic>
               </wp:inline></w:drawing></w:r></w:p>
               <w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>官网</w:t></w:r></w:hyperlink></w:p>`,
      }),
    );

    const [imageParagraph, linkParagraph] = paragraphs(doc.blocks);
    const image = imageParagraph.runs[0].image;
    expect(image?.src.startsWith("data:image/png;base64,")).toBe(true);
    expect(image).toMatchObject({ width: 96, height: 48, alt: "示意图" });
    expect(linkParagraph.runs[0]).toMatchObject({ text: "官网", link: "https://example.com" });
  });

  it("段落对齐、缩进、间距与正文宽度按 twip 换算", async () => {
    const doc = await parseDocx(
      await buildDocx({
        body: `<w:p>
            <w:pPr><w:jc w:val="center"/><w:ind w:left="${24 * TWIP_PER_PX}"/><w:spacing w:before="${6 * TWIP_PER_PX}" w:after="${12 * TWIP_PER_PX}"/></w:pPr>
            <w:r><w:t>居中段</w:t></w:r>
          </w:p>
          <w:sectPr><w:pgSz w:w="${800 * TWIP_PER_PX}"/><w:pgMar w:left="${100 * TWIP_PER_PX}" w:right="${100 * TWIP_PER_PX}"/></w:sectPr>`,
      }),
    );

    expect(paragraphs(doc.blocks)[0]).toMatchObject({ align: "center", indent: 24, spaceBefore: 6, spaceAfter: 12 });
    // 正文宽 = 页宽 - 左右页边距
    expect(doc.contentWidth).toBe(600);
  });

  it("缺 document.xml 时返回空文档而不是抛错", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    const doc = await parseDocx(await zip.generateAsync({ type: "uint8array" }));
    expect(doc.blocks).toEqual([]);
    expect(doc.contentWidth).toBeGreaterThan(0);
  });
});
