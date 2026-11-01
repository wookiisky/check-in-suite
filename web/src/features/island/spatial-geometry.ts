import configuration from '../../../../internal/island/spatial-scene.json';

/** 保存坐标为整数厘米，几何交点允许内部使用分数厘米。 */
export interface SpatialPoint {
  x_cm: number; // 地面横坐标，整数厘米。
  z_cm: number; // 地面纵深，整数厘米。
}
/** 完整占地与模型外观、行走阻挡分别定义。 */
export interface SpatialFootprint {
  width_cm: number; // 未旋转宽度。
  depth_cm: number; // 未旋转纵深。
}
/** 只描述计算需要的地面变换，不携带相机状态。 */
export interface SpatialTransform extends SpatialPoint {
  rotation: number; // 四分之一圈，零到三。
}
/** 地形是有限多边形，不能把陆地之外全部当作水域。 */
export interface SpatialTerrainRegion {
  terrain: string; // 明确的地形身份。
  polygon: readonly SpatialPoint[]; // 有序有限边界，不重复首点。
}
/** 奇数宽度的占地可以产生半厘米边界。 */
export interface SpatialRect {
  min_x_cm: number; // 左边界。
  max_x_cm: number; // 右边界。
  min_z_cm: number; // 后边界。
  max_z_cm: number; // 前边界。
}

// 绘制与 Go 校验使用同一份版本场景，没有第二份手抄岸线。
export const spatialScene = configuration.scene;

// 四分之一圈交换长宽，位置始终使用同一坐标空间。
export function spatialPlacementRect(placement: SpatialTransform, footprint: SpatialFootprint): SpatialRect {
  const [width, depth] = placement.rotation % 2 ? [footprint.depth_cm, footprint.width_cm] : [footprint.width_cm, footprint.depth_cm];
  return { min_x_cm: placement.x_cm-width/2, max_x_cm: placement.x_cm+width/2, min_z_cm: placement.z_cm-depth/2, max_z_cm: placement.z_cm+depth/2 };
}

// 对完整占地求允许区域的并集面积，凹岸缺口与重复面积均不能放行。
export function spatialFootprintCovered(placement: SpatialTransform, footprint: SpatialFootprint, regions: readonly SpatialTerrainRegion[], allowed: readonly string[]): boolean {
  if (![placement.x_cm, placement.z_cm, placement.rotation, footprint.width_cm, footprint.depth_cm].every(Number.isSafeInteger) || placement.rotation < 0 || placement.rotation > 3 || footprint.width_cm <= 0 || footprint.depth_cm <= 0) return false;
  return spatialRectCovered(spatialPlacementRect(placement,footprint),regions,allowed);
}

// 实测房型和旋转占地产生的分数厘米边界直接参与面积计算，不改变保存坐标的整数契约。
export function spatialRectCovered(rect:SpatialRect,regions:readonly SpatialTerrainRegion[],allowed:readonly string[]):boolean {
  if(![rect.min_x_cm,rect.max_x_cm,rect.min_z_cm,rect.max_z_cm].every(Number.isFinite)||rect.min_x_cm>=rect.max_x_cm||rect.min_z_cm>=rect.max_z_cm)return false;
  const polygons = regions.filter((region) => allowed.includes(region.terrain) && region.polygon.length >= 3).map((region) => region.polygon);
  return Math.abs(coveredArea(rect, polygons) - (rect.max_x_cm-rect.min_x_cm)*(rect.max_z_cm-rect.min_z_cm)) <= 0.000001;
}

// 所有顶点、边交点及裁剪交点之间，垂线覆盖长度为线性函数，中点积分是精确面积。
function coveredArea(rect: SpatialRect, polygons: readonly (readonly SpatialPoint[])[]): number {
  const xs = [rect.min_x_cm, rect.max_x_cm];
  const edges: { x1: number; z1: number; x2: number; z2: number }[] = [];
  const addX = (x: number) => { if (x > rect.min_x_cm && x < rect.max_x_cm) xs.push(x); };
  for (const polygon of polygons) {
    polygon.forEach((point, index) => {
      const next = polygon[(index+1)%polygon.length]!;
      const edge = { x1: point.x_cm, z1: point.z_cm, x2: next.x_cm, z2: next.z_cm };
      edges.push(edge); addX(edge.x1);
      if (edge.z2 !== edge.z1) {
        for (const z of [rect.min_z_cm, rect.max_z_cm]) {
          const t = (z-edge.z1)/(edge.z2-edge.z1);
          if (t > 0 && t < 1) addX(edge.x1+t*(edge.x2-edge.x1));
        }
      }
    });
  }
  edges.forEach((first, index) => {
    for (const second of edges.slice(index+1)) {
      const rx = first.x2-first.x1, rz = first.z2-first.z1;
      const sx = second.x2-second.x1, sz = second.z2-second.z1;
      const denominator = rx*sz-rz*sx;
      if (Math.abs(denominator) < 1e-12) continue;
      const qx = second.x1-first.x1, qz = second.z1-first.z1;
      const t = (qx*sz-qz*sx)/denominator, u = (qx*rz-qz*rx)/denominator;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) addX(first.x1+t*rx);
    }
  });
  xs.sort((a,b) => a-b);
  let area = 0;
  for (let index = 1; index < xs.length; index++) {
    const width = xs[index]!-xs[index-1]!;
    if (width <= 1e-9) continue;
    const x = (xs[index]!+xs[index-1]!)/2;
    const intervals: { start: number; end: number }[] = [];
    for (const polygon of polygons) {
      const zs: number[] = [];
      polygon.forEach((point, edgeIndex) => {
        const next = polygon[(edgeIndex+1)%polygon.length]!;
        if ((point.x_cm <= x && next.x_cm > x) || (next.x_cm <= x && point.x_cm > x)) zs.push(point.z_cm+(x-point.x_cm)*(next.z_cm-point.z_cm)/(next.x_cm-point.x_cm));
      });
      zs.sort((a,b) => a-b);
      for (let zIndex = 1; zIndex < zs.length; zIndex += 2) {
        const start = Math.max(zs[zIndex-1]!, rect.min_z_cm), end = Math.min(zs[zIndex]!, rect.max_z_cm);
        if (end > start) intervals.push({start,end});
      }
    }
    if (!intervals.length) continue;
    intervals.sort((a,b) => a.start-b.start);
    let {start,end} = intervals[0]!, length = 0;
    for (const interval of intervals.slice(1)) {
      if (interval.start > end) { length += end-start; start = interval.start; end = interval.end; }
      else end = Math.max(end, interval.end);
    }
    area += width*(length+end-start);
  }
  return area;
}

// 地面边界接触可保留，只有内部重叠才算占用。
export function spatialRectsOverlap(first: SpatialRect, second: SpatialRect): boolean {
  return first.min_x_cm < second.max_x_cm && first.max_x_cm > second.min_x_cm && first.min_z_cm < second.max_z_cm && first.max_z_cm > second.min_z_cm;
}
