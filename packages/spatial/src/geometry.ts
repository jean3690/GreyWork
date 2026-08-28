import { DEG2RAD, scale, type Vector3 } from "@greywork/core";
import type { OrientedPoint } from "./types";

export { DEG2RAD };

export function sphericalToCartesian(lat: number, lon: number, radius = 1): Vector3 {
  const latRad = lat * DEG2RAD;
  const lonRad = lon * DEG2RAD;
  const cosLat = Math.cos(latRad);
  return {
    x: radius * cosLat * Math.cos(lonRad),
    y: radius * Math.sin(latRad),
    z: radius * cosLat * Math.sin(lonRad),
  };
}

export function rotateY(vector: Vector3, angle: number): Vector3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return {
    x: vector.x * c + vector.z * s,
    y: vector.y,
    z: -vector.x * s + vector.z * c,
  };
}

export function rotateX(vector: Vector3, angle: number): Vector3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return {
    x: vector.x,
    y: vector.y * c - vector.z * s,
    z: vector.y * s + vector.z * c,
  };
}

export function orient(points: Vector3[], rotY: number, rotX: number): OrientedPoint[] {
  return points.map((point) => {
    const rotated = rotateX(rotateY(point, rotY), rotX);
    return {
      position: rotated,
      depth: rotated.z,
      visible: rotated.z > -0.45,
    };
  });
}

export function buildSphereGrid(latStep = 30, lonStep = 30, radius = 1): Vector3[] {
  const points: Vector3[] = [];
  for (let lat = -90; lat <= 90; lat += latStep) {
    for (let lon = -180; lon < 180; lon += lonStep) {
      points.push(sphericalToCartesian(lat, lon, radius));
    }
  }
  return points;
}

export function fitPointCloud(positions: OrientedPoint[], radius: number): Vector3[] {
  return positions.map(({ position }) => scale(position, radius));
}
