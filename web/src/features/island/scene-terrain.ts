import type { IslandPoint } from './island-types';

export type TerrainKind = 'grass' | 'sand' | 'water';

// 地形使用无洞的简单多边形；不同地形只共边，同类区域允许重叠。
export interface TerrainRegion {
  kind: TerrainKind; // 地形能力，与现有室内外保存区域分开。
  polygon: readonly IslandPoint[]; // 与物品布局相同的世界坐标，首尾自动闭合。
}

// 有向边只用于几何计算，不持有画布或 React 状态。
interface TerrainEdge {
  start: IslandPoint; // 起点。
  end: IslandPoint; // 终点。
}

// 一个垂直截面中连续的地形或占地范围。
interface TerrainInterval {
  start: number; // 较小的世界纵坐标。
  end: number; // 较大的世界纵坐标。
}

const tolerance = 1e-8;

// 闭合多边形的边由顶点顺序唯一决定。
function edges(polygon: readonly IslandPoint[]): TerrainEdge[] {
  return polygon.map((start, index) => ({ start, end: polygon[(index + 1) % polygon.length]! }));
}

// 边界点也属于地形，允许物品恰好接触岸线。
function contains(polygon: readonly IslandPoint[], point: IslandPoint): boolean {
  let inside = false;
  for (const { start, end } of edges(polygon)) {
    const cross = (point.x - start.x) * (end.y - start.y) - (point.y - start.y) * (end.x - start.x);
    if (Math.abs(cross) <= tolerance && point.x >= Math.min(start.x, end.x) - tolerance && point.x <= Math.max(start.x, end.x) + tolerance && point.y >= Math.min(start.y, end.y) - tolerance && point.y <= Math.max(start.y, end.y) + tolerance) return true;
    if ((start.y > point.y) !== (end.y > point.y) && point.x < start.x + (point.y - start.y) * (end.x - start.x) / (end.y - start.y)) inside = !inside;
  }
  return inside;
}

// 场景之外没有可用地形；共用边界按区域声明顺序取第一个。
export function terrainAt(regions: readonly TerrainRegion[], point: IslandPoint): TerrainKind | null {
  return regions.find((region) => contains(region.polygon, point))?.kind ?? null;
}

// 截面避开顶点，简单多边形的交点按顺序两两组成内部区间。
function intervalsAt(polygon: readonly IslandPoint[], x: number): TerrainInterval[] {
  const intersections = edges(polygon).flatMap(({ start, end }) => {
    if ((start.x <= x && end.x > x) || (end.x <= x && start.x > x)) return [start.y + (x - start.x) * (end.y - start.y) / (end.x - start.x)];
    return [];
  }).sort((a, b) => a - b);
  const result: TerrainInterval[] = [];
  for (let index = 0; index + 1 < intersections.length; index += 2) result.push({ start: intersections[index]!, end: intersections[index + 1]! });
  return result;
}

// 相交边的交点也是截面顺序可能改变的位置；共线边只需原有顶点。
function crossingX(first: TerrainEdge, second: TerrainEdge): number | null {
  const dx = first.end.x - first.start.x, dy = first.end.y - first.start.y;
  const ex = second.end.x - second.start.x, ey = second.end.y - second.start.y;
  const determinant = dx * ey - dy * ex;
  if (Math.abs(determinant) <= tolerance) return null;
  const ox = second.start.x - first.start.x, oy = second.start.y - first.start.y;
  const alongFirst = (ox * ey - oy * ex) / determinant;
  const alongSecond = (ox * dy - oy * dx) / determinant;
  if (alongFirst < 0 || alongFirst > 1 || alongSecond < 0 || alongSecond > 1) return null;
  return first.start.x + alongFirst * dx;
}

// 合并相邻或重叠区间，验证占地截面没有穿过未允许的空隙。
function covers(required: TerrainInterval, available: readonly TerrainInterval[]): boolean {
  let cursor = required.start;
  for (const interval of available) {
    if (interval.end < cursor) continue;
    if (interval.start > cursor + tolerance) return false;
    cursor = Math.max(cursor, interval.end);
    if (cursor >= required.end - tolerance) return true;
  }
  return false;
}

// 完整简单多边形占地必须落在允许地形的并集内，既检查边也检查内部。
export function canOccupyTerrain(regions: readonly TerrainRegion[], footprint: readonly IslandPoint[], allowed: readonly TerrainKind[]): boolean {
  if (footprint.length < 3) return false;
  const signedArea = edges(footprint).reduce((area, edge) => area + edge.start.x * edge.end.y - edge.end.x * edge.start.y, 0);
  if (Math.abs(signedArea) <= tolerance) return false;
  const permitted = regions.filter((region) => allowed.includes(region.kind));
  if (!footprint.every((point) => permitted.some((region) => contains(region.polygon, point)))) return false;

  // 所有顶点和交点把平面分成区间；区间内部的边线顺序固定，只需一次截面。
  // 仅检查四角会漏掉凹形海湾，仅检查边框会漏掉占地内部的不可用区域。
  const polygons = [footprint, ...permitted.map((region) => region.polygon)];
  const boundaries = polygons.flatMap(edges);
  const minX = Math.min(...footprint.map((point) => point.x));
  const maxX = Math.max(...footprint.map((point) => point.x));
  const cuts = polygons.flatMap((polygon) => polygon.map((point) => point.x)).filter((x) => x >= minX && x <= maxX);
  for (let first = 0; first < boundaries.length; first += 1) {
    for (let second = first + 1; second < boundaries.length; second += 1) {
      const x = crossingX(boundaries[first]!, boundaries[second]!);
      if (x !== null && x > minX && x < maxX) cuts.push(x);
    }
  }
  const sorted = [...new Set(cuts)].sort((a, b) => a - b);
  for (let index = 0; index + 1 < sorted.length; index += 1) {
    const left = sorted[index]!, right = sorted[index + 1]!;
    if (right - left <= tolerance) continue;
    const x = (left + right) / 2;
    const available = permitted.flatMap((region) => intervalsAt(region.polygon, x)).sort((a, b) => a.start - b.start);
    if (intervalsAt(footprint, x).some((required) => !covers(required, available))) return false;
  }
  return true;
}
