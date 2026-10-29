import type { ApiClient } from '../../api/client';
import type { Session } from '../../api/types';
import type { components } from '../../api/schema';

export type Achievement = components['schemas']['Achievement'];
export type AchievementInput = components['schemas']['AchievementCreate'];
export type AchievementOptions = components['schemas']['AchievementOptions'];
export type AchievementAsset = components['schemas']['Asset'];
export type AchievementClient = Pick<ApiClient, 'request'>;

// 成就页面共用服务端会话与请求入口。
export interface AchievementProps {
  client: AchievementClient; // 当前会话请求客户端。
  session: Session; // 输入限制与账户配置。
}
