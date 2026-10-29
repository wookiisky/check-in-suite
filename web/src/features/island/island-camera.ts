import type { IslandView } from './island-types';
import { defaultScene } from './scene-definitions';
import type { SceneDefinition } from './scene-definitions';
import { minimumIslandZoom } from './island-geometry';

// 浮层占用屏幕边缘的像素，不参与地面坐标与持久布局。
export interface IslandInsets {
  top: number; // 顶部返回与工具栏。
  right: number; // 桌面布置面板。
  bottom: number; // 活动栏或手机抽屉。
  left: number; // 左侧安全空间。
}

// 默认构图按岸海比例放置场景基准，编辑面板展开后仍使用剩余空间。
export function fitIslandView(width: number, height: number, insets: IslandInsets, camera: SceneDefinition['camera'] = defaultScene.camera): IslandView {
  const availableWidth = Math.max(1, width - insets.left - insets.right);
  const top = Math.max(insets.top, height * camera.skyRatio);
  const availableHeight = Math.max(1, height - top - insets.bottom);
  const zoom = Math.max(minimumIslandZoom, Math.min(1.7, availableWidth / camera.width, availableHeight / camera.height));
  return { zoom, x: insets.left + availableWidth / 2 - camera.center.x * zoom, y: top + availableHeight * (1 - camera.landRatio) - camera.center.y * zoom };
}
