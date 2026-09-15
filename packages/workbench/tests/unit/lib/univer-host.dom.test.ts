/**
 * Univer 预览共用生命周期（lib/univer-host.ts）：
 * 由 as-components composable，直接挂一个测试宿主组件来驱动 watch / onUnmounted。
 * 覆盖：字节与容器就绪才 boot、boot 失败落 bootError、代次自增丢弃过期实例、
 * 卸载时销毁句柄，以及 registerPresetPlugins 对 [Ctor, config] 元组的逐项注册。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent, h, toRef, type PropType } from "vue";

import type { PreviewTab } from "@/stores/preview";
import { registerPresetPlugins, useUniverHost, type UniverInstance } from "@/lib/univer-host";

const h_ = vi.hoisted(() => ({ readBinary: vi.fn<(path: string) => Promise<Uint8Array | null>>() }));
vi.mock("@/stores/vfs", () => ({ useVfsStore: () => ({ readBinary: h_.readBinary }) }));

let bootSpy: ReturnType<typeof vi.fn>;

function disposeSpy(): UniverInstance & { disposed: () => boolean } {
  const dispose = vi.fn();
  const handle: UniverInstance & { disposed: () => boolean } = {
    disposed: () => dispose.mock.calls.length > 0,
    dispose,
  };
  return handle;
}

const HostTester = defineComponent({
  props: { tab: { type: Object as PropType<PreviewTab>, required: true } },
  setup(props) {
    const state = useUniverHost(toRef(props, "tab"), bootSpy);
    return () => [
      h("div", { ref: state.host, "data-testid": "univer-host" }),
      h("span", { "data-testid": "loading" }, String(state.loading.value)),
      h("span", { "data-testid": "boot-error" }, state.bootError.value ?? ""),
      h("span", { "data-testid": "load-error" }, state.error.value ?? ""),
    ];
  },
});

function tab(partial: Partial<PreviewTab> = {}): PreviewTab {
  return { id: "pv-1", path: "out/表.xlsx", name: "表.xlsx", kind: "xlsx", source: "vfs", revision: 0, ...partial };
}

async function mountHost(): Promise<VueWrapper> {
  const wrapper = mount(HostTester, { props: { tab: tab() } });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  h_.readBinary.mockReset();
  bootSpy = vi.fn();
});

describe("useUniverHost", () => {
  it("有容器但没字节（bytes 为 null）：不 boot，直接空等", async () => {
    h_.readBinary.mockResolvedValue(null);
    const wrapper = await mountHost();

    expect(wrapper.find('[data-testid="univer-host"]').exists()).toBe(true);
    expect(bootSpy).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="boot-error"]').text()).toBe("");
  });

  it("字节与容器齐备：清空容器再 boot，把句柄挂上", async () => {
    h_.readBinary.mockResolvedValue(new Uint8Array([1, 2, 3]));
    bootSpy.mockResolvedValue(disposeSpy());
    const wrapper = await mountHost();

    expect(bootSpy).toHaveBeenCalledTimes(1);
    const [container, bytes] = bootSpy.mock.calls[0] as [HTMLElement, Uint8Array];
    expect(container.getAttribute("data-testid")).toBe("univer-host");
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(wrapper.get('[data-testid="boot-error"]').text()).toBe("");
    // 挂载前容器应是空的（replaceChildren 清过盘）
    expect(container.childNodes).toHaveLength(0);
  });

  it("boot 抛错：落 bootError，后续正常 boot 可恢复", async () => {
    // 每次调用须返回新实例，否则 revision 变化时 data ref 引用相同、压实 watch 不再触发
    h_.readBinary.mockImplementation(async () => new Uint8Array([1]));
    bootSpy.mockRejectedValueOnce(new Error("WebGL isn't available"));
    const wrapper = await mountHost();
    expect(wrapper.get('[data-testid="boot-error"]').text()).toBe("WebGL isn't available");

    bootSpy.mockResolvedValueOnce(disposeSpy());
    await wrapper.setProps({ tab: tab({ revision: 1 }) });
    await flushPromises();
    expect(wrapper.get('[data-testid="boot-error"]').text()).toBe("");
  });

  it("代次守卫：旧 boot 迟到时丢弃并 dispose，不顶掉新实例", async () => {
    h_.readBinary.mockResolvedValue(new Uint8Array([1]));
    let resolveFirst!: (handle: UniverInstance) => void;
    bootSpy.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)));

    const wrapper = await mountHost();
    const first = disposeSpy();
    expect(bootSpy).toHaveBeenCalledTimes(1);

    // 数据变化触发第二次 boot，先到先得
    bootSpy.mockImplementationOnce(async () => {
      await Promise.resolve();
      return disposeSpy();
    });
    h_.readBinary.mockResolvedValueOnce(new Uint8Array([2]));
    await wrapper.setProps({ tab: tab({ revision: 1 }) });
    await flushPromises();
    expect(bootSpy).toHaveBeenCalledTimes(2);

    // 迟到的第一次 boot 返回：必须被 dispose，且不能被当成当前实例
    resolveFirst(first);
    await flushPromises();
    expect(first.disposed()).toBe(true);
  });

  it("卸载：当前实例被 dispose", async () => {
    h_.readBinary.mockResolvedValue(new Uint8Array([1]));
    const handle = disposeSpy();
    bootSpy.mockResolvedValue(handle);
    const wrapper = await mountHost();
    expect(bootSpy).toHaveBeenCalledTimes(1);

    wrapper.unmount();
    expect(handle.dispose).toHaveBeenCalledTimes(1);
  });

  it("读取失败透传 error", async () => {
    h_.readBinary.mockRejectedValue(new Error("文件被占用"));
    const wrapper = await mountHost();
    expect(wrapper.get('[data-testid="load-error"]').text()).toContain("文件被占用");
    expect(wrapper.get('[data-testid="boot-error"]').text()).toBe("");
  });
});

describe("registerPresetPlugins", () => {
  it("ctor 与 [ctor, config] 混排逐项注册，this 绑定实例", () => {
    const registerPlugin = vi.fn();
    const univer = { registerPlugin };
    const A = class A {};
    const B = class B {};
    const cfg = { layout: "default" };

    registerPresetPlugins(univer, [A, [B, cfg]] as unknown[]);

    expect(registerPlugin).toHaveBeenCalledTimes(2);
    expect(registerPlugin).toHaveBeenNthCalledWith(1, A);
    expect(registerPlugin).toHaveBeenNthCalledWith(2, B, cfg);
  });
});
