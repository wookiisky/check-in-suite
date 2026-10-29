import type { Checkin, Task, Camp } from './types';
import { testSession } from '../../test/account-fixtures';

/** 测试任务不进入正式应用初始化。 */
export const taskFixture: Task = { id: 'task-1', category_id: null, name: '阅读', icon_key: 'book-v1', coin_reward: 2, diamond_reward: 1, daily_limit: 2, weekdays: [1, 2, 3, 4, 5, 6, 7], enabled: true, unlock_activities: [], version: 1, remaining: 2 };

/** 测试记录验证原始奖励快照及今日编辑权限。 */
export const recordFixture: Checkin = { id: 'record-1', deleted: false, can_edit: true, can_delete: true, task_id: taskFixture.id, business_date: '2026-10-29', task_name_snapshot: taskFixture.name, task_icon_snapshot: 'book-v1', coin_reward_snapshot: 2, diamond_reward_snapshot: 1, text: '原始文字', photo_media_id: null, audio_media_id: null, source: 'today', version: 1, created_at: '2026-10-29T04:00:00Z', updated_at: '2026-10-29T04:00:00Z' };

/** 测试营地包含今日可用任务及零余额。 */
export const campFixture: Camp = { today: '2026-10-29', server_now: '2026-10-29T04:00:00Z', timezone: 'Asia/Taipei', tasks: [{ ...taskFixture, remaining: 2 }], categories: [], has_scheduled_tasks: true, wallet: { coins: 0, diamonds: 0, version: 1 }, account: testSession.account, equipment: { title: null, avatar: null, background: null, accessories: [], accessory_layouts: {}, effects: [] }, achievements: [] };
