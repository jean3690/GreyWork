import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { parsePptx, paragraphFontPt, type PptxTable, type PptxTextBox } from "@/lib/pptx-parse";

/* 1 px = 9525 EMU；下面所有几何都用这个换算写期望值。 */
const PX = 9525;

const THEME = `<?xml version="1.0"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <a:themeElements>
    <a:clrScheme name="Office">
      <a:dk1><a:sysClr val="windowText" lastClr="111111"/></a:dk1>
      <a:lt1><a:sysClr val="window" lastClr="FEFEFE"/></a:lt1>
      <a:dk2><a:srgbClr val="222222"/></a:dk2>
      <a:lt2><a:srgbClr val="EEEEEE"/></a:lt2>
      <a:accent1><a:srgbClr val="4472C4"/></a:accent1>
    </a:clrScheme>
  </a:themeElements>
</a:theme>`;

/** 布局里给 title 占位符一个几何：幻灯片侧不写 xfrm 时要能继承到。 */
const LAYOUT = `<?xml version="1.0"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:sp>
        <p:nvSpPr><p:nvPr><p:ph type="title" idx="1"/></p:nvPr></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="${10 * PX}" y="${20 * PX}"/><a:ext cx="${300 * PX}" cy="${40 * PX}"/></a:xfrm></p:spPr>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sldLayout>`;

const MASTER = `<?xml version="1.0"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>
    <p:spTree/>
  </p:cSld>
</p:sldMaster>`;

function rels(entries: { id: string; type: string; target: string }[]): string {
  const body = entries
    .map(
      (entry) =>
        `<Relationship Id="${entry.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${entry.type}" Target="${entry.target}"/>`,
    )
    .join("");
  return `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`;
}

function slideXml(body: string, background?: string): string {
  return `<?xml version="1.0"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    ${background ? `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${background}"/></a:solidFill></p:bgPr></p:bg>` : ""}
    <p:spTree>${body}</p:spTree>
  </p:cSld>
</p:sld>`;
}

interface DeckFixture {
  /** 幻灯片正文，按 sldIdLst 里要出现的顺序传入 rId。 */
  slides: { file: string; xml: string; notes?: string; image?: boolean }[];
  /** sldIdLst 顺序（file 名数组）；省略 = 与 slides 同序。 */
  order?: string[];
}

async function buildPptx(fixture: DeckFixture): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("ppt/theme/theme1.xml", THEME);
  zip.file("ppt/slideMasters/slideMaster1.xml", MASTER);
  zip.file("ppt/slideLayouts/slideLayout1.xml", LAYOUT);
  zip.file(
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
    rels([{ id: "rId1", type: "slideMaster", target: "../slideMasters/slideMaster1.xml" }]),
  );
  zip.file("ppt/media/image1.png", new Uint8Array([1, 2, 3, 4]));

  const presentationRels = [{ id: "rIdTheme", type: "theme", target: "theme/theme1.xml" }];
  for (const [index, slide] of fixture.slides.entries()) {
    zip.file(`ppt/slides/${slide.file}`, slide.xml);
    const slideRels = [{ id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" }];
    if (slide.notes) {
      const notesFile = slide.file.replace("slide", "notesSlide");
      zip.file(`ppt/notesSlides/${notesFile}`, slide.notes);
      slideRels.push({ id: "rId2", type: "notesSlide", target: `../notesSlides/${notesFile}` });
    }
    if (slide.image) slideRels.push({ id: "rIdImg", type: "image", target: "../media/image1.png" });
    zip.file(`ppt/slides/_rels/${slide.file}.rels`, rels(slideRels));
    presentationRels.push({ id: `rIdS${index}`, type: "slide", target: `slides/${slide.file}` });
  }

  const order = fixture.order ?? fixture.slides.map((slide) => slide.file);
  // 真实 pptx 的 sldId 同时带 id（页号）与 r:id（关系 id），这里**故意只写 r:id**：
  // happy-dom 的 XML 解析会把 `r:id` 归一成 `id` 而与已有的 `id` 撞掉，导致关系 id 直接丢失
  // （真实浏览器两者并存）。被测的是「页序取自 sldIdLst」这条契约，不是属性去重行为。
  const sldIds = order.map((file) => `<p:sldId r:id="rIdS${fixture.slides.findIndex((slide) => slide.file === file)}"/>`).join("");

  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0"?>
<p:presentation xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst>${sldIds}</p:sldIdLst>
  <p:sldSz cx="${960 * PX}" cy="${540 * PX}"/>
</p:presentation>`,
  );
  zip.file("ppt/_rels/presentation.xml.rels", rels(presentationRels));
  return zip.generateAsync({ type: "uint8array" });
}

