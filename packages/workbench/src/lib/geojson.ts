/**
 * 最小 GeoJSON 类型与归一化（纯逻辑，便于单测）。
 *
 * 不引 `@types/geojson`：这里只需要「FeatureCollection」一种形状 —— MapLibre 的
 * geojson source 只吃它。其余合法变体（裸几何、单个 Feature）在归一化时补齐。
 */

export interface GeoJsonFeature {
  type: "Feature";
  properties: Record<string, unknown> | null;
  geometry: unknown;
}

export interface GeoJsonFeatureCollection {
  type: "FeatureCollection";
  features: GeoJsonFeature[];
}

/** GeoJSON 认得的几何类型（不含 Feature / FeatureCollection）。 */
const GEOMETRY_TYPES: ReadonlySet<string> = new Set([
  "Point",
  "MultiPoint",
  "LineString",
  "MultiLineString",
  "Polygon",
  "MultiPolygon",
  "GeometryCollection",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asFeature(value: Record<string, unknown>): GeoJsonFeature | null {
  if (value.type !== "Feature") return null;
  return {
    type: "Feature",
    properties: isObject(value.properties) ? value.properties : null,
    geometry: value.geometry,
  };
}

/**
 * 把任意合法 GeoJSON 归一成 FeatureCollection；不合法返回 null。
 *
 * 「要素数」「图层分类」这些 UI 都按 `features` 数组算，所以统一补成一种形状，
 * 而不是在渲染层到处判 type。不合法时返回 null 由调用方给人话错误 ——
 * 静默画出一张空图比报错难查得多。
 */
export function toFeatureCollection(input: unknown): GeoJsonFeatureCollection | null {
  if (!isObject(input)) return null;
  const { type } = input;

  if (type === "FeatureCollection") {
    if (!Array.isArray(input.features)) return null;
    const features: GeoJsonFeature[] = [];
    for (const raw of input.features) {
      if (!isObject(raw)) return null;
      const feature = asFeature(raw);
      if (!feature) return null;
      features.push(feature);
    }
    return { type: "FeatureCollection", features };
  }

  if (type === "Feature") {
    const feature = asFeature(input);
    return feature ? { type: "FeatureCollection", features: [feature] } : null;
  }

  if (typeof type === "string" && GEOMETRY_TYPES.has(type)) {
    return { type: "FeatureCollection", features: [{ type: "Feature", properties: null, geometry: input }] };
  }

  return null;
}

/** 解析 GeoJSON 文本；非法 JSON 或非法 GeoJSON 都抛人话错误。 */
export function parseGeoJsonText(text: string): GeoJsonFeatureCollection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`不是合法 JSON：${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const collection = toFeatureCollection(parsed);
  if (!collection) throw new Error("不是合法的 GeoJSON（缺 type，或几何类型不认识）");
  return collection;
}

/**
 * 按几何类型给每个要素挑一个图层类别。
 *
 * 点 / 线 / 面要用不同的绘制方式（circle / line / fill），所以先分类再分别建 layer；
 * 一个要素集合里混着三种几何是常态，不能只按第一个要素决定。
 */
export type GeoJsonShape = "point" | "line" | "polygon";

export function shapeOfGeometry(geometry: unknown): GeoJsonShape | null {
  if (!isObject(geometry)) return null;
  switch (geometry.type) {
    case "Point":
    case "MultiPoint":
      return "point";
    case "LineString":
    case "MultiLineString":
      return "line";
    case "Polygon":
    case "MultiPolygon":
      return "polygon";
    case "GeometryCollection": {
      const geometries = geometry.geometries;
      if (!Array.isArray(geometries)) return null;
      // 取第一个能识别的子几何作为类别：混合集合在预览里只能挑一种画法。
      for (const child of geometries) {
        const shape = shapeOfGeometry(child);
        if (shape) return shape;
      }
      return null;
    }
    default:
      return null;
  }
}

/** 要素集合里出现过的图层类别（顺序固定：点 → 线 → 面）。 */
export function shapesOfCollection(collection: GeoJsonFeatureCollection): GeoJsonShape[] {
  const found = new Set<GeoJsonShape>();
  for (const feature of collection.features) {
    const shape = shapeOfGeometry(feature.geometry);
    if (shape) found.add(shape);
  }
  return (["point", "line", "polygon"] as const).filter((shape) => found.has(shape));
}

/** 每类几何的要素数；某类没有要素时是 0（不是缺键）。 */
export function countByShape(collection: GeoJsonFeatureCollection): Record<GeoJsonShape, number> {
  const counts: Record<GeoJsonShape, number> = { point: 0, line: 0, polygon: 0 };
  for (const feature of collection.features) {
    const shape = shapeOfGeometry(feature.geometry);
    if (shape) counts[shape] += 1;
  }
  return counts;
}

/**
 * 画不出来的要素数：`geometry` 为 null 或类型不认识。
 *
 * 这些要素在 MapLibre 里会被静默跳过 —— 不报错、不显示，要素数却把它们算进去了。
 * 单独数出来给一句提示，比让人对着「12 个要素、地图上却只有 8 个图形」自己猜强。
 */
export function unrenderableCount(collection: GeoJsonFeatureCollection): number {
  return collection.features.reduce((total, feature) => (shapeOfGeometry(feature.geometry) ? total : total + 1), 0);
}

/** 经纬度包围盒 `[west, south, east, north]`。 */
export type LonLatBounds = [number, number, number, number];

/**
 * 包围盒是否落在合法经纬度范围外。
 *
 * 用于识别「投影坐标没有重投影」：UTM / 高斯 / Web Mercator 的坐标是米（几十万到两千万），
 * 远超 ±180 / ±90。这类数据直接交给 MapLibre 会画在地球外的无意义位置，所以除了提示，
 * 自动 fit 也要跳过（否则视野会被带到一个空区域，看起来像渲染失败）。
 *
 * 这只是个「显然不是经纬度」的探针，不判断具体是哪种投影 —— 那需要读 .prj / EPSG 定义，
 * 超出预览的职责（转换交给 GDAL，见内置技能规划）。
 */
export function isOutsideLonLat(bounds: LonLatBounds): boolean {
  const [west, south, east, north] = bounds;
  return west < -180 || east > 180 || south < -90 || north > 90;
}

/**
 * 单点几何的坐标 `[lon, lat]`；非 Point / 坐标不合法返回 null。
 *
 * 属性面板给点要素显示经纬度：shapefile 的 .dbf 里常常没有坐标字段，
 * 唯一能看到的「这个点在哪」就是几何本身。
 */
export function pointOfGeometry(geometry: unknown): [number, number] | null {
  if (!isObject(geometry) || geometry.type !== "Point") return null;
  const coordinates = geometry.coordinates;
  if (!Array.isArray(coordinates)) return null;
  const [lon, lat] = coordinates;
  return typeof lon === "number" && typeof lat === "number" ? [lon, lat] : null;
}

function extendWithCoordinates(bounds: LonLatBounds, node: unknown): void {
  if (!Array.isArray(node)) return;
  if (typeof node[0] === "number" && typeof node[1] === "number") {
    const [lon, lat] = node as [number, number];
    if (lon < bounds[0]) bounds[0] = lon;
    if (lat < bounds[1]) bounds[1] = lat;
    if (lon > bounds[2]) bounds[2] = lon;
    if (lat > bounds[3]) bounds[3] = lat;
    return;
  }
  for (const child of node) extendWithCoordinates(bounds, child);
}

function extendWithGeometry(bounds: LonLatBounds, geometry: unknown): void {
  if (!isObject(geometry)) return;
  if (geometry.type === "GeometryCollection") {
    const children = geometry.geometries;
    if (Array.isArray(children)) for (const child of children) extendWithGeometry(bounds, child);
    return;
  }
  extendWithCoordinates(bounds, geometry.coordinates);
}

/**
 * 算要素集合的经纬度包围盒；没有任何坐标时返回 null。
 *
 * 自己算而不是用 `LngLatBounds`：这是纯函数，可以脱离 MapLibre 单测，而地图初始化
 * 失败时（没有 WebGL）也不会连带把「能不能算出视野」这件事一起丢掉。
 *
 * 不处理跨 ±180° 的要素 —— 那种数据在预览里本来就该由用户自己缩放到目标区域。
 */
export function boundsOfCollection(collection: GeoJsonFeatureCollection): LonLatBounds | null {
  const bounds: LonLatBounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const feature of collection.features) extendWithGeometry(bounds, feature.geometry);
  return Number.isFinite(bounds[0]) && Number.isFinite(bounds[1]) ? bounds : null;
}
