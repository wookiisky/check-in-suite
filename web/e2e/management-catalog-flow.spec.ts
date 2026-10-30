import { expect, test, type Page } from '@playwright/test';
import content from '../src/content/zh-CN.json' with { type: 'json' };
import shop from '../src/features/shop/content.json' with { type: 'json' };
import achievement from '../src/features/achievements/content.json' with { type: 'json' };
import type { components } from '../src/api/schema';

type Product = components['schemas']['Product'];
type Achievement = components['schemas']['Achievement'];
type Camp = components['schemas']['CampResponse'];
type Task = components['schemas']['Task'];
type Category = components['schemas']['Category'];

// 每次进入管理区都通过密码表单，避免接口准备代替页面授权流程。
async function enterManagement(page: Page) {
  await page.getByRole('button', { name: content.navigation.management, exact: true }).click();
  await page.getByLabel(content.account.managementPassword, { exact: true }).fill('Manage-Test-2026');
  await page.getByRole('button', { name: content.account.unlock, exact: true }).click();
  await expect(page.getByRole('heading', { name: content.account.settingsTitle, exact: true })).toBeVisible();
}

// 读取真实服务用于核对结果，写接口仅准备其他流程已覆盖的打卡事实。
async function catalogAPI(page: Page, path: string, method = 'GET', data?: unknown) {
  const session = await (await page.request.get('/api/v1/session')).json() as components['schemas']['SessionResponse'];
  const response = await page.request.fetch(`/api/v1${path}`, {
    method, data,
    headers: { Origin: new URL(page.url()).origin, 'X-CSRF-Token': session.csrf_token, 'Idempotency-Key': crypto.randomUUID() },
  });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy();
  return response.status() === 204 ? null : response.json();
}

