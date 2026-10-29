import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import content from '../src/content/zh-CN.json' with { type: 'json' };
import checkin from '../src/features/checkin/content.json' with { type: 'json' };
import island from '../src/features/island/content.json' with { type: 'json' };
import type { components } from '../src/api/schema';

type Task = components['schemas']['Task'];
type IslandState = components['schemas']['IslandState'];
type Records = components['schemas']['CheckinList'];

// 准备与清理复用真实浏览器会话，写入仍经过同源、CSRF和版本校验。
async function api<T>(page: Page, path: string, method = 'GET', data?: unknown): Promise<T> {
  const session = await (await page.request.get('/api/v1/session')).json() as components['schemas']['SessionResponse'];
  const response = await page.request.fetch(`/api/v1${path}`, {
    method, data,
    headers: { Origin: 'http://127.0.0.1:15173', 'X-CSRF-Token': session.csrf_token, 'Idempotency-Key': crypto.randomUUID() },
  });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy();
  return response.status() === 204 ? undefined as T : response.json() as Promise<T>;
}

// 解锁条件由真实数据库提供，打卡、导航和活动均经过正式页面完成。
test('关联任务打卡解锁活动，删除打卡后返回小岛重新锁定', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const taskName = `小岛活动解锁-${testInfo.project.name}`;
  let task: Task | null = null;
  await page.goto('/');
  await page.getByLabel(content.account.username).fill('island-e2e');
  await page.getByLabel(content.account.loginPassword).fill('Island-Test-2026');
  await page.getByRole('button', { name: content.account.login, exact: true }).click();
  await expect(page.getByRole('heading', { name: checkin.todayTasks, exact: true })).toBeVisible();

  try {
    await page.getByRole('button', { name: content.navigation.management, exact: true }).click();
    await page.getByLabel(content.account.managementPassword, { exact: true }).fill('Manage-Test-2026');
    await page.getByRole('button', { name: content.account.unlock, exact: true }).click();
    await expect(page.getByRole('heading', { name: content.account.settingsTitle, exact: true })).toBeVisible();
    task = await api<Task>(page, '/management/tasks', 'POST', {
      category_id: null, name: taskName, icon_key: 'book-v1', coin_reward: 0, diamond_reward: 0,
      daily_limit: 1, weekdays: [1, 2, 3, 4, 5, 6, 7], enabled: true, unlock_activities: ['run'],
    });
    await page.getByRole('button', { name: content.navigation.tasks, exact: true }).click();
    await page.locator('.checkin-config-row').filter({ hasText: taskName }).getByRole('button', { name: checkin.editConfig, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('checkbox', { name: checkin.activityLabels.run, exact: true })).toBeChecked();
    await dialog.getByRole('checkbox', { name: checkin.activityLabels.run, exact: true }).scrollIntoViewIfNeeded();
    await mkdir('.local/previews', { recursive: true });
    await page.screenshot({ path: `.local/previews/island-unlock-config-${testInfo.project.name}.png` });
    await dialog.getByRole('button', { name: content.common.close, exact: true }).click();
    await page.getByRole('button', { name: content.account.leaveManagement, exact: true }).click();

    const initial = await api<IslandState>(page, '/island');
    const run = initial.catalog.find((entry) => entry.activity === 'run')!;
    const activityLabel = `${island.activities.run} ${run.name}`;
    const lockedLabel = `${activityLabel}，${island.activityLocked}`;
    expect(initial.activity_access.find((entry) => entry.activity === 'run')).toMatchObject({ available: false, tasks: [{ id: task.id }] });
    await page.getByRole('button', { name: content.navigation.island, exact: true }).click();
    const scene = page.getByRole('group', { name: island.scene, exact: true });
    const activities = page.getByRole('region', { name: island.activitiesTitle, exact: true });
    await activities.getByRole('button', { name: lockedLabel, exact: true }).click();
    const lockedNotice = page.getByRole('region', { name: island.activityLocked, exact: true });
    await expect(lockedNotice).toContainText(taskName);
    await expect(lockedNotice).toContainText(island.activityUnlockHint);
    await expect(scene.locator('[data-actor-zone]')).not.toHaveAttribute('data-actor-action', 'run');
    await page.screenshot({ path: `.local/previews/island-unlock-locked-${testInfo.project.name}.png` });

    await lockedNotice.getByRole('button', { name: island.goCheckin, exact: true }).click();
    await page.locator('.checkin-task').filter({ hasText: taskName }).click();
    await page.getByRole('dialog').getByRole('button', { name: checkin.checkin, exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const recordsPath = `/checkins?start_date=${initial.today}&end_date=${initial.today}`;
    const records = (await api<Records>(page, recordsPath)).items.filter((entry) => entry.task_id === task!.id);
    expect(records).toHaveLength(1);
    // 达到每日上限的项目已从营地候选列表移除，解锁仍须依据有效记录。
    await expect(page.locator('.checkin-task').filter({ hasText: taskName })).toHaveCount(0);
    await page.getByRole('button', { name: content.navigation.island, exact: true }).click();
    await activities.getByRole('button', { name: activityLabel, exact: true }).click();
    await expect(scene.locator('[data-actor-zone]')).toHaveAttribute('data-actor-action', 'run', { timeout: 20_000 });

    await api(page, `/checkins/${records[0]!.id}`, 'DELETE', { expected_version: records[0]!.version });
    // 通过实际返回、重新进入读取资格，不以DOM事件代替用户导航。
    await page.getByRole('button', { name: island.back, exact: true }).click();
    await page.getByRole('button', { name: content.navigation.island, exact: true }).click();
    await activities.getByRole('button', { name: lockedLabel, exact: true }).click();
    await expect(lockedNotice).toContainText(taskName);
    await expect(scene.locator('[data-actor-zone]')).not.toHaveAttribute('data-actor-action', 'run');
    expect((await api<IslandState>(page, '/island')).activity_access.find((entry) => entry.activity === 'run')?.available).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    if (task) {
      // 页面退出管理会锁定授权；清理时重新解锁，防止关联残留影响其他用例。
      await api(page, '/management/unlock', 'POST', { password: 'Manage-Test-2026' });
      const tasks = await api<{ items: Task[] }>(page, '/tasks?include_inactive=true');
      const current = tasks.items.find((entry) => entry.id === task!.id);
      if (current) await api(page, `/management/tasks/${current.id}`, 'DELETE', { expected_version: current.version });
    }
  }
});
