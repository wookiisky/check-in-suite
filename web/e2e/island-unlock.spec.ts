import { expect, test } from '@playwright/test';
import type { components } from '../src/api/schema';
import content from '../src/content/zh-CN.json' with { type: 'json' };
import checkin from '../src/features/checkin/content.json' with { type: 'json' };
import spatial from '../src/features/island/three/spatial-content.json' with { type: 'json' };
import { loginMain, shopAPI } from './shop-navigation';

type Task = components['schemas']['Task'];
type Checkin = components['schemas']['Checkin'];
type Access = components['schemas']['IslandActivityAccessState'];

// 任务资格与布局分开读取；真实打卡、撤销及用户导航共同决定活动是否开放。
test('任务关联运动经真实打卡解锁，撤销后重新进入营地恢复锁定', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await loginMain(page);
  let task: Task | null = null;
  let record: Checkin | null = null;
  try {
    await shopAPI(page, '/management/unlock', 'POST', { password: 'Manage-Test-2026' });
    task = await shopAPI<Task>(page, '/management/tasks', 'POST', { category_id: null, name: `三维活动解锁-${testInfo.project.name}`, icon_key: 'book-v1', coin_reward: 0, diamond_reward: 0, daily_limit: 1, weekdays: [1, 2, 3, 4, 5, 6, 7], enabled: true, unlock_activities: ['run'] });
    await shopAPI(page, '/management/lock', 'POST');
    const initial = await shopAPI<Access>(page, '/island/activity-access');
    expect(initial.activity_access.find((item) => item.activity === 'run')).toMatchObject({ available: false, tasks: [{ id: task.id }] });
    await page.getByRole('button', { name: content.navigation.island, exact: true }).click();
    const stage = page.getByRole('region', { name: spatial.scene, exact: true });
    await page.getByRole('button', { name: spatial.activities.run, exact: true }).click();
    const locked = page.getByRole('dialog', { name: spatial.lockedTitle, exact: true });
    await expect(locked).toContainText(task.name);
    await locked.getByRole('button', { name: spatial.goCamp, exact: true }).click();
    await page.locator('.checkin-task').filter({ hasText: task.name }).click();
    await page.getByRole('dialog').getByRole('button', { name: checkin.checkin, exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const records = await shopAPI<components['schemas']['CheckinList']>(page, `/checkins?start_date=${initial.today}&end_date=${initial.today}`);
    record = records.items.find((item) => item.task_id === task!.id)!;
    expect(record).toBeDefined();
    expect((await shopAPI<Access>(page, '/island/activity-access')).activity_access.find((item) => item.activity === 'run')?.available).toBe(true);
    await page.getByRole('button', { name: content.navigation.island, exact: true }).click();
    await page.getByRole('button', { name: spatial.activities.run, exact: true }).click();
    await expect(stage).toHaveAttribute('data-actor-phase', 'performing', { timeout: 40_000 });
    await expect(page.getByText(`${spatial.activities.run} · ${spatial.phases.performing}`, { exact: true })).toBeVisible();
    await shopAPI(page, `/checkins/${record.id}`, 'DELETE', { expected_version: record.version });
    record = null;
    await page.getByRole('button', { name: spatial.back, exact: true }).click();
    await page.getByRole('button', { name: content.navigation.island, exact: true }).click();
    await page.getByRole('button', { name: spatial.activities.run, exact: true }).click();
    await expect(locked).toContainText(task.name);
    expect((await shopAPI<Access>(page, '/island/activity-access')).activity_access.find((item) => item.activity === 'run')?.available).toBe(false);
  } finally {
    await shopAPI(page, '/management/unlock', 'POST', { password: 'Manage-Test-2026' });
    if (record) await shopAPI(page, `/checkins/${record.id}`, 'DELETE', { expected_version: record.version });
    if (task) await shopAPI(page, `/management/tasks/${task.id}`, 'DELETE', { expected_version: task.version });
    await shopAPI(page, '/management/lock', 'POST');
  }
});
