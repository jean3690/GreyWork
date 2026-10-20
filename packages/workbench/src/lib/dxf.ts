/**
 * DXF（ASCII）→ 归一化 2D 图元。
 *
 * 预览只需要「看得见形状」，不追求 CAD 级精确：曲线（圆 / 弧 / 椭圆 / 多段线 bulge）
 * 一律采样成折线，样条用拟合点或控制点连成折线，块引用（INSERT）按平移/旋转/缩放展开。
 * 这样渲染端只处理一种图元（折线 + 文字 + 点），缩放/平移的实现也就只有一套。
 *
 * 不支持的实体（HATCH / 实体填充边界之外的复杂对象等）计入 `skipped`，不阻断整图。
 * 图元点数有硬上限：几万个实体的总平面图在预览里铺开没有意义，宁可截断并提示。
 */
import DxfParser, {
  type IArcEntity,
  type ICircleEntity,
  type IDimensionEntity,
  type IDxf,
  type IEllipseEntity,
  type IEntity,
  type IInsertEntity,
  type ILayer,
  type ILineEntity,
  type ILwpolylineEntity,
  type IMtextEntity,
  type IPoint,
  type IPointEntity,
  type IPolylineEntity,
  type ISplineEntity,
  type ITextEntity,
} from "dxf-parser";

export interface DxfPoint {
  x: number;
  y: number;
}

export interface DxfPath {
  points: DxfPoint[];
  closed: boolean;
  color: string;
  /** 实体填充（SOLID / 3DFACE）：渲染端用半透明填充。 */
  fill: boolean;
}

export interface DxfText {
  x: number;
  y: number;
  /** 字高（世界单位，渲染时乘缩放）。 */
  height: number;
  /** 逆时针角度（弧度）。 */
  rotation: number;
  text: string;
  color: string;
}

export interface DxfDot {
  x: number;
  y: number;
  color: string;
}

export interface DxfBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface DxfDrawing {
  paths: DxfPath[];
  texts: DxfText[];
  dots: DxfDot[];
  bounds: DxfBounds | null;
  /** 顶层实体数（INSERT 展开前）。 */
  entityCount: number;
  /** 无法渲染的实体数（含超出展开深度的块引用）。 */
  skipped: number;
  /** 点数超出预算，画面只包含前一部分。 */
  truncated: boolean;
}

/** 折线点总数上限：再大只会让 canvas 每次重绘都卡住。 */
const MAX_POINTS = 200_000;
/** 块引用递归展开上限（防自引用 / 深层嵌套把内存打爆）。 */
const MAX_INSERT_DEPTH = 8;
/** 圆的采样段数；弧按角度比例给。 */
const CIRCLE_SEGMENTS = 72;

