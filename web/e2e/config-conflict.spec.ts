import { expect, test } from '@playwright/test';
import content from '../src/content/zh-CN.json' with { type: 'json' };
import checkin from '../src/features/checkin/content.json' with { type: 'json' };
import type { components } from '../src/api/schema';

// 通过真实服务制造另一设备的修改，验证用户看到最新字段并明确选择后才覆盖。
test('任务编辑冲突展示最新配置，并按明确选择持久化', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByLabel(content.account.username).fill('island-e2e');
  await page.getByLabel(content.account.loginPassword).fill('Island-Test-2026');
  await page.getByRole('button', { name: content.account.login, exact: true }).click();
  await page.getByRole('button', { name: content.navigation.management, exact: true }).click();
  await page.getByLabel(content.account.managementPassword, { exact: true }).fill('Manage-Test-2026');
  await page.getByRole('button', { name: content.account.unlock, exact: true }).click();
  await expect(page.getByRole('heading', { name: content.account.settingsTitle, exact: true })).toBeVisible();
  const session = await (await page.request.get('/api/v1/session')).json() as components['schemas']['SessionResponse'];
  const headers = { Origin: 'http://127.0.0.1:15173', 'X-CSRF-Token': session.csrf_token };
  const draft = {
    name: `冲突任务-${testInfo.project.name}`, category_id: null, icon_key: 'book-v1',
    coin_reward: 2, diamond_reward: 1, daily_limit: 2, weekdays: [1, 2, 3, 4, 5, 6, 7], enabled: true,
  };
  const created = await page.request.post('/api/v1/management/tasks', {
    headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() }, data: draft,
  });
  expect(created.status()).toBe(201);
  const task = await created.json() as components['schemas']['Task'];
  await page.getByRole('button', { name: content.navigation.tasks, exact: true }).click();
  await page.locator('.checkin-config-row').filter({ hasText: draft.name })
    .getByRole('button', { name: checkin.editConfig, exact: true }).click();
  const dialog = page.getByRole('dialog');
  const name = dialog.getByLabel(checkin.name, { exact: true });
  const coins = dialog.getByLabel(checkin.coins, { exact: true });
  await name.fill(`${draft.name}-本地`);
  const updated = await page.request.patch(`/api/v1/management/tasks/${task.id}`, {
    headers, data: { ...draft, coin_reward: 99, expected_version: task.version },
  });
  expect(updated.status()).toBe(200);
  const remote = await updated.json() as components['schemas']['Task'];
  await dialog.getByRole('button', { name: checkin.save, exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText(checkin.errors.VERSION_CONFLICT);
  await dialog.getByRole('button', { name: checkin.confirmLatest, exact: true }).click();
  await expect(dialog.getByRole('region', { name: checkin.latestConfiguration })).toContainText('99');
  await expect(coins).toHaveValue('2');
  await expect(name).toHaveValue(`${draft.name}-本地`);
  await dialog.getByRole('button', { name: checkin.useLatestConfiguration, exact: true }).click();
  await expect(coins).toHaveValue('99');
  await expect(name).toHaveValue(draft.name);
  await name.fill(`${draft.name}-确认覆盖`);
  const changedAgain = await page.request.patch(`/api/v1/management/tasks/${task.id}`, {
    headers, data: { ...draft, coin_reward: 77, expected_version: remote.version },
  });
  expect(changedAgain.status()).toBe(200);
  await dialog.getByRole('button', { name: checkin.save, exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText(checkin.errors.VERSION_CONFLICT);
  await dialog.getByRole('button', { name: checkin.confirmLatest, exact: true }).click();
  await expect(dialog.getByRole('region', { name: checkin.latestConfiguration })).toContainText('77');
  const layout = await dialog.evaluate((element) => ({ width: element.scrollWidth, client: element.clientWidth }));
  expect(layout.width).toBeLessThanOrEqual(layout.client);
  await dialog.getByRole('button', { name: checkin.overwriteConfiguration, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const tasks = await (await page.request.get('/api/v1/tasks?include_inactive=true')).json() as { items: components['schemas']['Task'][] };
  expect(tasks.items.find((item) => item.id === task.id)).toMatchObject({
    name: `${draft.name}-确认覆盖`, coin_reward: 99, version: remote.version + 2,
  });
});
