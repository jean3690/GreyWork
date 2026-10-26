/**
 * KML / GPX / KMZ 解析：XML 路线的契约。
 *
 * 1. togeojson 要的是 XML DOM，而 DOMParser 对非法 XML **不抛异常** —— 必须自己查
 *    `parsererror`，否则用户得到的是一张空图（最难查的失败形态）；
 * 2. KMZ 是 zip 里装的 KML，取第一个 .kml 即可；
 * 3. GPX 的轨迹段要变成 LineString（按几何类型分层的逻辑才用得上）。
 */
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { kmzToKmlText, parseGpxText, parseKmlText } from "@/lib/gis-formats";

const KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Placemark>
      <name>天安门</name>
      <Point><coordinates>116.3913,39.9075,0</coordinates></Point>
    </Placemark>
  </Document>
</kml>`;

const GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test">
  <trk>
    <name>晨跑</name>
    <trkseg>
      <trkpt lat="39.9" lon="116.39"><ele>44</ele></trkpt>
      <trkpt lat="39.91" lon="116.4"><ele>45</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

describe("parseKmlText", () => {
  it("Placemark 变成点要素，name 进 properties", () => {
    const collection = parseKmlText(KML);
    expect(collection.features).toHaveLength(1);
    expect(collection.features[0].geometry).toMatchObject({ type: "Point", coordinates: [116.3913, 39.9075, 0] });
    expect(collection.features[0].properties).toMatchObject({ name: "天安门" });
  });

  it("非法 XML 给的是 XML 错误，而不是一张空图", () => {
    expect(() => parseKmlText("<kml><Document>")).toThrow(/不是合法的 XML/);
  });
});

describe("parseGpxText", () => {
  it("轨迹段变成 LineString", () => {
    const collection = parseGpxText(GPX);
    expect(collection.features).toHaveLength(1);
    expect(collection.features[0].geometry).toMatchObject({ type: "LineString" });
  });

  it("非法 XML 同样给 XML 错误", () => {
    expect(() => parseGpxText("<gpx>")).toThrow(/不是合法的 XML/);
  });
});

describe("kmzToKmlText", () => {
  it("从 zip 里取出 .kml 文本", async () => {
    const zip = new JSZip();
    zip.file("doc.kml", KML);
    zip.file("readme.txt", "ignored");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    expect(await kmzToKmlText(bytes)).toContain("<Placemark>");
  });

  it("zip 里没有 .kml 时明确报错", async () => {
    const zip = new JSZip();
    zip.file("notes.txt", "nope");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    await expect(kmzToKmlText(bytes)).rejects.toThrow(/没有 \.kml/);
  });
});
