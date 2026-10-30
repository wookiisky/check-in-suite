import layout from '../../../../internal/island/house-layout.json' with { type: 'json' };
import type { IslandPoint } from './island-types';

// 固定房间矩形采用地面坐标，绘图和摆放使用同一个定义。
export interface HouseRectangle {
  minX: number; // 左边界。
  maxX: number; // 右边界。
  minY: number; // 后边界。
  maxY: number; // 前边界。
}

// 服务端嵌入同一配置，避免房门、墙体或室内边界在两端漂移。
interface HouseLayout {
  width: number; // 室内完整宽度。
  depth: number; // 室内完整深度。
  wallThickness: number; // 隔墙实际占地厚度。
  wallHeight: number; // 完整后墙的绘制高度。
  bathroom: HouseRectangle; // 独立卫生间边界。
  bathroomDoor: { minX: number; maxX: number; y: number }; // 卫生间前墙上的门洞。
  entrance: IslandPoint; // 屋内房门的行走目标。
  passageClearance: number; // 门口通道及行走的最小留白。
}

export const houseLayout: HouseLayout = layout;
const { bathroom: room, bathroomDoor: door, wallThickness, entrance, passageClearance } = houseLayout;
const halfWall = wallThickness / 2;

// 门洞保持为空；三段隔墙也供人物寻路使用。
export const houseWalls: readonly HouseRectangle[] = [
  { minX: room.minX - halfWall, maxX: room.minX + halfWall, minY: room.minY, maxY: room.maxY + halfWall },
  { minX: room.minX, maxX: door.minX, minY: door.y - halfWall, maxY: door.y + halfWall },
  { minX: door.maxX, maxX: room.maxX, minY: door.y - halfWall, maxY: door.y + halfWall },
];

// 通道可行走，但不能放家具；门洞前后都需给人物留出位置。
export const housePassages: readonly HouseRectangle[] = [
  { minX: door.minX, maxX: door.maxX, minY: door.y - 0.6, maxY: door.y + 0.6 },
  { minX: entrance.x - passageClearance, maxX: entrance.x + passageClearance, minY: entrance.y - passageClearance, maxY: houseLayout.depth / 2 },
];

// 仅接触边缘不算重叠，与服务端完整占地规则一致。
export function overlapsHouseRectangle(point: IslandPoint, size: IslandPoint, rectangle: HouseRectangle): boolean {
  return point.x + size.x / 2 > rectangle.minX && point.x - size.x / 2 < rectangle.maxX
    && point.y + size.y / 2 > rectangle.minY && point.y - size.y / 2 < rectangle.maxY;
}
