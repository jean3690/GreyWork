/**
 * pptx → Univer ISlideData 转换（产物查看器视觉渲染用）。
 *
 * 解压 pptx（OOXML）逐页提取文本，每页映射为一个 Univer 幻灯片页，
 * 页内以富文本元素承载该页文字，再经 Univer Slides 插件渲染。与 docx 一致，
 * Univer 前端无原生 pptx 导入，此处自行转换，定位为基础视觉还原。
 */
import JSZip from "jszip";
import { buildDocumentData, type DocParagraph } from "./univer-docx";
import { DEFAULT_SLIDE, PageElementType, PageType, type ISlideData, type ISlidePage } from "@univerjs/slides";

const SLIDE_RE = /^ppt\/slides\/slide(\d+)\.xml$/;

/** 提取单页 pptx 的段落文本（每 <a:p> 一行）。 */
function extractSlideParagraphs(xml: string): DocParagraph[] {
  const paras: DocParagraph[] = [];
  const pRe = /<a:p[ >][\s\S]*?<\/a:p>/g;
  let pm: RegExpExecArray | null;
  while ((pm = pRe.exec(xml)) !== null) {
    const pXml = pm[0];
    const texts: string[] = [];
    const tRe = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g;
    let tm: RegExpExecArray | null;
    while ((tm = tRe.exec(pXml)) !== null) texts.push(tm[1]);
    const text = texts.join("");
    paras.push({ runs: text ? [{ text }] : [] });
  }
  return paras.length ? paras : [{ runs: [] }];
}

/** 读取 pptx 二进制并转换为 Univer 幻灯片快照。 */
export async function pptxToUniverSlides(data: Uint8Array): Promise<ISlideData> {
  const zip = await JSZip.loadAsync(data);
  const paths = Object.keys(zip.files)
    .filter((p) => SLIDE_RE.test(p))
    .sort((a, b) => Number(SLIDE_RE.exec(a)![1]) - Number(SLIDE_RE.exec(b)![1]));

  const pages: Record<string, ISlidePage> = {};
  const pageOrder: string[] = [];

  for (let i = 0; i < paths.length; i++) {
    const xml = await zip.files[paths[i]].async("text");
    const doc = buildDocumentData(extractSlideParagraphs(xml));
    const pageId = `page-${i}`;
    const elId = `el-${i}`;
    const page: ISlidePage = {
      id: pageId,
      pageType: PageType.SLIDE,
      zIndex: 1,
      title: `Slide ${i + 1}`,
      description: "",
      pageBackgroundFill: { rgb: "#FFFFFF" },
      pageElements: {
        [elId]: {
          id: elId,
          zIndex: 1,
          title: "Text",
          description: "",
          type: PageElementType.TEXT,
          richText: { left: 60, top: 60, width: 840, height: 460, rich: doc },
        },
      },
    };
    pages[pageId] = page;
    pageOrder.push(pageId);
  }

  return {
    id: `slide-${Date.now()}`,
    title: DEFAULT_SLIDE.title,
    pageSize: { ...DEFAULT_SLIDE.pageSize },
    body: { pages, pageOrder },
  };
}
