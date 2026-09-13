// 外观落地与订阅：写 data-* + window 广播 APPEARANCE_EVENT（消费方不自己盯 DOM）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { APPEARANCE_EVENT, applyAppearance, isDarkMode, readTheme, watchTheme, type AppearanceDetail } from "@/lib/theme";

afterEach(() => {
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.palette;
  delete document.documentElement.dataset.fontSize;
});

/** 收集广播出来的外观快照。 */
function recordEvents(): { details: AppearanceDetail[]; stop: () => void } {
  const details: AppearanceDetail[] = [];
  const onAppearance = (event: WindowEventMap[typeof APPEARANCE_EVENT]): void => void details.push(event.detail);
  window.addEventListener(APPEARANCE_EVENT, onAppearance);
  return { details, stop: () => window.removeEventListener(APPEARANCE_EVENT, onAppearance) };
}

let seq = 0;
/**
 * 每次换一个 palette，保证与模块内上一次广播不同、一定发得出去。
 * 去重本身另有用例覆盖，这里不想让用例之间互相踩到那条判断。
 */
function apply(colorMode: "dark" | "light" | "system", fontSize = "medium"): void {
  applyAppearance({ palette: `palette-${seq++}`, colorMode, fontSize });
}

describe("applyAppearance", () => {
  it("写 data-* 属性并广播一次", () => {
    const { details, stop } = recordEvents();

    applyAppearance({ palette: "github", colorMode: "dark", fontSize: "large" });

    expect(document.documentElement.dataset.palette).toBe("github");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.fontSize).toBe("large");
    expect(details).toEqual([{ palette: "github", theme: "dark", fontSize: "large" }]);
    stop();
  });

  it("同一份外观重复应用只广播一次（设置页一次点击会有 store 与 Shell 两个调用点）", () => {
    const { details, stop } = recordEvents();

    applyAppearance({ palette: "fox", colorMode: "dark", fontSize: "small" });
    applyAppearance({ palette: "fox", colorMode: "dark", fontSize: "small" });

    expect(details).toHaveLength(1);
    stop();
  });

  it("system 按 prefers-color-scheme 展开，写入解析后的实际明暗", () => {
    const { details, stop } = recordEvents();
    const matchMedia = vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);

    applyAppearance({ palette: "github", colorMode: "system", fontSize: "medium" });

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(details.at(-1)?.theme).toBe("dark");
    matchMedia.mockRestore();
    stop();
  });

  it("未设置 data-theme 时按浅色读取", () => {
    expect(readTheme()).toBe("light");
    expect(isDarkMode()).toBe(false);
  });
});

describe("watchTheme", () => {
  it("明暗翻转时通知；换配色 / 改字号不通知", () => {
    const seen: string[] = [];
    const stop = watchTheme((theme) => seen.push(theme));

    apply("dark");
    apply("dark", "large"); // 明暗没动，只是换配色 + 改字号
    apply("light", "large");

    expect(seen).toEqual(["dark", "light"]);
    stop();
  });

  it("退订后不再收到通知", () => {
    const seen: string[] = [];
    const stop = watchTheme((theme) => seen.push(theme));

    apply("dark");
    stop();
    apply("light");

    expect(seen).toEqual(["dark"]);
  });
});
