import type { IslandView } from './island-types';

// 浮层占用屏幕边缘的像素，不参与地面坐标与持久布局。
export interface IslandInsets {
  top: number; // 顶部返回与工具栏。
  right: number; // 桌面布置面板。
  bottom: number; // 活动栏或手机抽屉。
  left: number; // 左侧安全空间。
}

// 将岛屿中心放进浮层之外，窄屏允许岸线延伸到屏幕外以保留可读的物件。
export function fitIslandView(width: number, height: number, insets: IslandInsets): IslandView {
  const availableWidth = Math.max(1, width - insets.left - insets.right);
  const availableHeight = Math.max(1, height - insets.top - insets.bottom);
  const zoom = Math.max(0.7, Math.min(1.7, availableWidth / 820, availableHeight / 470));
  return { zoom, x: insets.left + availableWidth / 2 - 500 * zoom, y: insets.top + availableHeight / 2 - 335 * zoom };
}
