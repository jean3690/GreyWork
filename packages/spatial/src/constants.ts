import type { OrbitRing } from "./types";

export const DEFAULT_RINGS: OrbitRing[] = [
  { id: "orbit-planner", label: "规划环", radius: 1.32, inclination: -0.55, speed: 0.42, color: "#ffb85c", count: 6 },
  { id: "orbit-gis", label: "地理环", radius: 1.58, inclination: 0.62, speed: -0.3, color: "#3ed6e8", count: 5 },
  { id: "orbit-spatial", label: "空间环", radius: 1.84, inclination: 0.2, speed: 0.55, color: "#9e88ff", count: 4 },
];

export function describeScene(scene: { name: string; nodes: number; rings: OrbitRing[]; grid: boolean }): string {
  return `${scene.name} · ${scene.nodes} nodes · ${scene.rings.length} orbit rings · ${scene.grid ? "grid on" : "grid off"}`;
}
