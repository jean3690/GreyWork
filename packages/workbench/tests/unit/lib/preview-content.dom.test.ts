/**
 * 预览内容加载的触发条件：只有 path / revision 的**值**变了才重载。
 *
 * 这条回归守的是一个很隐蔽的坑：`watch` 的源若写成 `() => [path, revision]`，每次求值都是
 * 新数组、Object.is 永不相等，于是「tab 对象被换掉」也会触发重载 —— 而 store 里改 diskPath /
 * dirty 恰恰就是换对象。后果是 viewer 连同 Univer 实例、滚动位置与正在编辑的内容一起被重建。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, ref, type Ref } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const h2 = vi.hoisted(() => ({ readFile: vi.fn<(path: string) => Promise<string>>() }));

vi.mock("@/stores/vfs", () => ({ useVfsStore: () => ({ readFile: h2.readFile }) }));

import { usePreviewText } from "@/lib/preview-content";
import type { PreviewTab } from "@/stores/preview";

function tab(partial: Partial<PreviewTab> = {}): PreviewTab {
  return { id: "pv-1", path: "reports/a.md", name: "a.md", kind: "md", source: "vfs", revision: 0, ...partial };
}

/** 把 hook 挂进一个最小组件里，让 watch 在组件作用域内正常工作。 */
function mountLoader(source: Ref<PreviewTab>) {
  return mount(
    defineComponent({
      setup() {
        const { data } = usePreviewText(source);
        return () => h("div", data.value ?? "");
      },
    }),
  );
}

beforeEach(() => {
  setActivePinia(createPinia());
  h2.readFile.mockReset();
  h2.readFile.mockResolvedValue("# 报告");
});

describe("usePreviewText 的重载触发条件", () => {
  it("挂载即加载一次", async () => {
    const source = ref(tab());
    mountLoader(source);
    await flushPromises();
    expect(h2.readFile).toHaveBeenCalledTimes(1);
    expect(h2.readFile).toHaveBeenCalledWith("reports/a.md");
  });

  it("tab 对象被换掉但 path/revision 不变时不重载（store 改 diskPath / dirty 就是这种情况）", async () => {
    const source = ref(tab());
    mountLoader(source);
    await flushPromises();

    source.value = { ...source.value, diskPath: "/disk/a.md" };
    await flushPromises();
    source.value = { ...source.value, dirty: true };
    await flushPromises();

    expect(h2.readFile).toHaveBeenCalledTimes(1);
  });

  it("revision 自增时重载（产物就地更新靠它）", async () => {
    const source = ref(tab());
    mountLoader(source);
    await flushPromises();

    source.value = { ...source.value, revision: 1 };
    await flushPromises();

    expect(h2.readFile).toHaveBeenCalledTimes(2);
  });

  it("path 变了重载，并且拿到的是新路径的内容", async () => {
    const source = ref(tab());
    const wrapper = mountLoader(source);
    await flushPromises();

    h2.readFile.mockResolvedValue("# 另一份");
    source.value = { ...source.value, path: "reports/b.md", name: "b.md" };
    await flushPromises();

    expect(h2.readFile).toHaveBeenLastCalledWith("reports/b.md");
    expect(wrapper.text()).toBe("# 另一份");
  });
});
