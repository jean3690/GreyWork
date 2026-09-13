import { onUnmounted, ref, watch, type Ref } from "vue";
import { usePreviewBinary } from "./preview-content";
import type { PreviewTab } from "../stores/preview";

/**
 * Univer 预览的共用生命周期（xlsx / docx / pptx 三个 viewer 复用）。
 *
 * 抽出来不是为了省行数，是为了**只有一处会忘记 dispose**：Univer 实例持有 canvas、
 * rAF 循环与一整棵 DI 容器，切 tab 不销毁就会持续吃 CPU。三个 viewer 各写一份
 * 生命周期 = 三次忘记的机会。
 *
 * 内容变化时**重建实例**而不是往同一实例里塞第二个单元：Univer 的 unit 是有 id 的，
 * 复用实例会留下上一份文档的痕迹（多出一个 sheet / 一页 slide）。
 */
export interface UniverInstance {
  dispose: () => void;
}

/** 建实例并挂载单元；返回可销毁句柄。容器已保证非空且已清空。 */
export type UniverBoot = (container: HTMLElement, bytes: Uint8Array) => Promise<UniverInstance>;

export interface UniverHost {
  host: Ref<HTMLElement | null>;
  loading: Ref<boolean>;
  /** 读文件失败。 */
  error: Ref<string | null>;
  /** Univer 初始化或格式转换失败（happy-dom / 无 WebGL 环境下会走到这里）。 */
  bootError: Ref<string | null>;
}

export function useUniverHost(tab: Ref<PreviewTab>, boot: UniverBoot): UniverHost {
  const { data, loading, error } = usePreviewBinary(tab);
  const host = ref<HTMLElement | null>(null);
  const bootError = ref<string | null>(null);

  let instance: UniverInstance | null = null;
  /** 代次：切 tab / 换内容时自增，让还在 await 的旧初始化自我放弃。 */
  let generation = 0;

  function destroy(): void {
    instance?.dispose();
    instance = null;
  }

  // 同时观察 data 与 host：容器只在渲染出 <div ref="host"> 之后才有，
  // 两者到达顺序不确定，谁后到都要能触发一次初始化。
  watch(
    [data, host] as const,
    async ([bytes, container]) => {
      const mine = ++generation;
      destroy();
      bootError.value = null;
      if (!bytes || !container) return;
      container.replaceChildren();
      try {
        const created = await boot(container, bytes);
        if (mine !== generation) {
          created.dispose();
          return;
        }
        instance = created;
      } catch (cause: unknown) {
        if (mine !== generation) return;
        bootError.value = cause instanceof Error ? cause.message : String(cause);
      }
    },
    { immediate: true },
  );

  onUnmounted(() => {
    generation += 1;
    destroy();
  });

  return { host, loading, error, bootError };
}

/**
 * 把 preset 给的插件清单注册进实例。
 *
 * preset 的 `plugins` 是 `Array<Ctor | [Ctor, config]>` 联合类型，而 `registerPlugin`
 * 的签名是带 `ConstructorParameters` 推导的泛型，联合类型喂不进去；`registerPlugins`
 * 的映射元组类型更严。逐个注册语义完全等价，代价是这一处必要的类型放宽 ——
 * 把它关在这个函数里，不散到三个 viewer 里。
 */
export function registerPresetPlugins(univer: object, plugins: readonly unknown[]): void {
  const { registerPlugin } = univer as { registerPlugin: (plugin: unknown, config?: unknown) => void };
  const register = registerPlugin.bind(univer);
  for (const entry of plugins) {
    if (Array.isArray(entry)) register(entry[0], entry[1]);
    else register(entry);
  }
}
