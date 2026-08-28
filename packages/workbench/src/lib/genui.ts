/**
 * GenUI 生成器：结构化描述 → 静态 HTML 可视化产物。
 *
 * 产出为无脚本静态 HTML（sandbox iframe 可直接安全渲染）：
 * - 标题 + 副标题 + KPI 卡 + 数据表
 * - 所有动态文本经 HTML 转义，防注入（产物可能被投喂不可信输入）
 */
export interface GenUiSpec {
  title: string;
  subtitle?: string;
  kpis?: { label: string; value: string }[];
  table?: { headers: string[]; rows: string[][] };
}

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function specToHtml(spec: GenUiSpec): string {
  const kpis = (spec.kpis ?? [])
    .map((kpi) => `<div class="kpi"><span>${esc(kpi.label)}</span><b>${esc(kpi.value)}</b></div>`)
    .join("\n      ");

  let table = "";
  if (spec.table) {
    const head = spec.table.headers.map((cell) => `<th>${esc(cell)}</th>`).join("");
    const body = spec.table.rows.map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join("")}</tr>`).join("\n      ");
    table = `<table>\n      <thead><tr>${head}</tr></thead>\n      <tbody>\n      ${body}\n      </tbody>\n    </table>`;
  }

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 24px; font-family: ui-sans-serif, system-ui, "Noto Sans SC", sans-serif; background: #fafaf9; color: #292524; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #78716c; font-size: 13px; margin-bottom: 16px; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .kpi { background: #fff; border: 1px solid #e7e5e4; border-radius: 10px; padding: 12px 14px; }
  .kpi b { display: block; font-size: 22px; margin-top: 4px; }
  .kpi span { color: #a8a29e; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e7e5e4; border-radius: 10px; overflow: hidden; font-size: 13px; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #f5f5f4; }
  th { background: #1c1917; color: #fff; font-weight: 600; }
  .tag { display: inline-block; margin-bottom: 12px; padding: 3px 8px; border-radius: 999px; background: #fef3c7; color: #92400e; font-size: 11px; }
</style>
</head>
<body>
  <span class="tag">GenUI · GreyWork</span>
  <h1>${esc(spec.title)}</h1>
  ${spec.subtitle ? `<p class="sub">${esc(spec.subtitle)}</p>` : ""}
  ${kpis ? `<div class="kpis">\n      ${kpis}\n    </div>` : ""}
  ${table}
</body>
</html>`;
}

/** 从意图文本提取看板标题（尽力而为：取目标词前名词短语，剥离常见动词前缀）。 */
export function extractDashboardTitle(intent: string): string {
  const match = intent.match(/([^\n，。,.]{1,14}?)(?:界面|仪表盘|看板|dashboard|genui)/i);
  const raw = match?.[1]?.trim() ?? "";
  const title = raw.replace(/^(?:帮我生成|请帮我|帮我做|生成一个|做一个|帮我|创建个|生成|创建|做个|做|来|给|给我|一个|请)+/, "").trim();
  return title.length > 0 ? title : "数据看板";
}
