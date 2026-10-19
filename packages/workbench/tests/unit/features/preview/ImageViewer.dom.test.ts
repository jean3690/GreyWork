/**
 * 图片预览的缩放手感：
 *
 * - 滚轮一格约 1.22 倍，反向回到原点（指数曲线，见 lib/zoom.ts）；
 * - 触控板横扫只平移，不缩放；
 * - 双击在「适应」与 1:1 之间切换。
 *
 * 这里也顺手守住一个曾经的真 bug：wheel 监听原先挂在 `onMounted` 的 stage 上，
 * 而 stage 在 `v-else-if="objectUrl"` 里 —— 挂载那一刻图片还没读回来，stage 是 null，
 * 监听就永远没挂上（滚轮完全没反应）。改成模板绑定后由本用例覆盖。
 */
import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";

vi.mock("@/lib/preview-content", async () => {
  const { ref } = await import("vue");
  return {
    usePreviewBinary: () => ({ data: ref(new Uint8Array([137, 80, 78, 71])), loading: ref(false), error: ref(null) }),
  };
});

import ImageViewer from "@/features/preview/ImageViewer.vue";
import type { PreviewTab } from "@/stores/preview";

function imageTab(): PreviewTab {
  return {
    id: "pv-img",
    path: "/tmp/plan.png",
    name: "plan.png",
    kind: "image",
    source: "disk",
    revision: 0,
  };
}

async function mountViewer() {
  const wrapper = mount(ImageViewer, { props: { tab: imageTab() } });
  await nextTick();
  const stage = wrapper.find('[data-testid="image-stage"]');
  expect(stage.exists()).toBe(true);
  return { wrapper, stage };
}

function level(wrapper: Awaited<ReturnType<typeof mountViewer>>["wrapper"]): string {
  return wrapper.find('[data-testid="image-zoom-level"]').text();
}

describe("ImageViewer 缩放", () => {
  it("滚轮一格放大到约 122%，反向滚回 100%", async () => {
    const { wrapper, stage } = await mountViewer();
    expect(level(wrapper)).toBe("100%");

    await stage.trigger("wheel", { deltaY: -100, deltaMode: 0, ctrlKey: false, clientX: 120, clientY: 90 });
    expect(level(wrapper)).toBe("122%");

    await stage.trigger("wheel", { deltaY: 100, deltaMode: 0, ctrlKey: false, clientX: 120, clientY: 90 });
    expect(level(wrapper)).toBe("100%");
  });

  it("触控板横扫只平移，不改变缩放", async () => {
    const { wrapper, stage } = await mountViewer();
    await stage.trigger("wheel", { deltaX: 60, deltaY: 2, deltaMode: 0, ctrlKey: false });
    expect(level(wrapper)).toBe("100%");
  });

  it("双击回到适应窗口", async () => {
    const { wrapper, stage } = await mountViewer();
    await stage.trigger("wheel", { deltaY: -100, deltaMode: 0, ctrlKey: false, clientX: 120, clientY: 90 });
    expect(level(wrapper)).toBe("122%");

    await stage.trigger("dblclick");
    expect(level(wrapper)).toBe("100%");
  });
});
