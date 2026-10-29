import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import content from '../src/content/zh-CN.json' with { type: 'json' };
import checkin from '../src/features/checkin/content.json' with { type: 'json' };
import achievement from '../src/features/achievements/content.json' with { type: 'json' };
import type { components } from '../src/api/schema';

type Achievement = components['schemas']['Achievement'];
type AchievementInput = components['schemas']['AchievementCreate'];
type Camp = components['schemas']['CampResponse'];
type Task = components['schemas']['Task'];

// 验收准备使用浏览器真实会话，接口仍执行同源、CSRF及管理权限验证。
async function achievementAPI(page: Page, path: string, method = 'GET', data?: unknown) {
  const session = await (await page.request.get('/api/v1/session')).json() as components['schemas']['SessionResponse'];
  const response = await page.request.fetch(`/api/v1${path}`, { method, data, headers: { Origin: 'http://127.0.0.1:15173', 'X-CSRF-Token': session.csrf_token, 'Idempotency-Key': crypto.randomUUID() } });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy();
  return response.status() === 204 ? null : response.json();
}

// 在管理表单配置真实规则，任务范围限定到本测试的实体以避免历史数据干扰。
async function createAchievementInPage(page: Page, name: string, taskName: string, metric: AchievementInput['metric'], badgeKey: string) {
  await page.getByRole('button', { name: achievement.new, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(achievement.name, { exact: true }).fill(name);
  await dialog.getByRole('combobox', { name: achievement.asset, exact: true }).selectOption(badgeKey);
  await dialog.getByRole('radio', { name: achievement.metrics[metric], exact: true }).check();
  await dialog.getByRole('combobox', { name: achievement.scope, exact: true }).selectOption('tasks');
  await dialog.getByRole('checkbox', { name: taskName, exact: true }).check();
  await dialog.getByLabel(achievement.target, { exact: true }).fill('1');
  if (metric === 'count') {
    await dialog.getByRole('checkbox', { name: achievement.unlimited, exact: true }).uncheck();
    await dialog.getByLabel(achievement.windowDays, { exact: true }).fill('7');
  }
  await dialog.getByRole('button', { name: achievement.save, exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

// 从管理配置到真实打卡、佩戴、删除任务保留、删除记录撤回均经过页面与服务。
test('成就管理、按计划完成、佩戴持久化与删除后的资格重算', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const taskName = `成就任务-${suffix}`;
  const countName = `坚持徽章-${suffix}`;
  const streakName = `连续徽章-${suffix}`;
  await page.goto('/');
  await page.getByLabel(content.account.username).fill('island-e2e');
  await page.getByLabel(content.account.loginPassword).fill('Island-Test-2026');
  await page.getByRole('button', { name: content.account.login, exact: true }).click();
  await page.getByRole('button', { name: content.navigation.management, exact: true }).click();
  await page.getByLabel(content.account.managementPassword, { exact: true }).fill('Manage-Test-2026');
  await page.getByRole('button', { name: content.account.unlock, exact: true }).click();
  await expect(page.getByRole('heading', { name: content.account.settingsTitle, exact: true })).toBeVisible();
  const task = await achievementAPI(page, '/management/tasks', 'POST', { category_id: null, name: taskName, icon_key: 'book-v1', coin_reward: 7, diamond_reward: 3, daily_limit: 1, weekdays: [1, 2, 3, 4, 5, 6, 7], enabled: true }) as Task;
  const assets = await achievementAPI(page, '/assets') as { items: components['schemas']['Asset'][] };
  const badge = assets.items.find((item) => item.kind === 'badge');
  expect(badge).toBeDefined();
  await page.getByRole('navigation', { name: content.navigation.management, exact: true }).getByRole('button', { name: achievement.manageTitle, exact: true }).click();
  await createAchievementInPage(page, countName, taskName, 'count', badge!.key);
  await createAchievementInPage(page, streakName, taskName, 'streak', badge!.key);
  const configured = await achievementAPI(page, '/management/achievements') as { items: Achievement[] };
  const mine = configured.items.filter((item) => item.name === countName || item.name === streakName);
  expect(mine).toHaveLength(2);
  expect(mine.every((item) => !item.qualified && !item.equipped)).toBe(true);
  expect(mine.find((item) => item.name === countName)?.window_days).toBe(7);

  await page.getByRole('button', { name: content.account.leaveManagement, exact: true }).click();
  await page.locator('.checkin-task').filter({ hasText: taskName }).click();
  await page.getByRole('dialog').getByRole('button', { name: checkin.checkin, exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: achievement.viewAll, exact: true }).click();
  for (const name of [countName, streakName]) {
    const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
    await expect(card.getByText(achievement.owned, { exact: true })).toBeVisible();
    await card.getByRole('button', { name: achievement.equip, exact: true }).click();
    await expect(card.getByRole('button', { name: achievement.unequip, exact: true })).toBeEnabled();
  }
  await page.getByRole('button', { name: `${achievement.details} ${countName}`, exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('listitem')).toHaveText(taskName);
  await page.getByRole('dialog').getByRole('button', { name: content.common.close, exact: true }).click();
  await page.getByRole('button', { name: content.navigation.camp, exact: true }).click();
  await page.reload();
  const strip = page.getByRole('region', { name: achievement.equippedTitle, exact: true });
  for (const name of [countName, streakName]) {
    const badgeButton = strip.getByRole('button', { name: `${achievement.details} ${name}`, exact: true });
    await expect(badgeButton).toBeVisible();
    expect(await badgeButton.innerText()).toBe('');
    const size = await badgeButton.boundingBox();
    expect(size?.width).toBeGreaterThanOrEqual(56);
    expect(size?.height).toBeGreaterThanOrEqual(56);
  }
  await expect.poll(() => strip.locator('img').evaluateAll((images) => images.every((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await strip.getByRole('button', { name: `${achievement.details} ${countName}`, exact: true }).click();
  await expect(page.getByRole('dialog', { name: countName, exact: true })).toContainText(achievement.earnedAt);
  await expect(page.getByRole('dialog').getByRole('listitem')).toHaveText(taskName);
  await page.getByRole('dialog').getByRole('button', { name: content.common.close, exact: true }).click();

  // 删除任务只结束后续任务安排，已有记录、资格与佩戴仍保留。
  await achievementAPI(page, '/management/unlock', 'POST', { password: 'Manage-Test-2026' });
  await achievementAPI(page, `/management/tasks/${task.id}`, 'DELETE', { expected_version: task.version });
  await page.reload();
  for (const name of [countName, streakName]) await expect(strip.getByRole('button', { name: `${achievement.details} ${name}`, exact: true })).toBeVisible();
  const preserved = (await achievementAPI(page, '/camp') as Camp).achievements;
  expect(mine.every((item) => preserved.some((entry) => entry.id === item.id))).toBe(true);
  await strip.getByRole('button', { name: `${achievement.details} ${countName}`, exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('listitem')).toContainText(taskName);
  await expect(page.getByRole('dialog').getByRole('listitem')).toContainText(achievement.deleted);
  await page.getByRole('dialog').getByRole('button', { name: content.common.close, exact: true }).click();

  // 删除真正的完成记录后，两个指标都不再成立，主页与成就页必须一起更新。
  await page.locator('.checkin-record').filter({ hasText: taskName }).click();
  await page.getByRole('dialog').getByRole('button', { name: checkin.delete, exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: checkin.confirmDelete, exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  for (const name of [countName, streakName]) await expect(strip.getByRole('button', { name: `${achievement.details} ${name}`, exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: achievement.viewAll, exact: true }).click();
  for (const name of [countName, streakName]) {
    const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
    await expect(card.getByText(achievement.unowned, { exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: achievement.equip, exact: true })).toHaveCount(0);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const final = await achievementAPI(page, '/achievements') as { items: Achievement[] };
  expect(final.items.filter((item) => mine.some((entry) => entry.id === item.id)).every((item) => !item.qualified && !item.equipped && item.progress === 0)).toBe(true);
});

// 页面打开后另一次写入引入新类别，冲突恢复必须刷新选项并通过浏览器原生表单校验。
test('成就冲突采用新建类别后仍可保存，普通详情显示类别名称', async ({ page }, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const name = `冲突徽章-${suffix}`;
  const categoryName = `阅读分类-${suffix}`;
  await page.goto('/');
  await page.getByLabel(content.account.username).fill('island-e2e');
  await page.getByLabel(content.account.loginPassword).fill('Island-Test-2026');
  await page.getByRole('button', { name: content.account.login, exact: true }).click();
  await page.getByRole('button', { name: content.navigation.management, exact: true }).click();
  await page.getByLabel(content.account.managementPassword, { exact: true }).fill('Manage-Test-2026');
  await page.getByRole('button', { name: content.account.unlock, exact: true }).click();
  await expect(page.getByRole('heading', { name: content.account.settingsTitle, exact: true })).toBeVisible();
  const input: AchievementInput = { name, asset_key: 'badge-star-v1', metric: 'count', scope: 'all', category_id: null, task_ids: [], target: 10, window_days: null, enabled: true };
  const created = await achievementAPI(page, '/management/achievements', 'POST', input) as Achievement;
  await page.getByRole('navigation', { name: content.navigation.management, exact: true }).getByRole('button', { name: achievement.manageTitle, exact: true }).click();
  await page.getByRole('button', { name: `${achievement.edit} ${name}`, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(achievement.target, { exact: true }).fill('11');
  const category = await achievementAPI(page, '/management/categories', 'POST', { name: categoryName }) as components['schemas']['Category'];
  await achievementAPI(page, `/management/achievements/${created.id}`, 'PATCH', { ...input, scope: 'category', category_id: category.id, expected_version: created.version });
  await dialog.getByRole('button', { name: achievement.save, exact: true }).click();
  await dialog.getByRole('button', { name: achievement.reloadLatest, exact: true }).click();
  await expect(dialog.getByRole('region', { name: achievement.latest })).toContainText(categoryName);
  await dialog.getByRole('button', { name: achievement.useLatest, exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: achievement.category, exact: true })).toHaveValue(category.id);
  await dialog.getByLabel(achievement.target, { exact: true }).fill('12');
  await dialog.getByRole('button', { name: achievement.save, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const result = await achievementAPI(page, '/management/achievements') as { items: Achievement[] };
  expect(result.items.find((item) => item.id === created.id)).toMatchObject({ target: 12, category_id: category.id, version: 3 });
  await page.getByRole('button', { name: content.account.leaveManagement, exact: true }).click();
  await page.getByRole('button', { name: achievement.viewAll, exact: true }).click();
  await page.getByRole('button', { name: `${achievement.details} ${name}`, exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('region', { name: achievement.scope })).toContainText(categoryName);
});
