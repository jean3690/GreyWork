import GreyWorkCore from "./GreyWorkCore.vue";
import { createApp, h, onBeforeUnmount, onMounted, type Ref } from "vue";

/** 单例实例契约（defineExpose 的稳定面）。 */
export interface GreyWorkCoreInstance {
  el: HTMLElement;
  addGeoJson(data: unknown, name?: string): void;
  load3dTiles(url: string): Promise<void>;
  dispose(): void;
}

let instance: GreyWorkCoreInstance | null = null;

/**
 * 模块级懒初始化单例（SpatialView / GisView 共享同一 Cesium 实例）：
 * 首次调用挂载 GreyWorkCore.vue 于独立宿主 div，此后返回同一实例；
 * 路由切换时视图仅搬移 DOM 宿主，不销毁 Viewer；AppShell 卸载时统一 dispose。
 */
export function getGreyWorkCore(): GreyWorkCoreInstance {
  if (!instance) {
    const el = document.createElement("div");
    el.className = "gw-core-host";
    const app = createApp({ render: () => h(GreyWorkCore) });
    const exposed = app.mount(el) as unknown as {
      addGeoJson(data: unknown, name?: string): void;
      load3dTiles(url: string): Promise<void>;
    };
    instance = {
      el,
      addGeoJson: (data, name) => exposed.addGeoJson(data, name),
      load3dTiles: (url) => exposed.load3dTiles(url),
      dispose: () => {
        app.unmount();
        el.remove();
        instance = null;
      },
    };
  }
  return instance;
}

/** 视图侧共享宿主：挂载时把 singleton 宿主 appendChild 进本地面板，卸载时移除（不销毁）。 */
export function useSharedGreyWorkCore(hostRef: Ref<HTMLElement | null>): void {
  onMounted(() => {
    if (!hostRef.value) return;
    hostRef.value.appendChild(getGreyWorkCore().el);
  });

  onBeforeUnmount(() => {
    const el = getGreyWorkCore().el;
    el.parentElement?.removeChild(el);
  });
}
