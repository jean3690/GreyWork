import { describe, expect, it } from "vitest";
import { pluginStatusText, resetPluginStatusForTest, setPluginStatus } from "@/plugins/status";

/**
 * 状态栏文案的宿主存储：
 *  - 只收字符串，控制字符换成空格、去首尾、截到 80 字符（底部细栏放不下一段话）；
 *  - 清成空串等于「撤掉这条状态」（外壳回落到 manifest 的初始 label）；
 *  - 文本不随插件页卸载丢失（这正是它要解决的「上次成功」场景）。
 */
describe("插件状态存储", () => {
  it("set 后可读；空文本删除条目；非字符串忽略", () => {
    resetPluginStatusForTest();
    setPluginStatus("demo.pet", "sync", "上次成功 10:24");
    expect(pluginStatusText("demo.pet", "sync")).toBe("上次成功 10:24");

    setPluginStatus("demo.pet", "sync", "   ");
    expect(pluginStatusText("demo.pet", "sync")).toBeUndefined();

    setPluginStatus("demo.pet", "sync", 42 as unknown as string);
    expect(pluginStatusText("demo.pet", "sync")).toBeUndefined();
  });

  it("控制字符换空格、去首尾、截断到 80 字符", () => {
    resetPluginStatusForTest();
    setPluginStatus("demo.pet", "sync", "  a\tb\u0007c  ");
    expect(pluginStatusText("demo.pet", "sync")).toBe("a b c");

    setPluginStatus("demo.pet", "sync", "长".repeat(100));
    expect(pluginStatusText("demo.pet", "sync")?.length).toBe(80);
  });
});
