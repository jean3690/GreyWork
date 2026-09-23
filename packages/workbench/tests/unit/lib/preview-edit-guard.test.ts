/**
 * 「离开前先保存」守卫的纯逻辑：无脏 → 直接走；保存成功 → 自动走；
 * 保存失败 → 暂存离开动作并等用户决定（放弃 / 取消）。
 *
 * 这里用假 saver（直接 registerPreviewSaver）而不是挂真编辑器：本用例验的是守卫
 * 的调度与状态机，不是某个 viewer 的序列化。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";
import { useNoticeStore } from "@/stores/notice";
import { usePreviewStore } from "@/stores/preview";
import {
  cancelDiscard,
  clearDirtyPreviewTabs,
  confirmDiscard,
  hasDirtyPreviewTabs,
  pendingDiscard,
  requestLeave,
} from "@/lib/preview-edit-guard";
import { registerPreviewSaver } from "@/lib/preview-save";

/** 让守卫内部那串 await 跑完（用宏任务，顺带把 notify 的定时器也放出去）。 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 注册一个可控的假 saver；`fail` 为真时 save 抛错。 */
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
  return {
    dirty,
    count: () => saves,
  };
}

beforeEach(() => {
  // node 环境没有 localStorage：仓库的存储封装对缺存储是容忍的（prefs 只是偏好）。
  setActivePinia(createPinia());
  cancelDiscard();
});

describe("preview-edit-guard", () => {
  it("没有脏改动：同步执行离开动作，不弹确认", () => {
    let ran = false;
    requestLeave(() => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(pendingDiscard.value).toBeNull();
    expect(hasDirtyPreviewTabs()).toBe(false);
  });

  it("有脏改动且保存成功：先保存再离开，并给一条回执", async () => {
    const id = usePreviewStore().open("reports/a.txt");
    const saver = registerFakeSaver(id);
    expect(hasDirtyPreviewTabs()).toBe(true);

    let ran = false;
    requestLeave(() => {
      ran = true;
    });
    // 有脏时是异步的：这一刻还不该离开
    expect(ran).toBe(false);
    await settle();

    expect(saver.count()).toBe(1);
    expect(saver.dirty.value).toBe(false);
    expect(ran).toBe(true);
    expect(pendingDiscard.value).toBeNull();
    // 自动保存是用户没显式要求的写盘，必须留下回执
    expect(useNoticeStore().list.some((notice) => notice.title === "已保存")).toBe(true);
  });

  it("保存失败：不离开，暂存动作并记下失败的 tab", async () => {
    const id = usePreviewStore().open("reports/b.txt");
    registerFakeSaver(id, true);

    let ran = false;
    requestLeave(() => {
      ran = true;
    });
    await settle();

    expect(ran).toBe(false);
    expect(pendingDiscard.value?.failed.map((tab) => tab.id)).toEqual([id]);
  });

  it("放弃并继续：执行被暂存的离开动作", async () => {
    const id = usePreviewStore().open("reports/c.txt");
    registerFakeSaver(id, true);
    let ran = false;
    requestLeave(() => {
      ran = true;
    });
    await settle();

    confirmDiscard();
    expect(ran).toBe(true);
    expect(pendingDiscard.value).toBeNull();
  });

  it("取消：留在原地，脏标记仍在（改动没丢）", async () => {
    const id = usePreviewStore().open("reports/d.txt");
    const saver = registerFakeSaver(id, true);
    let ran = false;
    requestLeave(() => {
      ran = true;
    });
    await settle();

    cancelDiscard();
    expect(ran).toBe(false);
    expect(pendingDiscard.value).toBeNull();
    expect(saver.dirty.value).toBe(true);
    expect(hasDirtyPreviewTabs()).toBe(true);
  });

  it("已有待确认弹层时忽略后续离开请求，不叠第二个动作", async () => {
    const id = usePreviewStore().open("reports/e.txt");
    registerFakeSaver(id, true);
    let first = false;
    let second = false;
    requestLeave(() => {
      first = true;
    });
    await settle();
    requestLeave(() => {
      second = true;
    });
    await settle();

    expect(first).toBe(false);
    expect(second).toBe(false);
    // 仍是第一次那个动作
    confirmDiscard();
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("clearDirtyPreviewTabs 抹掉脏标记（关窗放弃那条路要用）", () => {
    const id = usePreviewStore().open("reports/f.txt");
    const saver = registerFakeSaver(id);
    expect(hasDirtyPreviewTabs()).toBe(true);

    clearDirtyPreviewTabs();
    expect(saver.dirty.value).toBe(false);
    expect(hasDirtyPreviewTabs()).toBe(false);
  });
});