const TEXT_SHAPE = `
<p:sp>
  <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:nvPr/></p:nvSpPr>
  <p:spPr><a:xfrm><a:off x="${48 * PX}" y="${33 * PX}"/><a:ext cx="${864 * PX}" cy="${67 * PX}"/></a:xfrm></p:spPr>
  <p:txBody>
    <a:bodyPr anchor="ctr"/>
    <a:p>
      <a:pPr algn="ctr"><a:buNone/></a:pPr>
      <a:r>
        <a:rPr sz="2600" b="1"><a:solidFill><a:srgbClr val="1C1917"/></a:solidFill><a:latin typeface="Inter"/></a:rPr>
        <a:t>数据结果</a:t>
      </a:r>
    </a:p>
    <a:p>
      <a:pPr marL="342900"><a:buChar char="•"/></a:pPr>
      <a:r><a:rPr sz="1500"><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:rPr><a:t>要点一</a:t></a:r>
      <a:br/>
      <a:r><a:rPr sz="1500"/><a:t>续行</a:t></a:r>
    </a:p>
  </p:txBody>
</p:sp>`;

const TABLE_FRAME = `
<p:graphicFrame>
  <p:nvGraphicFramePr><p:cNvPr id="3" name="Table"/></p:nvGraphicFramePr>
  <p:xfrm><a:off x="${60 * PX}" y="${300 * PX}"/><a:ext cx="${800 * PX}" cy="${100 * PX}"/></p:xfrm>
  <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
    <a:tbl>
      <a:tblGrid><a:gridCol w="${400 * PX}"/><a:gridCol w="${400 * PX}"/></a:tblGrid>
      <a:tr h="0">
        <a:tc>
          <a:txBody><a:p><a:r><a:rPr sz="1200" b="1"/><a:t>行星</a:t></a:r></a:p></a:txBody>
          <a:tcPr><a:solidFill><a:srgbClr val="1C1917"/></a:solidFill></a:tcPr>
        </a:tc>
        <a:tc gridSpan="2">
          <a:txBody><a:p><a:r><a:rPr sz="1200"/><a:t>直径</a:t></a:r></a:p></a:txBody>
          <a:tcPr/>
        </a:tc>
        <a:tc hMerge="1"><a:txBody><a:p/></a:txBody><a:tcPr/></a:tc>
      </a:tr>
    </a:tbl>
  </a:graphicData></a:graphic>
</p:graphicFrame>`;

