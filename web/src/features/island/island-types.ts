import type { ApiClient } from '../../api/client';
import type { Session } from '../../api/types';

import type { components } from '../../api/schema';

export type IslandDefinition = components['schemas']['IslandDefinition'];
export type IslandPlacement = components['schemas']['IslandPlacement'];
export type IslandState = components['schemas']['IslandState'];
export type IslandZone = IslandPlacement['zone'];
export type IslandActivity = NonNullable<IslandDefinition['activity']>;

// 页面使用应用已有会话，不创建第二份认证状态。
export interface IslandPageProps {
  client: Pick<ApiClient, 'request'> & Partial<Pick<ApiClient, 'now' | 'recordServerTime'>>; // 共享请求入口。
  session: Session; // 当前角色所属账户和动效偏好。
  onCamp?: () => void; // 从打卡快捷入口进入营地主界面。
  onBack?: () => void; // 返回进入小岛前的页面。
  onSettings?: () => void; // 打开共享声音与动效设置。
  onShop?: () => void; // 进入既有商店。
}

// 场景使用固定投影，视图只允许平移和缩放。
export interface IslandView {
  x: number; // 画布横向平移。
  y: number; // 画布纵向平移。
  zoom: number; // 有界缩放倍率。
}

// 地面位置与显示位置使用同一结构，不包含像素单位。
export interface IslandPoint {
  x: number; // 横坐标。
  y: number; // 纵坐标。
}
