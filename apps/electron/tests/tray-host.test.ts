import { describe, expect, it } from "vitest";

import { trayHostPresentIn } from "../src/shared/tray-host";

describe("trayHostPresentIn", () => {
  it("任一探针列出 StatusNotifierWatcher 即算有宿主", () => {
    const busctl = "org.freedesktop.DBus\norg.kde.StatusNotifierWatcher\n:1.42";
    expect(trayHostPresentIn([busctl])).toBe(true);
    // busctl 缺失（null）但 dbus-send 探到了。
    expect(trayHostPresentIn([null, "string \"org.kde.StatusNotifierWatcher\"\n"])).toBe(true);
  });

  it("两个探针都没探到 → 判不可用（避免窗口藏进看不见的托盘）", () => {
    expect(trayHostPresentIn([])).toBe(false);
    expect(trayHostPresentIn([null, null])).toBe(false);
    expect(trayHostPresentIn(["org.freedesktop.DBus\n:1.1"])).toBe(false);
  });
});
