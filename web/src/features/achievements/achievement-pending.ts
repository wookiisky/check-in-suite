import type { AchievementClient, AchievementInput } from './types';

// 未知新增结果保留原请求，离开管理页后可继续核对。
export interface AchievementCommand {
  key: string; // 同一次新增始终复用的幂等键。
  body: AchievementInput; // 原始提交内容，不能被后续编辑改变。
}
export const pendingAchievements = new WeakMap<AchievementClient, AchievementCommand>();
