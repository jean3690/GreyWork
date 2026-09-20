import { describe, expect, it } from "vitest";
import { exportToPptx, resultSetToDeck } from "@/lib/pptx";

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

  it("太阳系演示 deck（含破折号与中文要点）可正常生成", async () => {
    const data = await exportToPptx({
      title: "The Solar System",
      subtitle: "A Journey Through Our Cosmic Neighborhood",
      slides: [
        { title: "The Solar System", bullets: ["A Journey Through Our Cosmic Neighborhood", "八大行星 · 一颗恒星 · 无尽的边疆"] },
        {
          title: "The Heart of It All: The Sun",
          bullets: ["占据太阳系约 99.86% 的质量", "核心核聚变，表面温度约 5500°C", "阳光抵达地球约需 8 分 20 秒"],
        },
        {
          title: "The Inner Planets",
          bullets: [
            "水星 Mercury — 最靠近太阳，几乎没有大气",
            "金星 Venus — 强烈温室效应，最热的行星",
            "地球 Earth — 已知唯一孕育生命的世界",
            "火星 Mars — 红色星球，探测最热点",
          ],
        },
        {
          title: "The Outer Giants",
          bullets: [
            "木星 Jupiter — 体积最大，大红斑风暴",
            "土星 Saturn — 壮观光环由冰与岩构成",
            "天王星 Uranus — 近乎侧躺自转",
            "海王星 Neptune — 最远，狂风呼啸",
          ],
        },
        {
          title: "The Frontier Awaits",
          bullets: ["柯伊伯带 Kuiper Belt — 矮行星的家园", "奥尔特云 Oort Cloud — 长周期彗星的源头", "旅行者号已飞越日球层，驶向星际"],
        },
      ],
    });
    expect(data.byteLength).toBeGreaterThan(100);
    expect(data[0]).toBe(0x50);
  });

  it("表格行比表头短 / 含缺失单元格：补齐列数并强制字符串，仍产出合法 pptx", async () => {
    const data = await exportToPptx({
      title: "参差表",
      slides: [{ title: "表", table: { headers: ["A", "B", "C"], rows: [["1"], ["2", "3", "4"]] } }],
    });
    expect(data.byteLength).toBeGreaterThan(100);
    expect(data[0]).toBe(0x50);
    expect(data[1]).toBe(0x4b);
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
