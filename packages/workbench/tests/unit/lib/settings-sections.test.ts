// 设置分区清单：分组是展示层唯一来源，扁平清单必须由它派生（搜索索引读扁平那份）。
import { describe, expect, it } from "vitest";
import { SETTINGS_SECTIONS, SETTINGS_SECTION_GROUPS } from "@/lib/settings-sections";

describe("settings-sections", () => {
  it("扁平清单按分组顺序展开，且没有重复分区", () => {
    const flat = SETTINGS_SECTION_GROUPS.flatMap((group) => group.sections.map((section) => section.key));
    expect(SETTINGS_SECTIONS.map((section) => section.key)).toEqual(flat);
    expect(new Set(flat).size).toBe(flat.length);
  });

  it("每个分组至少两个分区，避免出现只有一个条目的组", () => {
    for (const group of SETTINGS_SECTION_GROUPS) {
      expect(group.sections.length).toBeGreaterThanOrEqual(2);
    }
  });
});
