import { capabilitySeam, type CapabilityLoader } from "./loader";

/**
 * 当前能力加载器：默认应用级单例；测试在隔离文件里可换成自建 loader，
 * 让 Shell / Sider / 插件页等消费方与测试编排的 loader 对齐。
 */
let current: CapabilityLoader = capabilitySeam;

export function useCapabilityLoader(): CapabilityLoader {
  return current;
}

/** 仅测试用：换回 null 即恢复应用单例。 */
export function setCapabilityLoaderForTest(next: CapabilityLoader | null): void {
  current = next ?? capabilitySeam;
}