describe("parsePptx", () => {
  it("EMU 换算为 px，并把字号/加粗/字体/主题色读进 run", async () => {
    const deck = await parsePptx(await buildPptx({ slides: [{ file: "slide1.xml", xml: slideXml(TEXT_SHAPE) }] }));

    expect(deck.width).toBe(960);
    expect(deck.height).toBe(540);
    expect(deck.slides).toHaveLength(1);

    const text = deck.slides[0].elements.find((el): el is PptxTextBox => el.kind === "text");
    expect(text).toBeDefined();
    expect(text!.rect).toMatchObject({ x: 48, y: 33, w: 864, h: 67 });
    expect(text!.anchor).toBe("center");

    const [title, bullet] = text!.paragraphs;
    expect(title.align).toBe("center");
    expect(title.bullet).toBeNull();
    expect(title.runs[0]).toMatchObject({ text: "数据结果", bold: true, sizePt: 26, color: "#1C1917", font: "Inter" });

    // schemeClr 要经主题色板折算成真实 hex，而不是原样吐出 "accent1"
    expect(bullet.runs[0].color).toBe("#4472C4");
    expect(bullet.bullet).toBe("•");
    expect(bullet.indent).toBeCloseTo(36, 5);
    // <a:br/> 变成段内 "\n"，不另起段落（否则会多一次段间距）
    expect(bullet.runs.map((run) => run.text)).toEqual(["要点一", "\n", "续行"]);
  });

  it("表格保留列宽、单元格填充与合并续格标记", async () => {
    const deck = await parsePptx(await buildPptx({ slides: [{ file: "slide1.xml", xml: slideXml(TABLE_FRAME) }] }));
    const table = deck.slides[0].elements.find((el): el is PptxTable => el.kind === "table");

    expect(table).toBeDefined();
    expect(table!.rect).toMatchObject({ x: 60, y: 300, w: 800, h: 100 });
    expect(table!.colWidths).toEqual([400, 400]);

    const cells = table!.rows[0].cells;
    expect(cells[0].fill).toBe("#1C1917");
    expect(cells[0].paragraphs[0].runs[0]).toMatchObject({ text: "行星", bold: true, sizePt: 12 });
    expect(cells[1].colSpan).toBe(2);
    // hMerge 的续格必须标成 covered：渲染时跳过，否则会多出一列
    expect(cells[2].covered).toBe(true);
  });

  it("页序按 sldIdLst 而不是文件名", async () => {
    const deck = await parsePptx(
      await buildPptx({
        slides: [
          { file: "slide1.xml", xml: slideXml(TEXT_SHAPE) },
          {
            file: "slide2.xml",
            xml: slideXml(
              `<p:sp><p:nvSpPr><p:cNvPr id="9" name="B"/><p:nvPr/></p:nvSpPr>
               <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${10 * PX}" cy="${10 * PX}"/></a:xfrm></p:spPr>
               <p:txBody><a:p><a:r><a:t>第二个文件</a:t></a:r></a:p></p:txBody></p:sp>`,
            ),
          },
        ],
        order: ["slide2.xml", "slide1.xml"],
      }),
    );

    const firstText = deck.slides[0].elements.find((el): el is PptxTextBox => el.kind === "text");
    expect(firstText!.paragraphs[0].runs[0].text).toBe("第二个文件");
    expect(deck.slides[0].index).toBe(1);
    expect(deck.slides[1].index).toBe(2);
  });

  it("背景：幻灯片自身 bgPr 优先，缺省时回落 master 的 bgRef（经主题色板）", async () => {
    const own = await parsePptx(await buildPptx({ slides: [{ file: "slide1.xml", xml: slideXml(TEXT_SHAPE, "F59E0B") }] }));
    expect(own.slides[0].background).toBe("#F59E0B");

    const inherited = await parsePptx(await buildPptx({ slides: [{ file: "slide1.xml", xml: slideXml(TEXT_SHAPE) }] }));
    // master 写的是 schemeClr bg1 → 默认 clrMap 折算到 lt1 → sysClr 的 lastClr
    expect(inherited.slides[0].background).toBe("#FEFEFE");
  });

  it("占位符没有 xfrm 时从 layout 继承几何", async () => {
    const deck = await parsePptx(
      await buildPptx({
        slides: [
          {
            file: "slide1.xml",
            xml: slideXml(
              `<p:sp>
                 <p:nvSpPr><p:cNvPr id="2" name="T"/><p:nvPr><p:ph type="title" idx="1"/></p:nvPr></p:nvSpPr>
                 <p:spPr/>
                 <p:txBody><a:p><a:r><a:t>继承标题</a:t></a:r></a:p></p:txBody>
               </p:sp>`,
            ),
          },
        ],
      }),
    );

    const text = deck.slides[0].elements.find((el): el is PptxTextBox => el.kind === "text");
    expect(text!.rect).toMatchObject({ x: 10, y: 20, w: 300, h: 40 });
  });

  it("组合形状按 chOff/chExt 映射回幻灯片坐标", async () => {
    const deck = await parsePptx(
      await buildPptx({
        slides: [
          {
            file: "slide1.xml",
            xml: slideXml(
              `<p:grpSp>
                 <p:grpSpPr>
                   <a:xfrm>
                     <a:off x="${100 * PX}" y="${100 * PX}"/><a:ext cx="${200 * PX}" cy="${200 * PX}"/>
                     <a:chOff x="0" y="0"/><a:chExt cx="${400 * PX}" cy="${400 * PX}"/>
                   </a:xfrm>
                 </p:grpSpPr>
                 <p:sp>
                   <p:nvSpPr><p:cNvPr id="5" name="In"/><p:nvPr/></p:nvSpPr>
                   <p:spPr><a:xfrm><a:off x="${40 * PX}" y="${40 * PX}"/><a:ext cx="${80 * PX}" cy="${80 * PX}"/></a:xfrm></p:spPr>
                   <p:txBody><a:p><a:r><a:t>组内</a:t></a:r></a:p></p:txBody>
                 </p:sp>
               </p:grpSp>`,
            ),
          },
        ],
      }),
    );

    const text = deck.slides[0].elements.find((el): el is PptxTextBox => el.kind === "text");
    // 子坐标系是 2 倍大，所以 40 → 20，再平移到组合原点 100
    expect(text!.rect).toMatchObject({ x: 120, y: 120, w: 40, h: 40 });
  });

  it("图片解析成 data URL；备注跳过页码占位符", async () => {
    const deck = await parsePptx(
      await buildPptx({
        slides: [
          {
            file: "slide1.xml",
            xml: slideXml(
              `<p:pic>
                 <p:nvPicPr><p:cNvPr id="7" name="星图"/></p:nvPicPr>
                 <p:blipFill><a:blip r:embed="rIdImg"/></p:blipFill>
                 <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${100 * PX}" cy="${50 * PX}"/></a:xfrm></p:spPr>
               </p:pic>`,
            ),
            image: true,
            notes: `<?xml version="1.0"?>
<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:sp>
      <p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:p><a:r><a:t>这是演讲者备注</a:t></a:r></a:p></p:txBody>
    </p:sp>
    <p:sp>
      <p:nvSpPr><p:nvPr><p:ph type="sldNum" idx="10"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:p><a:fld id="x" type="slidenum"><a:t>7</a:t></a:fld></a:p></p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:notes>`,
          },
        ],
      }),
    );

    const picture = deck.slides[0].elements.find((el) => el.kind === "image");
    expect(picture).toMatchObject({ alt: "星图", rect: { x: 0, y: 0, w: 100, h: 50 } });
    expect(picture && "src" in picture ? picture.src.startsWith("data:image/png;base64,") : false).toBe(true);
    // 页码占位符会贡献一个 "7"，粘进备注就成了「这是演讲者备注7」
    expect(deck.slides[0].notes).toBe("这是演讲者备注");
  });

  it("没有 sldIdLst（损坏包）时回落文件名顺序", async () => {
    const zip = new JSZip();
    zip.file(
      "ppt/slides/slide2.xml",
      slideXml(`<p:sp><p:nvSpPr><p:cNvPr id="1" name="a"/><p:nvPr/></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${PX}" cy="${PX}"/></a:xfrm></p:spPr>
      <p:txBody><a:p><a:r><a:t>二</a:t></a:r></a:p></p:txBody></p:sp>`),
    );
    zip.file(
      "ppt/slides/slide1.xml",
      slideXml(`<p:sp><p:nvSpPr><p:cNvPr id="1" name="a"/><p:nvPr/></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${PX}" cy="${PX}"/></a:xfrm></p:spPr>
      <p:txBody><a:p><a:r><a:t>一</a:t></a:r></a:p></p:txBody></p:sp>`),
    );
    const deck = await parsePptx(await zip.generateAsync({ type: "uint8array" }));

    expect(deck.slides).toHaveLength(2);
    const texts = deck.slides.map(
      (slide) => slide.elements.find((el): el is PptxTextBox => el.kind === "text")!.paragraphs[0].runs[0].text,
    );
    expect(texts).toEqual(["一", "二"]);
    // 缺 sldSz 时按 16:9 兜底，否则整叠幻灯片会算出 0 宽度
    expect(deck.width).toBe(960);
    expect(deck.height).toBe(540);
  });
});

describe("paragraphFontPt", () => {
  it("取首个声明了字号的 run；全都没声明则用 18pt 兜底", () => {
    const run = { text: "x", bold: false, italic: false, underline: false, sizePt: null, color: null, font: null };
    expect(paragraphFontPt({ runs: [run], align: null, bullet: null, indent: 0 })).toBe(18);
    expect(paragraphFontPt({ runs: [run, { ...run, sizePt: 32 }], align: null, bullet: null, indent: 0 })).toBe(32);
  });
});
