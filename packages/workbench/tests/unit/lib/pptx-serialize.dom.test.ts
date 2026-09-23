/**
 * pptx 就地文本回写往返：parsePptx 标出每页 a:t 编号 → patchPptxText 只改命中节点 → 重解析核对。
 * 关键契约：命中页命中文本变、其它页与表格结构不变、非文本部件字节保留。
 * 用 jszip 现拼最小 pptx，dom 环境提供 DOMParser / XMLSerializer。
 */
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { parsePptx, type ParsedSlide } from "@/lib/pptx-parse";
import { patchPptxText } from "@/lib/pptx-serialize";

const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const PX = 9525;

const THEME = `<?xml version="1.0"?><a:theme xmlns:a="${A}"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:srgbClr val="111111"/></a:dk1><a:lt1><a:srgbClr val="FEFEFE"/></a:lt1></a:clrScheme></a:themeElements></a:theme>`;
const LAYOUT = `<?xml version="1.0"?><p:sldLayout xmlns:a="${A}" xmlns:p="${P}"><p:cSld><p:spTree/></p:cSld></p:sldLayout>`;
const MASTER = `<?xml version="1.0"?><p:sldMaster xmlns:a="${A}" xmlns:p="${P}"><p:cSld><p:spTree/></p:cSld></p:sldMaster>`;

function rels(entries: { id: string; type: string; target: string }[]): string {
  const body = entries
    .map(
      (e) =>
        `<Relationship Id="${e.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${e.type}" Target="${e.target}"/>`,
    )
    .join("");
  return `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`;
}

function textBox(text: string): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="2" name="t"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${10 * PX}" y="${10 * PX}"/><a:ext cx="${400 * PX}" cy="${60 * PX}"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:rPr sz="2400"/><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
}

const TABLE = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="Table"/></p:nvGraphicFramePr><p:xfrm><a:off x="${10 * PX}" y="${200 * PX}"/><a:ext cx="${400 * PX}" cy="${80 * PX}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblGrid><a:gridCol w="${400 * PX}"/></a:tblGrid><a:tr h="0"><a:tc><a:txBody><a:p><a:r><a:t>格子</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;

function slideXml(body: string): string {
  return `<?xml version="1.0"?><p:sld xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`;
}

async function buildPptx(slideBodies: string[]): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("ppt/theme/theme1.xml", THEME);
  zip.file("ppt/slideMasters/slideMaster1.xml", MASTER);
  zip.file("ppt/slideLayouts/slideLayout1.xml", LAYOUT);
  zip.file(
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
    rels([{ id: "rId1", type: "slideMaster", target: "../slideMasters/slideMaster1.xml" }]),
  );
  zip.file("ppt/media/image1.png", new Uint8Array([9, 8, 7, 6]));

  const presRels = [{ id: "rIdTheme", type: "theme", target: "theme/theme1.xml" }];
  slideBodies.forEach((body, index) => {
    const file = `slide${index + 1}.xml`;
    zip.file(`ppt/slides/${file}`, slideXml(body));
    zip.file(`ppt/slides/_rels/${file}.rels`, rels([{ id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" }]));
    presRels.push({ id: `rIdS${index}`, type: "slide", target: `slides/${file}` });
  });

  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0"?><p:presentation xmlns:r="${R}" xmlns:p="${P}"><p:sldIdLst>${slideBodies
      .map((_, index) => `<p:sldId r:id="rIdS${index}"/>`)
      .join("")}</p:sldIdLst><p:sldSz cx="${960 * PX}" cy="${540 * PX}"/></p:presentation>`,
  );
  zip.file("ppt/_rels/presentation.xml.rels", rels(presRels));
  return zip.generateAsync({ type: "uint8array" });
}

function textRuns(slide: ParsedSlide | undefined): string[] {
  const out: string[] = [];
  for (const element of slide?.elements ?? []) {
    if (element.kind === "text") for (const p of element.paragraphs) for (const run of p.runs) out.push(run.text);
    if (element.kind === "table")
      for (const row of element.rows)
        for (const cell of row.cells) for (const p of cell.paragraphs) for (const run of p.runs) out.push(run.text);
  }
  return out;
}

describe("patchPptxText（就地文本回写往返）", () => {
  it("改第 2 页一个 run：命中文本变，其它页与表格不变，媒体部件保留", async () => {
    const original = await buildPptx([textBox("第一页"), textBox("旧标题") + TABLE]);

    const deck = await parsePptx(original);
    const titleRun = deck.slides[1]?.elements.find((el) => el.kind === "text");
    const editId = titleRun?.kind === "text" ? titleRun.paragraphs[0]?.runs[0]?.editId : null;
    expect(editId).toEqual({ slide: 2, ord: 0 });

    const patched = await patchPptxText(original, new Map([["2:0", "新标题"]]));
    const reparsed = await parsePptx(patched);

    expect(textRuns(reparsed.slides[0])).toEqual(["第一页"]);
    expect(textRuns(reparsed.slides[1])).toEqual(["新标题", "格子"]);

    const media = await (await JSZip.loadAsync(patched)).file("ppt/media/image1.png")?.async("uint8array");
    expect(Array.from(media ?? [])).toEqual([9, 8, 7, 6]);
  });

  it("空编辑：原样返回，不触碰任何页", async () => {
    const original = await buildPptx([textBox("只此一页")]);
    const patched = await patchPptxText(original, new Map());
    expect(textRuns((await parsePptx(patched)).slides[0])).toEqual(["只此一页"]);
  });
});
