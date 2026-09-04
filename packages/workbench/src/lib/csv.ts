/**
 * CSV 解析（TableViewer 用）。
 *
 * 手写而非引依赖，与 `lib/markdown.ts` 同一立场：预览只需要「切成格子」，
 * 不需要类型推断、流式、方言配置。一个 60 行的状态机换掉一个依赖是划算的。
 *
 * 覆盖 RFC 4180 的实际常见部分：双引号包裹字段、字段内逗号与换行、`""` 转义引号、
 * CRLF 与 LF 混用。不支持自定义分隔符 —— 需要时再加，不预留。
 */

/** 把 CSV 文本切成二维数组。末尾空行忽略；空输入返回 `[]`。 */
export function parseCsv(text: string): string[][] {
  if (text === "") return [];

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;

  const endField = (): void => {
    row.push(field);
    field = "";
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        // `""` 是转义的引号，单个 `"` 才是收尾 —— 看下一个字符决定。
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }

    if (char === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (char === ",") {
      endField();
      i += 1;
      continue;
    }
    if (char === "\r") {
      // CRLF 与裸 CR 都当行尾，避免把 \r 留进字段值里（Excel 导出常见）。
      endRow();
      i += text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (char === "\n") {
      endRow();
      i += 1;
      continue;
    }

    field += char;
    i += 1;
  }

  // 收尾：最后一行没有换行符时仍要提交；但「只有一个空字段」说明文本以换行结束，丢掉。
  if (field !== "" || row.length > 0) endRow();

  return rows;
}

/** 首行当表头；只有一行时 body 为空数组而不是 undefined。 */
export function splitHeader(rows: string[][]): { header: string[]; body: string[][] } {
  if (rows.length === 0) return { header: [], body: [] };
  return { header: rows[0], body: rows.slice(1) };
}
