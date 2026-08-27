export type LocalSpatialSourceType = "mbtiles" | "geojson" | "3dtiles" | "raster";

export interface LocalSpatialSource {
  id: string;
  type: LocalSpatialSourceType;
  path: string;
  name: string;
  layers?: string[];
}

export function createLocalSpatialSource(id: string, type: LocalSpatialSourceType, path: string, name: string = type): LocalSpatialSource {
  return { id, type, path, name };
}

export const SAMPLE_LOCAL_SOURCES: LocalSpatialSource[] = [
  createLocalSpatialSource("beijing-3dtiles", "3dtiles", "/data/beijing/tileset.json", "北京 3D Tiles"),
  createLocalSpatialSource("cities-geojson", "geojson", "/data/cities.geojson", "城市点位"),
  createLocalSpatialSource("terrain-mbtiles", "mbtiles", "/data/terrain.mbtiles", "地形 MBTiles"),
];

export function describeLocalSource(source: LocalSpatialSource): string {
  return source.name + " · " + source.type + " · " + source.path;
}
