/**
 * `shpjs` 没有自带类型（package.json 无 `types` 字段），这里按实际用到的形状声明。
 *
 * 只声明本项目用到的部分：`parseShp` / `parseDbf` / `combine`。
 * 用到的函数签名以 shpjs 6.2.0 的 `lib/index.js` 为准。
 */
declare module "shpjs" {
  import type { GeoJsonFeatureCollection } from "@/lib/geojson";

  /** 解析 .shp 主文件，返回 GeoJSON 几何数组。`prj` 传 .prj 文本时按其投影转换到 WGS84。 */
  export function parseShp(shp: ArrayBuffer | Uint8Array, prj?: string | false): unknown[];

  /** 解析 .dbf 属性表，返回与几何一一对应的属性数组。 */
  export function parseDbf(dbf: ArrayBuffer | Uint8Array, cpg?: string): Array<Record<string, unknown>>;

  /** 合并几何与属性为 FeatureCollection；`dbf` 缺省时属性为空对象。 */
  export function combine(input: [unknown[], Array<Record<string, unknown>>?]): GeoJsonFeatureCollection;

  export function parseZip(buffer: ArrayBuffer | Uint8Array, whiteList?: string[]): Promise<unknown>;

  /** 默认导出：按 URL 或 buffer 拉取 shapefile（本项目不用，保留形状以免误用无声失败）。 */
  export default function getShapefile(base: string | ArrayBuffer | Uint8Array, whiteList?: string[]): Promise<unknown>;
}