/** 2D 仿射矩阵：x' = a·x + c·y + e，y' = b·x + d·y + f。 */
type Matrix = readonly [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** ACI 索引色（常用 1-9）；其余回落到前景色。 */
const ACI_COLORS: Record<number, string> = {
  1: "#ef4444",
  2: "#eab308",
  3: "#22c55e",
  4: "#06b6d4",
  5: "#3b82f6",
  6: "#d946ef",
  7: "#e5e7eb",
  8: "#9ca3af",
  9: "#d1d5db",
};

const DEFAULT_COLOR = "#e5e7eb";

function apply(matrix: Matrix, point: IPoint | DxfPoint): DxfPoint {
  return {
    x: matrix[0] * point.x + matrix[2] * point.y + matrix[4],
    y: matrix[1] * point.x + matrix[3] * point.y + matrix[5],
  };
}

/** 先应用 local，再应用 parent。 */
function compose(parent: Matrix, local: Matrix): Matrix {
  const [pa, pb, pc, pd, pe, pf] = parent;
  const [la, lb, lc, ld, le, lf] = local;
  return [pa * la + pc * lb, pb * la + pd * lb, pa * lc + pc * ld, pb * lc + pd * ld, pa * le + pc * lf + pe, pb * le + pd * lf + pf];
}

function translation(x: number, y: number): Matrix {
  return [1, 0, 0, 1, x, y];
}

function insertMatrix(entity: IInsertEntity): Matrix {
  const radians = ((entity.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const sx = entity.xScale || 1;
  const sy = entity.yScale || 1;
  return [sx * cos, sx * sin, -sy * sin, sy * cos, entity.position?.x ?? 0, entity.position?.y ?? 0];
}

/** 矩阵里的旋转角（度）与 X 方向缩放，用于块内文字的朝向与字高。 */
function matrixAngle(matrix: Matrix): number {
  return Math.atan2(matrix[1], matrix[0]);
}

function matrixScale(matrix: Matrix): number {
  return Math.hypot(matrix[0], matrix[1]) || 1;
}

function colorOf(entity: IEntity, layers: Record<string, ILayer>): string {
  // 真彩色（组码 420）优先；dxf-parser 缺省为 0，视为未设置。
  if (typeof entity.color === "number" && entity.color > 0) {
    return `#${(entity.color & 0xffffff).toString(16).padStart(6, "0")}`;
  }
  const index = entity.colorIndex;
  if (typeof index === "number" && index !== 0 && index !== 256 && ACI_COLORS[index]) {
    return ACI_COLORS[index];
  }
  const layerIndex = layers[entity.layer]?.colorIndex;
  return (typeof layerIndex === "number" && ACI_COLORS[layerIndex]) || DEFAULT_COLOR;
}

/**
 * 多段线相邻顶点间的圆弧（组码 42 bulge）采样。
 *
 * `bulge = tan(θ/4)`，θ 是圆弧的圆心角；返回**不含两端**的中间点 ——
 * 两端由调用方的顶点循环负责，避免重复。
 */
function bulgePoints(from: DxfPoint, to: DxfPoint, bulge: number): DxfPoint[] {
  if (!bulge) return [];
  const chord = Math.hypot(to.x - from.x, to.y - from.y);
  if (chord === 0) return [];
  const theta = 4 * Math.atan(bulge);
  const half = Math.sin(theta / 2);
  if (Math.abs(half) < 1e-9) return [];
  const radius = chord / (2 * half);
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  // 圆心在中点沿弦法线方向（左法线），距离由半径与半弦长决定；负 bulge 取反侧。
  const offset = Math.sign(theta) * Math.sqrt(Math.max(0, radius * radius - (chord / 2) ** 2));
  const nx = -(to.y - from.y) / chord;
  const ny = (to.x - from.x) / chord;
  const cx = mid.x + nx * offset;
  const cy = mid.y + ny * offset;
  const start = Math.atan2(from.y - cy, from.x - cx);
  const steps = Math.max(2, Math.ceil(Math.abs(theta) / (Math.PI / 18)));
  const points: DxfPoint[] = [];
  for (let step = 1; step < steps; step += 1) {
    const angle = start + (theta * step) / steps;
    points.push({ x: cx + Math.abs(radius) * Math.cos(angle), y: cy + Math.abs(radius) * Math.sin(angle) });
  }
  return points;
}

/** 圆 / 弧 / 椭圆共用的采样（角度制由调用方换成弧度）。 */
function sampleCurve(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  start: number,
  sweep: number,
  matrix: Matrix,
  segments = CIRCLE_SEGMENTS,
): DxfPoint[] {
  const count = Math.max(8, Math.ceil((Math.abs(sweep) / (Math.PI * 2)) * segments));
  const points: DxfPoint[] = [];
  for (let step = 0; step < count; step += 1) {
    const angle = start + (sweep * step) / count;
    points.push(apply(matrix, { x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle), z: 0 }));
  }
  return points;
}

class Builder {
  readonly paths: DxfPath[] = [];
  readonly texts: DxfText[] = [];
  readonly dots: DxfDot[] = [];
  skipped = 0;
  truncated = false;
  private usedPoints = 0;
  private minX = Infinity;
  private minY = Infinity;
  private maxX = -Infinity;
  private maxY = -Infinity;

  private include(point: DxfPoint): void {
    if (point.x < this.minX) this.minX = point.x;
    if (point.y < this.minY) this.minY = point.y;
    if (point.x > this.maxX) this.maxX = point.x;
    if (point.y > this.maxY) this.maxY = point.y;
  }

  addPath(points: DxfPoint[], closed: boolean, color: string, fill = false): void {
    if (points.length < 2) return;
    let accepted = points;
    const remaining = MAX_POINTS - this.usedPoints;
    if (points.length > remaining) {
      this.truncated = true;
      if (remaining < 2) return;
      accepted = points.slice(0, remaining);
    }
    this.usedPoints += accepted.length;
    this.paths.push({ points: accepted, closed, color, fill });
    for (const point of accepted) this.include(point);
  }

  addText(text: DxfText): void {
    if (!text.text.trim() || !Number.isFinite(text.height) || text.height <= 0) return;
    this.texts.push(text);
    // 文字宽度用「字高 × 字符数 × 0.6」估，够把范围撑开；旋转忽略（保守取正包围盒）。
    const width = Math.max(text.height, text.text.length * text.height * 0.6);
    this.include({ x: text.x, y: text.y });
    this.include({ x: text.x + width, y: text.y + text.height });
  }

  addDot(point: DxfPoint, color: string): void {
    this.dots.push({ x: point.x, y: point.y, color });
    this.include(point);
  }

  get bounds(): DxfBounds | null {
    return this.minX === Infinity ? null : { minX: this.minX, minY: this.minY, maxX: this.maxX, maxY: this.maxY };
  }
}

/** MTEXT 的简单格式码清理：换行 `\P`、字体/颜色等 `\Xxx;` 前缀。 */
function cleanMtext(value: string): string {
  return value
    .replace(/\\P/gi, "\n")
    .replace(/\\[A-Za-z][^;\\]*;/g, "")
    .replace(/[{}]/g, "");
}

function handleEntity(entity: IEntity, matrix: Matrix, doc: IDxf, layers: Record<string, ILayer>, builder: Builder, depth: number): void {
  if (entity.visible === false) return;
  const color = colorOf(entity, layers);

  switch (entity.type) {
    case "LINE": {
      const line = entity as ILineEntity;
      if (!line.vertices || line.vertices.length < 2) return;
      builder.addPath([apply(matrix, line.vertices[0]), apply(matrix, line.vertices[1])], false, color);
      return;
    }
    case "LWPOLYLINE":
    case "POLYLINE": {
      const poly = entity as ILwpolylineEntity | IPolylineEntity;
      const vertices = poly.vertices ?? [];
      if (vertices.length < 2) return;
      const closed = poly.shape === true;
      const points: DxfPoint[] = [];
      for (let index = 0; index < vertices.length; index += 1) {
        const current = vertices[index];
        points.push(apply(matrix, current));
        const nextIndex = index + 1;
        if (nextIndex < vertices.length || closed) {
          const next = vertices[nextIndex % vertices.length];
          if (current.bulge && next) points.push(...bulgePoints(current, next, current.bulge).map((p) => apply(matrix, p)));
        }
      }
      builder.addPath(points, closed, color);
      return;
    }
    case "CIRCLE": {
      const circle = entity as ICircleEntity;
      if (!circle.center || !circle.radius) return;
      const points = sampleCurve(circle.center.x, circle.center.y, circle.radius, circle.radius, 0, Math.PI * 2, matrix);
      builder.addPath(points, true, color);
      return;
    }
    case "ARC": {
      const arc = entity as IArcEntity;
      if (!arc.center || !arc.radius) return;
      const sweep = arc.endAngle - arc.startAngle;
      const normalized = sweep <= 0 ? sweep + Math.PI * 2 : sweep;
      const points = sampleCurve(arc.center.x, arc.center.y, arc.radius, arc.radius, arc.startAngle, normalized, matrix);
      builder.addPath(points, false, color);
      return;
    }
    case "ELLIPSE": {
      const ellipse = entity as IEllipseEntity;
      if (!ellipse.center || !ellipse.majorAxisEndPoint) return;
      const major = Math.hypot(ellipse.majorAxisEndPoint.x, ellipse.majorAxisEndPoint.y);
      if (major === 0) return;
      const angle = Math.atan2(ellipse.majorAxisEndPoint.y, ellipse.majorAxisEndPoint.x);
      const minor = major * (ellipse.axisRatio || 1);
      const start = ellipse.startAngle ?? 0;
      const end = ellipse.endAngle ?? Math.PI * 2;
      const sweep = end - start <= 0 ? end - start + Math.PI * 2 : end - start;
      const count = Math.max(16, Math.ceil((sweep / (Math.PI * 2)) * CIRCLE_SEGMENTS));
      const points: DxfPoint[] = [];
      for (let step = 0; step < count; step += 1) {
        const t = start + (sweep * step) / count;
        // 先算椭圆自身坐标，再按长轴方向旋转。
        const localX = major * Math.cos(t);
        const localY = minor * Math.sin(t);
        points.push(
          apply(matrix, {
            x: ellipse.center.x + localX * Math.cos(angle) - localY * Math.sin(angle),
            y: ellipse.center.y + localX * Math.sin(angle) + localY * Math.cos(angle),
            z: 0,
          }),
        );
      }
      builder.addPath(points, Math.abs(sweep - Math.PI * 2) < 1e-6, color);
      return;
    }
    case "SPLINE": {
      const spline = entity as ISplineEntity;
      const source = spline.fitPoints?.length ? spline.fitPoints : spline.controlPoints;
      if (!source || source.length < 2) return;
      builder.addPath(
        source.map((point) => apply(matrix, point)),
        spline.closed === true,
        color,
      );
      return;
    }
    case "TEXT": {
      const text = entity as ITextEntity;
      if (!text.startPoint) return;
      const point = apply(matrix, text.startPoint);
      builder.addText({
        x: point.x,
        y: point.y,
        height: (text.textHeight || 1) * matrixScale(matrix),
        rotation: ((text.rotation ?? 0) * Math.PI) / 180 + matrixAngle(matrix),
        text: text.text ?? "",
        color,
      });
      return;
    }
    case "MTEXT": {
      const text = entity as IMtextEntity;
      if (!text.position) return;
      const point = apply(matrix, text.position);
      const height = (text.height || 1) * matrixScale(matrix);
      const rotation = ((text.rotation ?? 0) * Math.PI) / 180 + matrixAngle(matrix);
      const lines = cleanMtext(text.text ?? "").split("\n");
      lines.forEach((line, index) => {
        builder.addText({
          x: point.x,
          y: point.y - index * height * 1.25,
          height,
          rotation,
          text: line,
          color,
        });
      });
      return;
    }
    case "POINT": {
      const point = entity as IPointEntity;
      if (point.position) builder.addDot(apply(matrix, point.position), color);
      return;
    }
    case "SOLID":
    case "3DFACE": {
      // SOLID 用 points，3DFACE 用 vertices；按结构取，避免在联合类型上互相窄化。
      const solid = entity as IEntity & { points?: IPoint[]; vertices?: IPoint[] };
      const points = (solid.points ?? solid.vertices ?? []).map((point) => apply(matrix, point));
      if (points.length >= 3) builder.addPath(points, true, color, entity.type === "SOLID");
      return;
    }
    case "INSERT": {
      const insert = entity as IInsertEntity;
      const block = doc.blocks?.[insert.name];
      if (!block || depth >= MAX_INSERT_DEPTH) {
        builder.skipped += 1;
        return;
      }
      const local = insertMatrix(insert);
      const columns = Math.max(1, insert.columnCount || 1);
      const rows = Math.max(1, insert.rowCount || 1);
      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          const offset = translation(column * (insert.columnSpacing || 0), row * (insert.rowSpacing || 0));
          const instance = compose(matrix, compose(local, offset));
          for (const child of block.entities) handleEntity(child, instance, doc, layers, builder, depth + 1);
        }
      }
      return;
    }
    case "DIMENSION": {
      // 标注的实际几何在匿名块里（*D1 之类），按块展开即可。
      const dimension = entity as IDimensionEntity;
      const block = dimension.block ? doc.blocks?.[dimension.block] : undefined;
      if (!block || depth >= MAX_INSERT_DEPTH) {
        builder.skipped += 1;
        return;
      }
      for (const child of block.entities) handleEntity(child, matrix, doc, layers, builder, depth + 1);
      return;
    }
    default:
      builder.skipped += 1;
  }
}

/** 解析 ASCII DXF 文本；格式不合法时抛出可展示的错误。 */
export function parseDxf(text: string): DxfDrawing {
  const doc = new DxfParser().parseSync(text);
  if (!doc) throw new Error("DXF 解析失败：文件为空或不是受支持的 ASCII DXF");

  const builder = new Builder();
  const layers = doc.tables?.layer?.layers ?? {};
  for (const entity of doc.entities ?? []) handleEntity(entity, IDENTITY, doc, layers, builder, 0);

  return {
    paths: builder.paths,
    texts: builder.texts,
    dots: builder.dots,
    bounds: builder.bounds,
    entityCount: doc.entities?.length ?? 0,
    skipped: builder.skipped,
    truncated: builder.truncated,
  };
}
