import type { IslandPoint } from './island-types';
import type { TerrainRegion } from './scene-terrain';

// 整体场景独立于昼夜环境、已有物件布局和保存协议。
export interface SceneDefinition {
  key: string; // 场景的稳定身份，供统一渲染入口选择。
  terrain: readonly TerrainRegion[]; // 有限的可查询地形，不包含纯视觉远景。
  shoreline: readonly IslandPoint[]; // 从左到右的海岸，共用于沙滩边界与岸浪。
  grassline: readonly IslandPoint[]; // 草地与沙滩共用的边界。
  camera: {
    center: IslandPoint; // 投影后的构图基准，海边默认对应海岸位置。
    editingCenter: IslandPoint; // 布置时聚焦已有物品活动区，比例不再受岸海构图限制。
    width: number; // 默认取景的参考宽度。
    height: number; // 默认取景的参考高度。
    skyRatio: number; // 天空在可见背景中的占比。
    landRatio: number; // 默认地面视野中岸上的目标占比。
  };
}

// 沿投影的横向、纵深定义地形，落盘后仍使用物品的世界坐标。
function groundPoint(horizontal: number, depth: number): IslandPoint {
  return { x: (horizontal + depth) / 2, y: (depth - horizontal) / 2 };
}

// 岸线纵深随横向缓慢起伏；最大值仍小于 -16，旧室外范围的最远角始终留在岸上。
function shoreDepth(horizontal: number): number {
  return -18 + Math.sin(horizontal * 0.09) * 1.1 + Math.sin(horizontal * 0.23 + 1) * 0.35;
}

// 沙滩宽窄交替，让草坪边缘不与海岸平行；最窄处仍保留清楚的沙带。
function beachWidth(horizontal: number): number {
  return 5 + Math.sin(horizontal * 0.13 + 2) * 1.2;
}

const shoreHorizontals = Array.from({ length: 101 }, (_, index) => -100 + index * 2);

// 海岸用同一条折线绘制和判断地形，起伏留在旧活动范围以外。
export const shoreline: readonly IslandPoint[] = shoreHorizontals.map((horizontal) => groundPoint(horizontal, shoreDepth(horizontal)));

export const grassline: readonly IslandPoint[] = shoreHorizontals.map((horizontal) => groundPoint(horizontal, shoreDepth(horizontal) + beachWidth(horizontal)));

// 可布置范围有限；远处海面可继续绘制，但不会自动成为可用水域。
export const seasideScene: SceneDefinition = {
  key: 'seaside',
  terrain: [
    { kind: 'water', polygon: [groundPoint(-100, -100), groundPoint(100, -100), ...[...shoreline].reverse()] },
    { kind: 'sand', polygon: [...shoreline, ...[...grassline].reverse()] },
    { kind: 'grass', polygon: [...grassline, groundPoint(100, 100), groundPoint(-100, 100)] },
  ],
  shoreline,
  grassline,
  camera: { center: { x: 500, y: 134 }, editingCenter: { x: 500, y: 335 }, width: 820, height: 470, skyRatio: 0.16, landRatio: 0.6 },
};

export const defaultScene = seasideScene;
