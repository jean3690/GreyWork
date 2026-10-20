import { describe, expect, it } from "vitest";

import { DESKTOP_ONLY_COMMANDS } from "../src/shared/desktop-only";

describe("桌面专属命令清单", () => {
  it("恒为 22 条且互不重复", () => {
    // 与 greywork_host 命令表的 desktop_only 集合互为镜像；数量对不上说明共享表动了。
    expect(DESKTOP_ONLY_COMMANDS).toHaveLength(22);
    expect(new Set(DESKTOP_ONLY_COMMANDS).size).toBe(22);
  });

  it("按字典序排列（便于与 /api/commands 的 desktopOnly 集合逐项比对）", () => {
    const sorted = [...DESKTOP_ONLY_COMMANDS].sort();
    expect([...DESKTOP_ONLY_COMMANDS]).toEqual(sorted);
  });
});
