/** 三维向量 */
export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

/** 轴对齐包围盒 */
export interface Bounds3 {
  min: Vector3;
  max: Vector3;
}

/** 名称 + 版本 的通用元信息 */
export interface PackageInfo {
  name: string;
  version: string;
  description?: string;
}
