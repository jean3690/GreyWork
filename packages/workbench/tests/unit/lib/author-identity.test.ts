// 作者身份契约：同一作者键稳定同色；user/system 固定色；首字母按拉丁/CJK/空名分档。
import { describe, expect, it } from "vitest";
import { authorColor, authorIdentity, authorInitial } from "@/lib/author-identity";

describe("author-identity", () => {
  it("同一作者键映射到同一颜色（跨调用稳定）", () => {
    expect(authorColor("slot-3")).toBe(authorColor("slot-3"));
  });

  it("user / system 用固定色，不参与哈希", () => {
    expect(authorColor("user")).toBe("var(--grey-blue)");
    expect(authorColor("system")).toBe("var(--grey-violet)");
  });

  it("不同成员位铺开颜色（至少不止一种）", () => {
    const colors = new Set(["slot-1", "slot-2", "slot-3", "slot-4", "slot-5"].map(authorColor));
    expect(colors.size).toBeGreaterThan(1);
  });

  it("首字母：拉丁大写、CJK 取字、空名回落 ?", () => {
    expect(authorInitial("builder")).toBe("B");
    expect(authorInitial("实现")).toBe("实");
    expect(authorInitial("  ")).toBe("?");
  });

  it("authorIdentity 缺省名回落到 id，并带上色与首字母", () => {
    expect(authorIdentity("slot-1")).toMatchObject({ id: "slot-1", name: "slot-1" });
    const identity = authorIdentity("slot-1", "Builder");
    expect(identity).toMatchObject({ name: "Builder", initial: "B" });
    expect(identity.color).toBe(authorColor("slot-1"));
  });
});
