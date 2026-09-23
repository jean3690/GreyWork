/**
 * 区段切换的未保存守卫：切走之前先把可编辑预览存下来，写不进去才弹确认。
 *
 * 为什么单独一个文件：`PreviewSider.dom.test.ts` 把 `PreviewSurface` stub 掉、也不注册
 * saver，验的是外壳自身的行为；守卫这套要「有脏文件」才跑得起来，混进去会让那个文件
 * 的每个用例都得考虑脏标记。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";

import PreviewSider from "@/features/preview/PreviewSider.vue";
import { usePreviewStore } from "@/stores/preview";
import { registerPreviewSaver } from "@/lib/preview-save";
import { cancelDiscard, pendingDiscard } from "@/lib/preview-edit-guard";

const stubs = {
  PreviewSurface: { template: "<div data-testid='surface-stub' />" },
  WebFetchDialog: { template: "<div data-testid='web-fetch-dialog-stub' />" },
};

let wrapper: VueWrapper | null = null;

function mountSider(): VueWrapper {
  wrapper = mount(PreviewSider, { global: { stubs }, attachTo: document.body });
  return wrapper;
}

/** 让守卫内部那串 await 跑完。 */
async function settle(): Promise<void> {
  await flushPromises();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flushPromises();
}

/** 注册假 saver；`fail` 为真时保存抛错。 */
function registerFakeSaver(id: string, fail = false) {
  const dirty = ref(true);
  let saves = 0;
  registerPreviewSaver(id, {
    dirty,
    save: async () => {
      saves += 1;
      if (fail) throw new Error("写盘失败");
      dirty.value = false;
    },
  });
  return { dirty, count: () => saves };
}

/** 弹层被 Portal 到 body，wrapper.find 够不到。 */
function dialogButtons(): HTMLButtonElement[] {
  const content = document.body.querySelector<HTMLElement>('[data-slot="alert-dialog-content"]');
  return content ? [...content.querySelectorAll<HTMLButtonElement>("button")] : [];
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  cancelDiscard();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = "";
});

describe("PreviewSider 区段切换的未保存守卫", () => {
  it("有脏文件：切到「文件」前先自动保存，保存成功后真的切过去且不弹确认", async () => {
    const view = mountSider();
    const id = usePreviewStore().open("reports/a.md");
    const saver = registerFakeSaver(id);

    await view.get('[data-testid="preview-section-files"]').trigger("click");
    await settle();

    expect(saver.count()).toBe(1);
    expect(saver.dirty.value).toBe(false);
    expect(view.find('[data-testid="file-tree"]').exists()).toBe(true);
    expect(dialogButtons()).toHaveLength(0);
  });

  it("保存失败：停在预览区并弹确认；选「放弃并继续」才切过去", async () => {
    const view = mountSider();
    const id = usePreviewStore().open("reports/b.md");
    registerFakeSaver(id, true);

    await view.get('[data-testid="preview-section-files"]').trigger("click");
    await settle();

    // 没切走、有弹层
    expect(pendingDiscard.value).not.toBeNull();
    expect(view.find('[data-testid="file-tree"]').exists()).toBe(false);
    const buttons = dialogButtons();
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    expect(buttons[1].textContent).toContain("放弃并继续");

    buttons[1].click();
    await settle();
    expect(pendingDiscard.value).toBeNull();
    expect(view.find('[data-testid="file-tree"]').exists()).toBe(true);
  });

  it("保存失败后选「取消」：留在预览区，脏标记还在", async () => {
    const view = mountSider();
    const id = usePreviewStore().open("reports/c.md");
    const saver = registerFakeSaver(id, true);

    await view.get('[data-testid="preview-section-files"]').trigger("click");
    await settle();

    dialogButtons()[0].click(); // 取消
    await settle();
    expect(pendingDiscard.value).toBeNull();
    expect(saver.dirty.value).toBe(true);
    expect(view.find('[data-testid="file-tree"]').exists()).toBe(false);
  });

  it("切到当前区段不触发保存（没有意义的写盘）", async () => {
    const view = mountSider();
    const id = usePreviewStore().open("reports/d.md");
    const saver = registerFakeSaver(id);

    await view.get('[data-testid="preview-section-preview"]').trigger("click");
    await settle();
    expect(saver.count()).toBe(0);
  });

  it("重新加载：先保存再重载（重载会重建 viewer，脏改动不能无声消失）", async () => {
    const view = mountSider();
    const preview = usePreviewStore();
    const id = preview.open("reports/e.md");
    const saver = registerFakeSaver(id);
    expect(preview.activeTab?.revision).toBe(0);
    await settle(); // 让「打开 tab → 跳到预览区」的 watcher 落地，重载按钮才渲染出来

    await view.get('[data-testid="preview-reload"]').trigger("click");
    await settle();

    expect(saver.count()).toBe(1);
    expect(preview.activeTab?.revision).toBe(1);
  });
});
