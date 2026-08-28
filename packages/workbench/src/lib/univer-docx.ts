/**
 * docx → Univer IDocumentData 转换（产物查看器视觉渲染用）。
 *
 * 解压 docx（OOXML）提取段落与文本片段，映射为 Univer 文档快照，再经
 * UniverDocsCorePreset 渲染。Univer 前端无原生 docx 导入，故在此自行转换
 * （与 univer-xlsx 的自定义转换策略一致，定位为基础视觉还原，非像素级保真）。
 *
 * 解析采用正则（非 DOMParser），保证 Node 环境可单测，且浏览器/Node 行为一致。
 */
import JSZip from "jszip";
import {
  BooleanNumber,
  HorizontalAlign,
  LocaleType,
  NamedStyleType,
  type IDocumentData,
  type IParagraph,
  type IParagraphStyle,
  type ITextRun,
  type ITextStyle,
} from "@univerjs/core";

/** 一个文本片段（run）及其基础格式。 */
export interface DocRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  fontSizePt?: number;
  color?: string; // "#RRGGBB"
  fontFamily?: string;
}

/** 一个段落：若干 run + 段落级样式。 */
export interface DocParagraph {
  runs: DocRun[];
  heading?: "title" | "subtitle" | 1 | 2 | 3 | 4 | 5;
  align?: "left" | "center" | "right" | "justify";
}

const HEADING_MAP: Record<string, NamedStyleType | undefined> = {
  title: NamedStyleType.TITLE,
  subtitle: NamedStyleType.SUBTITLE,
  "1": NamedStyleType.HEADING_1,
  "2": NamedStyleType.HEADING_2,
  "3": NamedStyleType.HEADING_3,
  "4": NamedStyleType.HEADING_4,
  "5": NamedStyleType.HEADING_5,
  "6": NamedStyleType.HEADING_5,
};

const ALIGN_MAP: Record<string, HorizontalAlign | undefined> = {
  left: HorizontalAlign.LEFT,
  center: HorizontalAlign.CENTER,
  right: HorizontalAlign.RIGHT,
  both: HorizontalAlign.JUSTIFIED,
  justify: HorizontalAlign.JUSTIFIED,
};

function toTextStyle(run: DocRun): ITextStyle {
  const ts: ITextStyle = {};
  if (run.bold) ts.bl = BooleanNumber.TRUE;
  if (run.italic) ts.it = BooleanNumber.TRUE;
  if (run.strike) ts.st = { s: BooleanNumber.TRUE };
  if (run.fontSizePt) ts.fs = run.fontSizePt;
  if (run.fontFamily) ts.ff = run.fontFamily;
  if (run.color) ts.cl = { rgb: run.color };
  return ts;
}

function toParagraphStyle(p: DocParagraph): IParagraphStyle | undefined {
  const style: IParagraphStyle = {};
  let has = false;
  if (p.heading !== undefined) {
    const ns = HEADING_MAP[String(p.heading)];
    if (ns !== undefined) {
      style.namedStyleType = ns;
      has = true;
    }
  }
  if (p.align) {
    const a = ALIGN_MAP[p.align];
    if (a !== undefined) {
      style.horizontalAlign = a;
      has = true;
    }
  }
  return has ? style : undefined;
}

/**
 * 将结构化段落列表构建为 Univer 文档快照。
 * dataStream 以 `\r\n` 分隔段落，paragraphs[i].startIndex 指向该段 `\r` 的索引。
 */
export function buildDocumentData(paragraphs: DocParagraph[]): IDocumentData {
  let dataStream = "";
  const textRuns: ITextRun[] = [];
  const paraList: IParagraph[] = [];

  for (const p of paragraphs) {
    for (const run of p.runs) {
      if (!run.text) continue;
      const st = dataStream.length;
      dataStream += run.text;
      const ed = dataStream.length;
      if (run.bold || run.italic || run.strike || run.fontSizePt || run.fontFamily || run.color) {
        textRuns.push({ st, ed, ts: toTextStyle(run) });
      }
    }
    const breakIndex = dataStream.length;
    dataStream += "\r\n";
    paraList.push({ startIndex: breakIndex, paragraphStyle: toParagraphStyle(p) });
  }

  return {
    id: `doc-${Date.now()}`,
    locale: LocaleType.ZH_CN,
    documentStyle: {},
    body: {
      dataStream,
      textRuns: textRuns.length ? textRuns : undefined,
      paragraphs: paraList,
      sectionBreaks: [{ startIndex: dataStream.length }],
    },
  };
}

