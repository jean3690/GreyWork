import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { PageElementType, PageType } from "@univerjs/slides";
import { pptxToUniverSlides } from "./univer-pptx";

function makePptx(slides: string[]): Promise<Uint8Array> {
  const zip = new JSZip();
  slides.forEach((body, i) => {
    zip.file(`ppt/slides/slide${i + 1}.xml`, body);
  });
  zip.file("[Content_Types].xml", "<Types/>");
  return zip.generateAsync({ type: "uint8array" });
}

const SLIDE = `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:sp><p:txBody>
    <a:p><a:r><a:t>Title</a:t></a:r></a:p>
    <a:p><a:r><a:t>Body line</a:t></a:r></a:p>
  </p:txBody></p:sp></p:cSld>
</p:sld>`;

describe("pptxToUniverSlides", () => {
  it("creates one slide page per slide xml with text rich element", async () => {
    const data = await pptxToUniverSlides(await makePptx([SLIDE, SLIDE]));
    expect(data.body?.pageOrder).toHaveLength(2);
    expect(Object.keys(data.body?.pages ?? {})).toHaveLength(2);

    const pageId = data.body!.pageOrder[0];
    const page = data.body!.pages[pageId];
    expect(page.pageType).toBe(PageType.SLIDE);
    const el = Object.values(page.pageElements)[0];
    expect(el.type).toBe(PageElementType.TEXT);
    expect(el.richText?.rich?.body?.dataStream).toContain("Title");
    expect(el.richText?.rich?.body?.dataStream).toContain("Body line");
  });

  it("sorts slides by numeric suffix", async () => {
    const zip = new JSZip();
    zip.file("ppt/slides/slide10.xml", SLIDE);
    zip.file("ppt/slides/slide2.xml", SLIDE);
    const data = await pptxToUniverSlides(await zip.generateAsync({ type: "uint8array" }));
    expect(data.body?.pageOrder).toHaveLength(2);
  });
});
