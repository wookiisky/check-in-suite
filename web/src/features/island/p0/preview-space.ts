/** 样片沿用米制、Y 轴向上的地面坐标，不参与正式布局保存。 */
export type PreviewPoint = [number, number, number];
export type PreviewWall = 'north' | 'east' | 'south' | 'west';

// 房屋由 2 米宽的 Kenney 构件组成，门在南墙中央。
export const previewHouse = { halfSize: 3, floorHeight: 0.1, wallHeight: 2.4, doorWidth: 0.9, doorHeight: 2.1 };

// 四方向旋转保持相机俯角，不开放任意滚转和仰角。
export function rotateCamera(direction: number, step: number): number {
  return (direction + step + 4) % 4;
}

// 相机方位依次为东南、东北、西北、西南。
export function cameraPosition(direction: number): PreviewPoint {
  const angle = Math.PI / 4 + direction * Math.PI / 2;
  return [Math.sin(angle) * 15, 12, Math.cos(angle) * 15];
}

// 墙体剖切随视角变化，关闭室内时保留全部外墙。
export function hiddenWalls(direction: number, open: boolean): PreviewWall[] {
  if (!open) return [];
  const walls: PreviewWall[][] = [['south', 'east'], ['north', 'east'], ['north', 'west'], ['south', 'west']];
  return walls[direction] ?? walls[0]!;
}

// 进出沿同一条门口路径，避免直接跨过实体墙。
export function doorRoute(entering: boolean): PreviewPoint[] {
  const route: PreviewPoint[] = [[0, previewHouse.floorHeight, 5], [0, previewHouse.floorHeight, 3], [0, previewHouse.floorHeight, 0]];
  return entering ? route : route.reverse();
}

/** 路径推进结果只描述世界位置，不修改骨骼动画。 */
export interface PreviewRoutePosition {
  position: PreviewPoint; // 当前地面位置。
  arrived: boolean; // 已到最终路径点。
  facing: number; // 以 +z 为前向的朝向。
}

// 使用累计行程推进，暂停时不增加行程即可冻结位置。
export function moveAlongRoute(route: PreviewPoint[], distance: number): PreviewRoutePosition {
  let remaining = distance;
  let facing = 0;
  for (let index = 1; index < route.length; index++) {
    const from = route[index - 1]!;
    const to = route[index]!;
    const dx = to[0] - from[0];
    const dz = to[2] - from[2];
    const length = Math.hypot(dx, dz);
    facing = Math.atan2(dx, dz);
    if (remaining < length) {
      const amount = remaining / length;
      return { position: [from[0] + dx * amount, from[1] + (to[1] - from[1]) * amount, from[2] + dz * amount], arrived: false, facing };
    }
    remaining -= length;
  }
  return { position: route[route.length - 1]!, arrived: true, facing };
}
