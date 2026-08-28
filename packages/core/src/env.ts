/** 运行时环境探测（desktop = Tauri IPC 宿主 / WebGL 可用性）。 */

/** 当前运行在 Tauri 桌面壳（渲染端有 __TAURI_INTERNALS__ 注入）。 */
export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 当前环境是否支持 WebGL（Cesium / MapLibre 等引擎可用性探测）。 */
export function hasWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
    return !!gl;
  } catch {
    return false;
  }
}
