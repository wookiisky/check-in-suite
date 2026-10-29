import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import content from '../src/content/zh-CN.json' with { type: 'json' };
import checkin from '../src/features/checkin/content.json' with { type: 'json' };
import type { components } from '../src/api/schema';

type Camp = components['schemas']['CampResponse'];
type Records = components['schemas']['CheckinList'];

// 使用浏览器会话的真实Cookie检查持久结果，写请求仍携带CSRF与同源来源。
async function sessionAPI(page: Page, path: string, method = 'GET', data?: unknown) {
  const sessionResponse = await page.request.get('/api/v1/session');
  const session = await sessionResponse.json() as components['schemas']['SessionResponse'];
  return page.request.fetch(`/api/v1${path}`, { method, data, headers: { Origin: 'http://127.0.0.1:15173', 'X-CSRF-Token': session.csrf_token, 'Idempotency-Key': crypto.randomUUID() } });
}

// 每个浏览器项目使用不同实体名，生产初始化保持没有示例数据。
test('真实打卡、编辑删除、响应丢失恢复和历史补录闭环', async ({ page }, testInfo) => {
  const taskName = `阅读-${testInfo.project.name}`;
  const categoryName = `成长-${testInfo.project.name}`;
  await page.goto('/');
  await page.getByLabel(content.account.username).fill('island-e2e');
  await page.getByLabel(content.account.loginPassword).fill('Island-Test-2026');
  await page.getByRole('button', { name: content.account.login, exact: true }).click();
  await expect(page.getByRole('heading', { name: checkin.todayTasks, exact: true })).toBeVisible();

  const enterManagement = async () => {
    await page.getByRole('button', { name: content.navigation.management, exact: true }).click();
    await page.getByLabel(content.account.managementPassword, { exact: true }).fill('Manage-Test-2026');
    await page.getByRole('button', { name: content.account.unlock, exact: true }).click();
    await expect(page.getByRole('heading', { name: content.account.settingsTitle, exact: true })).toBeVisible();
  };
  await enterManagement();
  await page.getByRole('button', { name: content.navigation.tasks, exact: true }).click();
  await page.getByRole('button', { name: checkin.newCategory, exact: true }).click();
  await page.getByRole('dialog').getByLabel(checkin.name, { exact: true }).fill(categoryName);
  await page.getByRole('dialog').getByRole('button', { name: checkin.save, exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: checkin.newTask, exact: true }).click();
  const taskDialog = page.getByRole('dialog');
  await taskDialog.getByLabel(checkin.name, { exact: true }).fill(taskName);
  await taskDialog.getByRole('combobox', { name: checkin.category, exact: true }).selectOption({ label: categoryName });
  await taskDialog.getByRole('combobox', { name: checkin.icon, exact: true }).selectOption('book-v1');
  await taskDialog.getByLabel(checkin.coins, { exact: true }).fill('7');
  await taskDialog.getByLabel(checkin.diamonds, { exact: true }).fill('3');
  await taskDialog.getByLabel(checkin.dailyLimit, { exact: true }).fill('2');
  await taskDialog.getByRole('button', { name: checkin.save, exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: content.account.leaveManagement, exact: true }).click();
  await expect(page.locator('.checkin-task').filter({ hasText: taskName })).toBeVisible();
  const initialCamp = await (await page.request.get('/api/v1/camp')).json() as Camp;
  const task = initialCamp.tasks.find((item) => item.name === taskName)!;
  const records = async () => (await (await page.request.get(`/api/v1/checkins?start_date=${initialCamp.today}&end_date=${initialCamp.today}`)).json() as Records).items.filter((item) => item.task_id === task.id);

  await page.locator('.checkin-task').filter({ hasText: taskName }).click();
  await page.getByRole('dialog').getByRole('button', { name: checkin.checkin, exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(async () => (await records()).length).toBe(1);
  const afterGrant = await (await page.request.get('/api/v1/camp')).json() as Camp;
  expect(afterGrant.wallet.coins).toBe(initialCamp.wallet.coins + 7);
  expect(afterGrant.wallet.diamonds).toBe(initialCamp.wallet.diamonds + 3);
  await page.locator('.checkin-record').filter({ hasText: taskName }).click();
  await expect(page.getByRole('dialog')).not.toContainText(checkin.coins);
  await page.getByRole('dialog').getByRole('button', { name: checkin.edit, exact: true }).click();
  await page.getByRole('dialog').getByLabel(checkin.text).fill('更新内容，不再发奖');
  await page.getByRole('dialog').getByRole('button', { name: checkin.save, exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await (await page.request.get('/api/v1/camp')).json() as Camp).wallet).toEqual(afterGrant.wallet);
  await page.locator('.checkin-record').filter({ hasText: taskName }).click();
  await page.getByRole('dialog').getByRole('button', { name: checkin.delete, exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('img', { name: checkin.coins })).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('img', { name: checkin.diamonds })).toBeVisible();
  await expect(page.getByRole('dialog').getByText('−7', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog').getByText('−3', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).not.toContainText(/金币|钻石/);
  await page.getByRole('dialog').getByRole('button', { name: checkin.confirmDelete, exact: true }).click();
  await expect.poll(async () => (await records()).length).toBe(0);

  // 先让真实服务提交，再中断响应；核对必须沿用同一个请求键。
  let dropped = false;
  const keys: string[] = [];
  await page.route('**/api/v1/checkins', async (route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    keys.push(route.request().headers()['idempotency-key'] ?? '');
    if (!dropped) { dropped = true; await route.fetch(); await route.abort('failed'); }
    else await route.continue();
  });
  await page.locator('.checkin-task').filter({ hasText: taskName }).click();
  await page.getByRole('dialog').getByLabel(checkin.text).fill('第一次提交');
  await page.getByRole('dialog').getByRole('button', { name: checkin.checkin, exact: true }).click();
  await expect(page.getByRole('dialog').getByText(checkin.unknownResult)).toBeVisible();
  await page.getByRole('dialog').getByLabel(checkin.text).fill('核对后保存的新内容');
  await page.getByRole('dialog').getByRole('button', { name: checkin.close, exact: true }).click();
  await page.getByRole('button', { name: checkin.recover, exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: checkin.recover, exact: true }).click();
  await expect(page.getByRole('dialog').getByText(checkin.resolvedEdit)).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: checkin.save, exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect((await records()).map((item) => item.text)).toEqual(['核对后保存的新内容']);
  await page.unroute('**/api/v1/checkins');

  await enterManagement();
  await page.getByRole('button', { name: content.navigation.records, exact: true }).click();
  const yesterday = new Date(`${initialCamp.today}T00:00:00Z`); yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const businessDate = yesterday.toISOString().slice(0, 10);
  await page.getByLabel(checkin.date, { exact: true }).fill(businessDate);
  await page.getByRole('combobox', { name: checkin.chooseTask, exact: true }).selectOption(task.id);
  await page.getByRole('button', { name: checkin.backfillNew, exact: true }).click();
  await page.getByRole('dialog').getByLabel(checkin.text).fill('昨天补录');
  await page.getByRole('dialog').getByRole('button', { name: checkin.checkin, exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const history = await (await page.request.get(`/api/v1/checkins?start_date=${businessDate}&end_date=${businessDate}`)).json() as Records;
  expect(history.items.filter((item) => item.task_id === task.id)).toMatchObject([{ source: 'backfill', text: '昨天补录', can_edit: false }]);
  const tomorrow = new Date(`${initialCamp.today}T00:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const future = await sessionAPI(page, '/management/checkins', 'POST', { task_id: task.id, expected_task_version: task.version, business_date: tomorrow.toISOString().slice(0, 10), text: '', photo_media_id: null, audio_media_id: null });
  expect(future.status()).toBe(422);

  // 关闭后隐藏入口、保留记录与余额；重新开启仍沿用同一个任务身份。
  const beforeDisable = await (await page.request.get('/api/v1/camp')).json() as Camp;
  await page.getByRole('button', { name: content.navigation.tasks, exact: true }).click();
  const disable = page.getByRole('button', { name: `${checkin.disableTask} ${taskName}`, exact: true });
  await disable.focus();
  await disable.press('Enter');
  await expect(page.getByText(checkin.taskDisabled, { exact: true })).toBeVisible();
  await expect(page.locator('.checkin-config-row').filter({ hasText: taskName })).toHaveCount(0);
  await expect(page.getByLabel(checkin.showDisabledTasks, { exact: true })).toBeFocused();
  const disabledCamp = await (await page.request.get('/api/v1/camp')).json() as Camp;
  expect(disabledCamp.tasks.some((item) => item.id === task.id)).toBe(false);
  expect(disabledCamp.wallet).toEqual(beforeDisable.wallet);
  expect((await records()).map((item) => item.text)).toEqual(['核对后保存的新内容']);
  await page.getByLabel(checkin.showDisabledTasks, { exact: true }).check();
  await page.getByRole('button', { name: `${checkin.enableTask} ${taskName}`, exact: true }).click();
  await expect(page.getByText(checkin.taskEnabled, { exact: true })).toBeVisible();
  await page.getByLabel(checkin.showDisabledTasks, { exact: true }).uncheck();
  await expect(page.getByRole('button', { name: `${checkin.disableTask} ${taskName}`, exact: true })).toBeVisible();
  const enabledCamp = await (await page.request.get('/api/v1/camp')).json() as Camp;
  expect(enabledCamp.tasks.find((item) => item.id === task.id)).toMatchObject({ enabled: true, version: task.version + 2 });
  expect(enabledCamp.wallet).toEqual(beforeDisable.wallet);
  await page.getByRole('button', { name: content.account.leaveManagement, exact: true }).click();
  await expect(page.getByRole('heading', { name: checkin.todayTasks, exact: true })).toBeVisible();
  const layout = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: window.innerWidth, controls: [...document.querySelectorAll('main button,main select')].map((element) => ({ tag: element.tagName, height: element.getBoundingClientRect().height, width: element.getBoundingClientRect().width })) }));
  expect(layout.width).toBeLessThanOrEqual(layout.viewport);
  for (const control of layout.controls) { expect(control.height, control.tag).toBeGreaterThanOrEqual(56); expect(control.width, control.tag).toBeGreaterThanOrEqual(56); }
  if (process.env.ISLAND_CAPTURE_PREVIEWS) await page.screenshot({ path: `.local/previews/camp-${testInfo.project.name}.png`, fullPage: true });
});
