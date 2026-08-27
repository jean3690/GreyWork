import type { Vector3 } from "./types";

export const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const normalize = (v: Vector3): Vector3 => {
  const length = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / length, y: v.y / length, z: v.z / length };
};

export const add = (a: Vector3, b: Vector3): Vector3 => ({
  x: a.x + b.x,
  y: a.y + b.y,
  z: a.z + b.z,
});

export const scale = (v: Vector3, s: number): Vector3 => ({
  x: v.x * s,
  y: v.y * s,
  z: v.z * s,
});

export const formatNumber = (value: number, precision = 2): string => value.toFixed(precision);