/** docx 布尔属性：`<w:b/>` 为真；`<w:b w:val="0|false|none"/>` 为假。 */
function flag(xml: string, tag: string): boolean {
  const re = new RegExp(`<w:${tag}\\b([^>]*)>`, "g");
  const m = re.exec(xml);
  if (!m) return false;
  return !/w:val="(?:0|false|none)"/.test(m[1] ?? "");
}

function attr(xml: string, tag: string, name: string): string | undefined {
  const re = new RegExp(`<w:${tag}\\b[^>]*\\b${name}="([^"]+)"`);
  const m = re.exec(xml);
  return m?.[1];
}

/** 提取一个 w:r 的文本内容（含 tab / 换行符）。 */
function extractRunText(rXml: string): string {
  let out = "";
  const tRe = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
  let tm: RegExpExecArray | null;
  while ((tm = tRe.exec(rXml)) !== null) out += tm[1];
  out += (rXml.match(/<w:tab\/>/g) ?? []).map(() => "\t").join("");
  out += (rXml.match(/<w:br\/>|<w:cr\/>/g) ?? []).map(() => "\n").join("");
  return out;
}

/** 读取 docx 二进制并转换为 Univer 文档快照。 */
export async function docxToUniverDocument(data: Uint8Array): Promise<IDocumentData> {
  const zip = await JSZip.loadAsync(data);
  const file = zip.file("word/document.xml");
  if (!file) return buildDocumentData([]);
  const xml = await file.async("text");

  const paragraphs: DocParagraph[] = [];
  const pRe = /<w:p[ >][\s\S]*?<\/w:p>/g;
  let pm: RegExpExecArray | null;
  while ((pm = pRe.exec(xml)) !== null) {
    const pXml = pm[0];
    const headingVal = attr(pXml, "pStyle", "w:val");
    let heading: DocParagraph["heading"];
    if (headingVal) {
      const hm = /^Heading(\d)$/i.exec(headingVal);
      if (hm) heading = (Number(hm[1]) <= 5 ? Number(hm[1]) : 5) as DocParagraph["heading"];
      else if (/^Title$/i.test(headingVal)) heading = "title";
      else if (/^Subtitle$/i.test(headingVal)) heading = "subtitle";
    }

    const alignVal = attr(pXml, "jc", "w:val");
    const align = alignVal
      ? ALIGN_MAP[alignVal] !== undefined
        ? alignVal === "both"
          ? "justify"
          : (alignVal as DocParagraph["align"])
        : undefined
      : undefined;

    const runs: DocRun[] = [];
    const rRe = /<w:r[ >][\s\S]*?<\/w:r>/g;
    let rm: RegExpExecArray | null;
    while ((rm = rRe.exec(pXml)) !== null) {
      const rXml = rm[0];
      const text = extractRunText(rXml);
      if (!text) continue;
      const run: DocRun = { text };
      if (flag(rXml, "b")) run.bold = true;
      if (flag(rXml, "i")) run.italic = true;
      if (flag(rXml, "strike")) run.strike = true;
      const sz = attr(rXml, "sz", "w:val");
      if (sz) run.fontSizePt = Math.max(1, Math.round(Number(sz) / 2));
      const color = attr(rXml, "color", "w:val");
      if (color && /^[0-9A-Fa-f]{6}$/.test(color)) run.color = `#${color.toUpperCase()}`;
      const rFonts = attr(rXml, "rFonts", "w:ascii") ?? attr(rXml, "rFonts", "w:hAnsi");
      if (rFonts) run.fontFamily = rFonts;
      runs.push(run);
    }

    paragraphs.push({ runs, heading, align });
  }

  return buildDocumentData(paragraphs);
}
