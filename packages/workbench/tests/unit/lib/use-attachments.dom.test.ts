// 拖放命中判定契约：落在输入卡（或其内部元素）上的拖放归 composer，别处仍归预览面板。
// happy-dom 不做布局，elementFromPoint 由测试桩替换 —— 这里钉的是「按标记属性认拖放区」
// 这一约定（App.vue 与输入卡两边都依赖它），不是浏览器几何计算。
import { afterEach, describe, expect, it } from "vitest";
import { DROPZONE_ATTR, isPointInDropzone } from "@/lib/use-attachments";

const original = document.elementFromPoint;

afterEach(() => {
  document.elementFromPoint = original;
  document.body.innerHTML = "";
});

describe("isPointInDropzone", () => {
  it("命中拖放区内的元素（含其子元素）判定为真", () => {
    const zone = document.createElement("div");
    zone.setAttribute(DROPZONE_ATTR, "");
    const child = document.createElement("span");
    zone.appendChild(child);
    document.body.appendChild(zone);

    document.elementFromPoint = () => zone;
    expect(isPointInDropzone(50, 50)).toBe(true);

    document.elementFromPoint = () => child;
    expect(isPointInDropzone(50, 50)).toBe(true);
  });

  it("区域外或未取到元素时判定为假", () => {
    document.elementFromPoint = () => document.body;
    expect(isPointInDropzone(50, 50)).toBe(false);

    document.elementFromPoint = () => null;
    expect(isPointInDropzone(50, 50)).toBe(false);
  });
});
