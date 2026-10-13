/** 运行时环境探测（WebGL 可用性）。 */

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
