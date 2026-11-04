import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { TrendPoint } from "../types";
import TrendBars from "./TrendBars.vue";

const points: TrendPoint[] = [
  { date: "2026-10-28", users: 1, audits: 4, llmRequests: 12 },
  { date: "2026-10-29", users: 3, audits: 6, llmRequests: 9 },
  { date: "2026-10-30", users: 0, audits: 2, llmRequests: 15 },
  { date: "2026-10-31", users: 5, audits: 9, llmRequests: 22 },
  { date: "2026-11-01", users: 2, audits: 5, llmRequests: 18 },
  { date: "2026-11-02", users: 4, audits: 3, llmRequests: 27 },
  { date: "2026-11-03", users: 3, audits: 7, llmRequests: 14 },
];

describe("TrendBars", () => {
  it("按点数渲染 7 组柱子，最大值顶满高度", () => {
    const wrapper = mount(TrendBars, { props: { points } });

    expect(wrapper.findAll(".col")).toHaveLength(7);
    const llm = wrapper.findAll(".bar.llm");
    expect(llm).toHaveLength(7);
    // 三条序列共享纵轴：全局最大值 27（第 6 天 llmRequests）顶满 100%
    expect(llm[5].attributes("style")).toContain("height: 100%");
    // 0 值不画高度
    expect(wrapper.findAll(".bar.users")[2].attributes("style")).toContain("height: 0%");
  });

  it("legend 汇总三类总数", () => {
    const wrapper = mount(TrendBars, { props: { points } });

    expect(wrapper.text()).toContain("新增用户 18");
    expect(wrapper.text()).toContain("审计动作 36");
    expect(wrapper.text()).toContain("模型请求 117");
  });

  it("日标签是 M/D，不随月份补零", () => {
    const wrapper = mount(TrendBars, { props: { points } });

    expect(wrapper.findAll(".col-label")[0].text()).toBe("10/28");
    expect(wrapper.findAll(".col-label")[6].text()).toBe("11/3");
  });
});
