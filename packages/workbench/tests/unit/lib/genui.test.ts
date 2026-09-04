import { describe, expect, it } from "vitest";
import { extractDashboardTitle, specToHtml } from "@/lib/genui";

describe("specToHtml", () => {
  it("渲染 KPI + 表格，动态文本转义防注入", () => {
    const html = specToHtml({
      title: "<script>alert(1)</script>客流",
      subtitle: "sub",
      kpis: [{ label: "总客流", value: "12,384" }],
      table: {
        headers: ["站点", "客流"],
        rows: [["北京站", "4,281"]],
      },
    });
    // 注入文本被转义，不产生可执行脚本
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>站点</th>");
    expect(html).toContain("北京站");
    expect(html).toContain("12,384");
    expect(html).toContain("GenUI · GreyWork");
  });

  it("无 kpi/table 时生成最小页面", () => {
    const html = specToHtml({ title: "T" });
    expect(html).toContain("<h1>T</h1>");
    expect(html).not.toContain("<table>");
    expect(html).not.toContain('class="kpi"');
  });
});

describe("extractDashboardTitle", () => {
  it("提取意图中的看板名", () => {
    expect(extractDashboardTitle("帮我生成站点客流看板")).toBe("站点客流");
    expect(extractDashboardTitle("做一个数据分析仪表盘")).toBe("数据分析");
    expect(extractDashboardTitle("生成界面")).toBe("数据看板"); // 无名词短语回退
  });
});
