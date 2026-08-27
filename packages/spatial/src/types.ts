import type { Vector3 } from "@greywork/core";

/** 环绕核心的轨道环，对应一组 Agent / 数据节点的空间编排 */
export interface OrbitRing {
  id: string;
  label: string;
  radius: number;
  inclination: number;
  speed: number;
  color: string;
  count: number;
}

/** 3D 空间场景描述 */
export interface SpatialScene {
  name: string;
  nodes: number;
  rings: OrbitRing[];
  grid: boolean;
}

/** 经过旋转/透视变换后的点 */
export interface OrientedPoint {
  position: Vector3;
  depth: number;
  visible: boolean;
}
