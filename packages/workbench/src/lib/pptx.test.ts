import { describe, expect, it } from "vitest";
import { exportToPptx, resultSetToDeck } from "./pptx";

describe("exportToPptx", () => {
  it("生成合法 zip 容器（PK magic），封面 + 内容页可产", async () => {
    const data = await exportToPptx({
      title: "客流简报",
      subtitle: "示例数据",
      slides: [
        { title: "数据结果", table: { headers: ["站点", "value"], rows: [["北京站", "1284"]] } },
        { title: "结论", bullets: ["客流稳定", "峰值在 2 月"] },
      ],
    });
    expect(data.byteLength).toBeGreaterThan(100);
    // pptx 是 zip 容器：PK\x03\x04
    expect(data[0]).toBe(0x50); // 'P'
    expect(data[1]).toBe(0x4b); // 'K'
    expect(data[2]).toBe(0x03);
    expect(data[3]).toBe(0x04);
  });

  it("空 slides 也能生成（仅封面）", async () => {
    const data = await exportToPptx({ title: "空简报", slides: [] });
    expect(data.byteLength).toBeGreaterThan(100);
    expect(data[0]).toBe(0x50);
  });
});

describe("resultSetToDeck", () => {
  it("结果集转封面 + 数据表页", () => {
    const deck = resultSetToDeck(
      "标题",
      "副标题",
      ["a", "b"],
      [
        ["1", "2"],
        ["3", "4"],
      ],
    );
    expect(deck.title).toBe("标题");
    expect(deck.subtitle).toBe("副标题");
    expect(deck.slides).toHaveLength(1);
    expect(deck.slides[0]?.table?.headers).toEqual(["a", "b"]);
    expect(deck.slides[0]?.table?.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });
});
