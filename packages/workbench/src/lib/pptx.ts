import pptxgen from "pptxgenjs";

/** 一页简报的声明式描述。 */
export interface PptxSlide {
  title: string;
  /** 要点列表（字符串或带层级）。 */
  bullets?: string[];
  /** 可选数据表：首行为表头（加粗）。 */
  table?: { headers: string[]; rows: string[][] };
}

/** 简报整体：封面 + 若干页。 */
export interface PptxDeck {
  title: string;
  subtitle?: string;
  slides: PptxSlide[];
}

/**
 * 将声明式结构渲染为 .pptx 二进制（pptxgenjs）。
 * 封面：大标题 + 副标题；内容页：标题 + 要点 + 可选数据表。
 */
export async function exportToPptx(deck: PptxDeck): Promise<Uint8Array> {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_16x9";
  pptx.author = "GreyWork";
  pptx.company = "GreyWork";

  // 封面
  const cover = pptx.addSlide();
  cover.background = { color: "F59E0B" };
  cover.addText(deck.title, {
    x: 0.6,
    y: 2.0,
    w: "80%",
    h: 1.2,
    fontSize: 40,
    bold: true,
    color: "1C1917",
    align: "left",
  });
  if (deck.subtitle) {
    cover.addText(deck.subtitle, {
      x: 0.6,
      y: 3.3,
      w: "80%",
      h: 0.6,
      fontSize: 18,
      color: "44403C",
      align: "left",
    });
  }

  // 内容页（pptxgenjs 要求至少一页；空 slides 时补一页占位）
  const slides = (deck.slides ?? []).length > 0 ? deck.slides : [{ title: deck.title }];
  for (const slide of slides) {
    const page = pptx.addSlide();
    page.addText(slide.title, { x: 0.5, y: 0.35, w: "90%", h: 0.7, fontSize: 26, bold: true, color: "1C1917" });
    let yCursor = 1.2;
    if (slide.bullets?.length) {
      const bullets = slide.bullets.map((text) => ({ text, options: { bullet: { code: "2022" }, color: "292524" } }));
      page.addText(bullets, { x: 0.6, y: yCursor, w: "88%", h: 3.2, fontSize: 15, valign: "top" });
      yCursor += Math.min(bullets.length * 0.45 + 0.4, 3.4);
    }
    if (slide.table) {
      const { headers, rows } = slide.table;
      const body = [headers, ...rows].map((row, rowIndex) =>
        row.map((cell) => ({
          text: cell,
          options: {
            bold: rowIndex === 0,
            color: rowIndex === 0 ? "FFFFFF" : "292524",
            fill: rowIndex === 0 ? { color: "1C1917" } : { color: "FAFAF9" },
          },
        })),
      );
      page.addTable(body, { x: 0.6, y: yCursor, w: "88%", fontSize: 12, border: { pt: 0.5, color: "E7E5E4" } });
    }
  }

  const buffer = await pptx.write({ outputType: "nodebuffer" });
  return new Uint8Array(buffer as ArrayBuffer);
}

/** 结果集 → 单页数据表简报。 */
export function resultSetToDeck(title: string, subtitle: string, headers: string[], rows: string[][]): PptxDeck {
  return { title, subtitle, slides: [{ title: "数据结果", table: { headers, rows } }] };
}
