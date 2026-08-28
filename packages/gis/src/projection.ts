import { DEG2RAD, toRad } from "@greywork/core";
import type { Coordinate, MercatorPixel, TileAddress } from "./types";

export { DEG2RAD, toRad };

export const EARTH_RADIUS = 6378137;
export const TILE_SIZE = 256;

/**
 * WGS84 经纬度 -> Web 墨卡托像素坐标。
 * zoom = 0 时返回 256x256 的全局像素坐标。
 */
export function lonLatToWebMercator(coord: Coordinate, zoom = 0): MercatorPixel {
  const x = EARTH_RADIUS * toRad(coord.lon);
  const y = EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + toRad(coord.lat) / 2));
  const scale = 2 ** zoom;
  const world = TILE_SIZE * scale;
  const half = Math.PI * EARTH_RADIUS;
  return {
    x: ((x + half) / (2 * half)) * world,
    y: ((half - y) / (2 * half)) * world,
  };
}

/**
 * Web 墨卡托像素坐标 -> WGS84 经纬度。
 * lonLatToWebMercator 的逆变换，往返误差在浮点精度内。
 */
export function webMercatorToLonLat(pixel: MercatorPixel, zoom = 0): Coordinate {
  const scale = 2 ** zoom;
  const world = TILE_SIZE * scale;
  const half = Math.PI * EARTH_RADIUS;
  const x = ((pixel.x / world) * 2 - 1) * half;
  const y = (1 - (pixel.y / world) * 2) * half;
  return {
    lon: x / EARTH_RADIUS / DEG2RAD,
    lat: (2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2) / DEG2RAD,
  };
}

/** 经纬度 -> 指定 zoom 的瓦片地址 */
export function tileAddress(coord: Coordinate, zoom = 1): TileAddress {
  const { x, y } = lonLatToWebMercator(coord, zoom);
  return {
    z: zoom,
    x: Math.floor(x / TILE_SIZE),
    y: Math.floor(y / TILE_SIZE),
  };
}

export function formatCoordinate(coord: Coordinate, precision = 3): string {
  return `${coord.lon.toFixed(precision)}°, ${coord.lat.toFixed(precision)}°`;
}
