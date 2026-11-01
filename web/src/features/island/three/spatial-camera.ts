import type { SpatialPoint, SpatialTransform } from '../spatial-geometry';

/** 镜头是本页临时状态，布局只保存厘米坐标。 */
export interface SpatialCameraState {
  x: number; // 用户关注的世界横坐标，米。
  z: number; // 用户关注的世界纵深，米。
  zoom: number; // 相对于全景的倍率。
  direction: number; // 顺时针四向索引。
}
/** HTML 浮层占用的像素范围。 */
export interface SpatialInsets {
  top: number; // 顶部工具栏。
  right: number; // 桌面库存。
  bottom: number; // 手机库存或操作栏。
  left: number; // 今日任务。
}
export type WallSide = 'north'|'south'|'east'|'west';
export const cameraPitch = Math.atan2(12,15);

// 方位与相机坐标、墙面剖切共用，避免旋转后隐藏背墙。
export function cameraBasis(direction: number) {
  const angle=Math.PI/4+direction*Math.PI/2;
  return {right:[Math.cos(angle),-Math.sin(angle)] as const, forward:[Math.sin(angle),Math.cos(angle)] as const};
}

// 四向只剖掉靠近相机的墙，关闭室内查看时完整恢复。
export function hiddenWallSides(direction: number, open: boolean): WallSide[] {
  if (!open) return [];
  const {forward}=cameraBasis(direction);
  return [forward[1]>0?'south':'north',forward[0]>0?'east':'west'];
}

// 屏幕平移换算到地面，不允许把相机拖出场景太远。
export function dragCamera(current: SpatialCameraState, dx: number, dy: number, unitsPerPixel: number): SpatialCameraState {
  const {right,forward}=cameraBasis(current.direction);
  return {...current,x:Math.max(-15,Math.min(15,current.x-dx*unitsPerPixel*right[0]-dy*unitsPerPixel*forward[0]/Math.sin(cameraPitch))),z:Math.max(-15,Math.min(22,current.z-dx*unitsPerPixel*right[1]-dy*unitsPerPixel*forward[1]/Math.sin(cameraPitch)))};
}

// 滚轮、双指和按钮使用同一倍率限制。
export function zoomCamera(current: SpatialCameraState, factor: number): SpatialCameraState {
  return {...current,zoom:Math.min(6,Math.max(0.65,current.zoom*factor))};
}

// 把关注点投影到浮层之外的可见区域中央。
export function cameraTarget(current: SpatialCameraState, insets: SpatialInsets, unitsPerPixel: number): [number,number,number] {
  const {right,forward}=cameraBasis(current.direction);
  const dx=(insets.left-insets.right)*unitsPerPixel/2;
  const dy=(insets.bottom-insets.top)*unitsPerPixel/2/Math.sin(cameraPitch);
  return [current.x-right[0]*dx+forward[0]*dy,0,current.z-right[1]*dx+forward[1]*dy];
}

// 物件四分之一圈对应 Three.js 绕 Y 负向旋转，逆变换产生房屋局部坐标。
export function groundFromWorld(point: {x:number;z:number}, space:'indoor'|'outdoor', house: SpatialTransform): SpatialPoint {
  if (space==='outdoor') return {x_cm:Math.round(point.x*100),z_cm:Math.round(point.z*100)};
  const angle=house.rotation*Math.PI/2, dx=point.x*100-house.x_cm,dz=point.z*100-house.z_cm;
  return {x_cm:Math.round(dx*Math.cos(angle)+dz*Math.sin(angle)),z_cm:Math.round(-dx*Math.sin(angle)+dz*Math.cos(angle))};
}

// 移动体验吸附十厘米网格，持久化仍使用整数厘米。
export function snappedPlacement(point: SpatialPoint): SpatialPoint {
  return {x_cm:Math.round(point.x_cm/10)*10,z_cm:Math.round(point.z_cm/10)*10};
}
