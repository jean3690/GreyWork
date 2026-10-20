import { describe, expect, it } from "vitest";

import { composePluginNotify } from "../src/shared/notify-compose";

describe("composePluginNotify", () => {
  it("标题加 [pluginId] 归属前缀（插件伪造不了），正文保持", () => {
    expect(composePluginNotify({ pluginId: "demo.pet", title: " 到点了 ", body: " 该休息了 " })).toEqual({
      title: "[demo.pet] 到点了",
      body: "该休息了",
    });
  });

  it("pluginId / 标题 / 正文为空即拒绝", () => {
    expect(() => composePluginNotify({ pluginId: "", title: "t", body: "b" })).toThrow();
    expect(() => composePluginNotify({ pluginId: "p", title: "   ", body: "b" })).toThrow();
    expect(() => composePluginNotify({ pluginId: "p", title: "t", body: "" })).toThrow();
  });
});
