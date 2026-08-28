import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { BooleanNumber, NamedStyleType } from "@univerjs/core";
import { buildDocumentData, docxToUniverDocument, type DocParagraph } from "./univer-docx";

function makeDocx(documentXml: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("word/document.xml", documentXml);
  zip.file("[Content_Types].xml", "<Types/>");
  return zip.generateAsync({ type: "uint8array" });
}

describe("buildDocumentData", () => {
  it("serializes runs and paragraph breaks", () => {
    const paras: DocParagraph[] = [{ runs: [{ text: "Alpha" }, { text: "Bold", bold: true }] }, { runs: [{ text: "Two" }] }];
    const doc = buildDocumentData(paras);
    expect(doc.body?.dataStream).toBe("AlphaBold\r\nTwo\r\n");
    expect(doc.body?.paragraphs).toHaveLength(2);
    expect(doc.body?.paragraphs?.[0].startIndex).toBe(9); // index of first '\r'
    expect(doc.body?.sectionBreaks?.[0].startIndex).toBe(16); // full dataStream length
  });

  it("emits text styles only for styled runs", () => {
    const doc = buildDocumentData([{ runs: [{ text: "x", bold: true, fontSizePt: 20, color: "#ABCDEF" }] }]);
    const run = doc.body?.textRuns?.[0];
    expect(run).toMatchObject({ st: 0, ed: 1, ts: { bl: BooleanNumber.TRUE, fs: 20, cl: { rgb: "#ABCDEF" } } });
  });

  it("maps heading levels to named styles", () => {
    const doc = buildDocumentData([{ runs: [{ text: "Title" }], heading: 1 }]);
    expect(doc.body?.paragraphs?.[0].paragraphStyle?.namedStyleType).toBe(NamedStyleType.HEADING_1);
  });
});

describe("docxToUniverDocument", () => {
  it("parses headings, bold, size (half-points→pt) and color", async () => {
    const xml = `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading2"/></w:pPr>
      <w:r>
        <w:rPr><w:b/><w:sz w:val="28"/><w:color w:val="FF0000"/></w:rPr>
        <w:t>Hello</w:t>
      </w:r>
    </w:p>
    <w:p><w:r><w:t>World</w:t></w:r></w:p>
  </w:body>
</w:document>`;
    const doc = await docxToUniverDocument(await makeDocx(xml));
    const stream = doc.body?.dataStream ?? "";
    expect(stream).toContain("Hello");
    expect(stream).toContain("World");
    expect(doc.body?.paragraphs?.[0].paragraphStyle?.namedStyleType).toBe(NamedStyleType.HEADING_2);
    const run = doc.body?.textRuns?.[0];
    expect(run?.ts?.bl).toBe(BooleanNumber.TRUE);
    expect(run?.ts?.fs).toBe(14); // 28 half-points → 14pt
    expect(run?.ts?.cl).toEqual({ rgb: "#FF0000" });
  });

  it('treats <w:b w:val="false"/> as not bold', async () => {
    const xml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body><w:p><w:r><w:rPr><w:b w:val="false"/></w:rPr><w:t>no</w:t></w:r></w:p></w:body></w:document>`;
    const doc = await docxToUniverDocument(await makeDocx(xml));
    expect(doc.body?.textRuns).toBeUndefined();
  });
});
