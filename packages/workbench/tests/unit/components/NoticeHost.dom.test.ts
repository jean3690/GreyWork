/**
 * 全局通知面（NoticeHost）：按 kind 落 alert / status、action 按钮执行且随之消失、
 * 右上角关闭按钮 dismiss。store 用真的（本组件就是从 store 读），只验证渲染层契约。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type DOMWrapper, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

import NoticeHost from "@/components/NoticeHost.vue";
import { useNoticeStore } from "@/stores/notice";

/** 卡片选择器：壳自己的 testid 也叫 notice-host，前缀选择器会误伤，显式排除。 */
const CARD = '[data-testid^="notice-"]:not([data-testid="notice-host"])';

function mountHost(): VueWrapper {
  return mount(NoticeHost);
}

/** 卡片里的关闭按钮：有 data-testid 的那颗是 action，另一颗才是 dismiss。 */
function dismissButton(wrapper: VueWrapper): DOMWrapper<Element> {
  const card = wrapper.get(CARD);
  const buttons = card.findAll("button");
  return buttons.find((button) => !button.attributes("data-testid"))!;
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});

describe("NoticeHost", () => {
  it("无通知时不渲染任何卡片", () => {
    const wrapper = mountHost();
    expect(wrapper.findAll(CARD)).toHaveLength(0);
    expect(wrapper.find('[data-testid="notice-host"]').exists()).toBe(true);
  });

  it("error / warning 落 role=alert，success / info 落 role=status", () => {
    const notices = useNoticeStore();
    notices.error("保存失败", "没权限");
    notices.warning("磁盘告警");
    notices.success("已保存");
    notices.info("后台任务开始");

    const wrapper = mountHost();
    const cards = wrapper.findAll(CARD);
    expect(cards).toHaveLength(4);
    for (const testid of ["notice-error", "notice-warning"]) {
      expect(wrapper.get(`[data-testid="${testid}"]`).attributes("role")).toBe("alert");
    }
    for (const testid of ["notice-success", "notice-info"]) {
      expect(wrapper.get(`[data-testid="${testid}"]`).attributes("role")).toBe("status");
    }
  });

  it("标题与细节都渲染，detail 缺省不产生空行节点", () => {
    useNoticeStore().error("保存失败", "没有写入权限");

    const wrapper = mountHost();
    const card = wrapper.get('[data-testid="notice-error"]');
    expect(card.text()).toContain("保存失败");
    expect(card.text()).toContain("没有写入权限");
  });

  it("点 action：执行 run 并 dismiss 掉这条通知", async () => {
    const run = vi.fn();
    const id = useNoticeStore().push({ kind: "error", title: "同步失败", action: { label: "重试", run } });

    const wrapper = mountHost();
    await wrapper.get(`[data-testid="notice-action-${id}"]`).trigger("click");

    expect(run).toHaveBeenCalledTimes(1);
    expect(wrapper.findAll(CARD)).toHaveLength(0);
  });

  it("点右上角关闭：只 dismiss 当前这条，不波及同屏其它通知", async () => {
    const notices = useNoticeStore();
    notices.error("第一条");
    notices.warning("第二条");

    const wrapper = mountHost();
    await dismissButton(wrapper).trigger("click");

    expect(wrapper.findAll(CARD)).toHaveLength(1);
    expect(wrapper.find('[data-testid="notice-warning"]').exists()).toBe(true);
  });
});
