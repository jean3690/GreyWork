/**
 * 布局偏好持久化。
 *
 * 这是补的**真实缺口**：左栏折叠态此前是 Shell 里的裸 ref，每次启动都回到展开态。
 * 放 dom 项目是因为要真的读写 localStorage —— node 环境没有它，`createJsonStorage`
 * 会静默退化成「读回 null、写入丢弃」，那样这组用例等于什么都没验证。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useLayoutStore } from "@/stores/layout";

const KEY = "greywork.layout";

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});

describe("useLayoutStore", () => {
  it("没有存过偏好时默认展开", () => {
    expect(useLayoutStore().sidebarCollapsed).toBe(false);
  });

  it("改动会落盘", () => {
    const layout = useLayoutStore();
    layout.sidebarCollapsed = true;

    expect(JSON.parse(localStorage.getItem(KEY) ?? "{}")).toEqual({ sidebarCollapsed: true });
  });

  it("重新建 store（等价于重启应用）会读回上次的偏好", () => {
    useLayoutStore().sidebarCollapsed = true;

    setActivePinia(createPinia());
    expect(useLayoutStore().sidebarCollapsed).toBe(true);
  });

  it("能读回「展开」这个偏好，不被默认值盖掉", () => {
    localStorage.setItem(KEY, JSON.stringify({ sidebarCollapsed: false }));

    expect(useLayoutStore().sidebarCollapsed).toBe(false);
  });

  it("落盘内容形状不对时退回默认值，不把界面带崩", () => {
    localStorage.setItem(KEY, JSON.stringify({ sidebarCollapsed: "yes" }));

    expect(useLayoutStore().sidebarCollapsed).toBe(false);
  });

  it("存档整体损坏时也能启动", () => {
    localStorage.setItem(KEY, "{ 不是 JSON");

    expect(useLayoutStore().sidebarCollapsed).toBe(false);
  });
});
