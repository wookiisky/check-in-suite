import type { Achievement, AchievementOptions, AchievementAsset } from './types';

// 成就协议夹具仅供组件测试使用。
export const achievementFixture: Achievement = { id: 'achievement-1', name: '阅读小能手', asset_key: 'badge-star-v1', metric: 'count', scope: 'all', category_id: null, task_ids: [], category: null, tasks: [], target: 10, window_days: null, enabled: true, deleted: false, version: 1, progress: 10, qualified: true, equipped: false, earned_at: '2026-10-29T04:00:00Z' };
export const achievementOptions: AchievementOptions = { categories: [{ id: 'reading', name: '阅读', deleted: false }], tasks: [{ id: 'task-1', name: '阅读', category_id: 'reading', deleted: false }, { id: 'deleted-task', name: '旧阅读', category_id: 'reading', deleted: true }, { id: 'deleted-other', name: '已删除的运动', category_id: null, deleted: true }] };
export const badgeAssets: AchievementAsset[] = [{ key: 'badge-star-v1', name: '星星徽章', kind: 'badge', url: '/api/v1/assets/badge-star-v1' }];