// 商品配置全部通过页面完成，普通商店再验证库存和上下架带来的行为。
test('商品管理的素材筛选、草稿、编辑、库存、上下架和删除闭环', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const originalName = `商品-${suffix}`;
  const editedName = `商品改名-${suffix}`;
  await page.goto('/');
  await page.getByLabel(content.account.username).fill('island-e2e');
  await page.getByLabel(content.account.loginPassword).fill('Island-Test-2026');
  await page.getByRole('button', { name: content.account.login, exact: true }).click();
  await enterManagement(page);
  await page.getByRole('navigation', { name: content.navigation.management, exact: true }).getByRole('button', { name: content.navigation.products, exact: true }).click();
  await page.getByRole('button', { name: shop.addProduct, exact: true }).click();
  const dialog = page.getByRole('dialog');
  const assets = await catalogAPI(page, '/assets') as components['schemas']['AssetList'];
  for (const type of ['avatar', 'reward'] as const) {
    await dialog.getByRole('combobox', { name: shop.typeFilter, exact: true }).selectOption(type);
    const offered = await dialog.getByRole('combobox', { name: shop.asset, exact: true }).locator('option').evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value).filter(Boolean));
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.every((key) => assets.items.some((asset) => asset.key === key && asset.kind === type && !asset.free))).toBe(true);
  }
  await dialog.getByLabel(shop.name, { exact: true }).fill(originalName);
  await dialog.getByLabel(shop.description, { exact: true }).fill('商品管理流程的测试描述');
  await dialog.getByRole('button', { name: content.common.close, exact: true }).click();
  await expect(page.getByRole('dialog', { name: shop.discardChanges, exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: shop.keepEditing, exact: true }).click();
  await expect(dialog.getByLabel(shop.name, { exact: true })).toHaveValue(originalName);
  await dialog.getByLabel(shop.name, { exact: true }).fill('   ');
  await dialog.getByRole('button', { name: shop.save, exact: true }).click();
  await expect(dialog.getByRole('alert').first()).toBeVisible();
  await expect(dialog.getByLabel(shop.description, { exact: true })).toHaveValue('商品管理流程的测试描述');
  await dialog.getByLabel(shop.name, { exact: true }).fill(originalName);
  await dialog.getByRole('checkbox', { name: shop.unlimitedStock, exact: true }).uncheck();
  await dialog.getByLabel(shop.finiteStock, { exact: true }).fill('0');
  await dialog.getByRole('button', { name: shop.save, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  let products = await catalogAPI(page, '/products?include_inactive=true') as { items: Product[] };
  const created = products.items.find((item) => item.name === originalName)!;
  expect(created).toMatchObject({ type: 'reward', stock: 0, enabled: true });

  await page.getByRole('button', { name: content.account.leaveManagement, exact: true }).click();
  await page.getByRole('button', { name: content.navigation.shop, exact: true }).click();
  const soldOut = page.getByRole('article').filter({ has: page.getByRole('heading', { name: originalName, exact: true }) });
  await expect(soldOut.getByRole('button', { name: `${shop.buy} ${originalName}`, exact: true })).toBeDisabled();
  await expect(soldOut.getByRole('button')).toHaveAttribute('aria-description', new RegExp(shop.soldOut));

  await enterManagement(page);
  await page.getByRole('navigation', { name: content.navigation.management, exact: true }).getByRole('button', { name: content.navigation.products, exact: true }).click();
  await page.getByRole('button', { name: `${shop.edit} ${originalName}`, exact: true }).click();
  await dialog.getByLabel(shop.name, { exact: true }).fill(editedName);
  await dialog.getByLabel(shop.coinPrice, { exact: true }).fill('2');
  await dialog.getByLabel(shop.diamondPrice, { exact: true }).fill('1');
  await dialog.getByLabel(shop.finiteStock, { exact: true }).fill('3');
  await dialog.getByRole('checkbox', { name: shop.enabled, exact: true }).uncheck();
  await dialog.getByRole('button', { name: shop.save, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  products = await catalogAPI(page, '/products?include_inactive=true') as { items: Product[] };
  expect(products.items.find((item) => item.id === created.id)).toMatchObject({ name: editedName, coin_price: 2, diamond_price: 1, stock: 3, enabled: false });
  await page.getByRole('button', { name: content.account.leaveManagement, exact: true }).click();
  await expect(page.getByRole('heading', { name: shop.title, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: editedName, exact: true })).toHaveCount(0);

  await enterManagement(page);
  await page.getByRole('navigation', { name: content.navigation.management, exact: true }).getByRole('button', { name: content.navigation.products, exact: true }).click();
  await page.getByRole('button', { name: `${shop.edit} ${editedName}`, exact: true }).click();
  await dialog.getByRole('checkbox', { name: shop.enabled, exact: true }).check();
  await dialog.getByRole('button', { name: shop.save, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: content.account.leaveManagement, exact: true }).click();
  await expect(page.getByRole('heading', { name: editedName, exact: true })).toBeVisible();

  await enterManagement(page);
  await page.getByRole('navigation', { name: content.navigation.management, exact: true }).getByRole('button', { name: content.navigation.products, exact: true }).click();
  await page.getByRole('button', { name: `${shop.edit} ${editedName}`, exact: true }).click();
  await dialog.getByLabel(shop.description, { exact: true }).fill('不会保存的修改');
  await dialog.getByRole('button', { name: content.common.close, exact: true }).click();
  await dialog.getByRole('button', { name: shop.discard, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: `${shop.delete} ${editedName}`, exact: true }).click();
  await dialog.getByRole('button', { name: shop.cancel, exact: true }).click();
  await expect(page.getByRole('button', { name: `${shop.edit} ${editedName}`, exact: true })).toBeVisible();
  await page.getByRole('button', { name: `${shop.delete} ${editedName}`, exact: true }).click();
  await dialog.getByRole('button', { name: shop.confirmDelete, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: `${shop.edit} ${editedName}`, exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: content.account.leaveManagement, exact: true }).click();
  await expect(page.getByRole('heading', { name: editedName, exact: true })).toHaveCount(0);
});

// 两个业务日期的独立记录隔离历史数据，管理规则变化必须立即影响普通成就页。
test('成就管理的天数指标、范围窗口、资格重算、启停和删除闭环', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const name = `天数徽章-${suffix}`;
  const categoryName = `徽章类别-${suffix}`;
  const taskName = `徽章任务-${suffix}`;
  await page.goto('/');
  await page.getByLabel(content.account.username).fill('island-e2e');
  await page.getByLabel(content.account.loginPassword).fill('Island-Test-2026');
  await page.getByRole('button', { name: content.account.login, exact: true }).click();
  await enterManagement(page);
  const category = await catalogAPI(page, '/management/categories', 'POST', { name: categoryName, sort_order: 0 }) as Category;
  const task = await catalogAPI(page, '/management/tasks', 'POST', { category_id: category.id, name: taskName, icon_key: 'book-v1', coin_reward: 1, diamond_reward: 0, daily_limit: 1, weekdays: [1, 2, 3, 4, 5, 6, 7], enabled: true }) as Task;
  const camp = await catalogAPI(page, '/camp') as Camp;
  const yesterday = new Date(`${camp.today}T00:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  for (const date of [yesterday.toISOString().slice(0, 10), camp.today]) {
    await catalogAPI(page, '/management/checkins', 'POST', { task_id: task.id, expected_task_version: task.version, business_date: date, text: '', photo_media_id: null, audio_media_id: null });
  }
  await page.getByRole('navigation', { name: content.navigation.management, exact: true }).getByRole('button', { name: content.navigation.achievementManagement, exact: true }).click();
  await page.getByRole('button', { name: achievement.new, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(achievement.name, { exact: true }).fill(name);
  await dialog.getByRole('radio', { name: achievement.metrics.days, exact: true }).check();
  await dialog.getByRole('combobox', { name: achievement.scope, exact: true }).selectOption('tasks');
  await expect(dialog.getByRole('button', { name: achievement.save, exact: true })).toBeDisabled();
  await dialog.getByRole('checkbox', { name: taskName, exact: true }).check();
  await dialog.getByLabel(achievement.target, { exact: true }).fill('0');
  await dialog.getByRole('button', { name: achievement.save, exact: true }).click();
  await expect(dialog.getByLabel(achievement.target, { exact: true })).toBeFocused();
  await dialog.getByLabel(achievement.target, { exact: true }).fill('3');
  await dialog.getByRole('checkbox', { name: achievement.unlimited, exact: true }).uncheck();
  await dialog.getByLabel(achievement.windowDays, { exact: true }).fill('7');
  await dialog.getByRole('button', { name: content.common.close, exact: true }).click();
  await expect(dialog.getByText(achievement.discardQuestion, { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: achievement.keepEditing, exact: true }).click();
  await expect(dialog.getByLabel(achievement.name, { exact: true })).toHaveValue(name);
  await dialog.getByRole('button', { name: achievement.save, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  let configured = await catalogAPI(page, '/management/achievements') as { items: Achievement[] };
  const created = configured.items.find((item) => item.name === name)!;
  expect(created).toMatchObject({ metric: 'days', target: 3, window_days: 7, scope: 'tasks', task_ids: [task.id], progress: 2, qualified: false });

  await page.getByRole('button', { name: `${achievement.edit} ${name}`, exact: true }).click();
  await dialog.getByRole('combobox', { name: achievement.scope, exact: true }).selectOption('category');
  await dialog.getByRole('combobox', { name: achievement.category, exact: true }).selectOption(category.id);
  await dialog.getByLabel(achievement.target, { exact: true }).fill('2');
  await dialog.getByLabel(achievement.windowDays, { exact: true }).fill('2');
  await dialog.getByRole('button', { name: achievement.save, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  configured = await catalogAPI(page, '/management/achievements') as { items: Achievement[] };
  expect(configured.items.find((item) => item.id === created.id)).toMatchObject({ scope: 'category', category_id: category.id, target: 2, window_days: 2, qualified: true, progress: 2 });
  await page.getByRole('button', { name: content.account.leaveManagement, exact: true }).click();
  await page.getByRole('button', { name: content.navigation.achievements, exact: true }).click();
  const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
  await expect(card.getByRole('button', { name: achievement.equip, exact: true })).toBeVisible();

  await enterManagement(page);
  await page.getByRole('navigation', { name: content.navigation.management, exact: true }).getByRole('button', { name: content.navigation.achievementManagement, exact: true }).click();
  await page.getByRole('button', { name: `${achievement.edit} ${name}`, exact: true }).click();
  await dialog.getByRole('checkbox', { name: achievement.enabled, exact: true }).uncheck();
  await dialog.getByRole('button', { name: achievement.save, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const row = page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
  await expect(row.getByText(achievement.disabled, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: content.account.leaveManagement, exact: true }).click();
  await expect(card.getByRole('button', { name: achievement.equip, exact: true })).toBeVisible();

  await enterManagement(page);
  await page.getByRole('navigation', { name: content.navigation.management, exact: true }).getByRole('button', { name: content.navigation.achievementManagement, exact: true }).click();
  await page.getByRole('button', { name: `${achievement.edit} ${name}`, exact: true }).click();
  await dialog.getByRole('checkbox', { name: achievement.enabled, exact: true }).check();
  await dialog.getByLabel(achievement.target, { exact: true }).fill('3');
  await dialog.getByRole('button', { name: achievement.save, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row.getByText(achievement.active, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: content.account.leaveManagement, exact: true }).click();
  await expect(card.getByText(achievement.unowned, { exact: true })).toBeVisible();

  await enterManagement(page);
  await page.getByRole('navigation', { name: content.navigation.management, exact: true }).getByRole('button', { name: content.navigation.achievementManagement, exact: true }).click();
  await page.getByRole('button', { name: `${achievement.edit} ${name}`, exact: true }).click();
  await dialog.getByLabel(achievement.name, { exact: true }).fill(`未保存-${name}`);
  await dialog.getByRole('button', { name: content.common.close, exact: true }).click();
  await dialog.getByRole('button', { name: achievement.discard, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row.getByRole('heading', { name, exact: true })).toBeVisible();
  await page.getByRole('button', { name: `${achievement.delete} ${name}`, exact: true }).click();
  await dialog.getByRole('button', { name: achievement.cancel, exact: true }).click();
  await expect(row).toBeVisible();
  await page.getByRole('button', { name: `${achievement.delete} ${name}`, exact: true }).click();
  await dialog.getByRole('button', { name: achievement.confirmDelete, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await page.getByRole('button', { name: content.account.leaveManagement, exact: true }).click();
  await expect(card).toHaveCount(0);
});
