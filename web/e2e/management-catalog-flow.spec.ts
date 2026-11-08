import { expect, test, type Page } from '@playwright/test';
import content from '../src/content/zh-CN.json' with { type: 'json' };
import shop from '../src/features/shop/content.json' with { type: 'json' };
import achievement from '../src/features/achievements/content.json' with { type: 'json' };
import character from '../src/features/character/character-panel-content.json' with { type: 'json' };
import type { components } from '../src/api/schema';
import { closeConfigurationSettings } from './configuration-navigation';

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
  await expect(page.getByRole('tab', { name: content.navigation.account, exact: true })).toBeVisible();
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

// 在完整目录中搜索本用例的报价，使库存和上下架验证覆盖分页后的条目。
async function searchCatalogProduct(page: Page, name: string) {
  await page.getByLabel(shop.searchLabel, { exact: true }).fill(name);
  await page.getByRole('button', { name: shop.search, exact: true }).click();
}

// 装扮报价由正式目录提供，在商品库直接修改并保留原素材绑定。
test('装扮素材只读，目录商品的报价可编辑', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByLabel(content.account.username).fill('island-e2e');
  await page.getByLabel(content.account.loginPassword).fill('Island-Test-2026');
  await page.getByRole('button', { name: content.account.login, exact: true }).click();
  await enterManagement(page);
  await page.getByRole('tablist', { name: content.navigation.management, exact: true })
    .getByRole('tab', { name: content.navigation.products, exact: true }).click();

  const materialTab = page.getByRole('tab', { name: shop.materialLibrary, exact: true });
  const productTab = page.getByRole('tab', { name: shop.productLibrary, exact: true });
  await expect(page.getByRole('button', { name: shop.addProduct, exact: true })).toHaveCount(0);
  await materialTab.click();
  await expect(page.getByText(shop.appearanceMaterialHint, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: new RegExp(`^${shop.addProduct}`) })).toHaveCount(0);
  await productTab.click();

  const original = (await catalogAPI(page, '/products?include_inactive=true&group=appearance') as { items: Product[] })
    .items.find((item) => item.type === 'wearable');
  expect(original).toBeDefined();
  if (!original) return;
  const editedName = `目录装扮-${testInfo.project.name}`;
  try {
    await searchCatalogProduct(page, original.name);
    await page.getByRole('button', { name: `${shop.edit} ${original.name}`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: shop.editProduct });
    await expect(dialog.getByRole('img', { name: shop.asset })).toHaveAttribute('src', `/api/v1/assets/${original.asset_key}`);
    await dialog.getByLabel(shop.name, { exact: true }).fill(editedName);
    await dialog.getByLabel(shop.coinPrice, { exact: true }).fill('19');
    await dialog.getByRole('button', { name: shop.save, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const result = await catalogAPI(page, `/products?include_inactive=true&group=appearance&search=${encodeURIComponent(editedName)}`) as { items: Product[] };
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: original.id, name: editedName, coin_price: 19, wearable_key: original.wearable_key, asset_key: original.asset_key,
    });
  } finally {
    const result = await catalogAPI(page, `/products?include_inactive=true&group=appearance&search=${encodeURIComponent(editedName)}`) as { items: Product[] };
    const updated = result.items.find(({ id }) => id === original.id);
    if (updated) await catalogAPI(page, `/management/products/${original.id}`, 'PATCH', {
      name: original.name, coin_price: original.coin_price, diamond_price: original.diamond_price,
      stock: original.stock, enabled: original.enabled, expected_version: updated.version,
    });
    await catalogAPI(page, '/management/lock', 'POST');
  }
});

// 真实浏览器从素材库建立营地商品绑定并验证报价可以改动而素材保持原样。
test('商品素材绑定、草稿、库存和上下架闭环', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const originalName = `商品-${suffix}`;
  const editedName = `商品改名-${suffix}`;
  const assetKey = 'forest-courtyard-v1-thumbnail';
  await page.goto('/');
  await page.getByLabel(content.account.username).fill('island-e2e');
  await page.getByLabel(content.account.loginPassword).fill('Island-Test-2026');
  await page.getByRole('button', { name: content.account.login, exact: true }).click();
  await enterManagement(page);
  const management = page.getByRole('tablist', { name: content.navigation.management, exact: true });
  await management.getByRole('tab', { name: content.navigation.products, exact: true }).click();

  const materialTab = page.getByRole('tab', { name: shop.materialLibrary, exact: true });
  const productTab = page.getByRole('tab', { name: shop.productLibrary, exact: true });
  const group = page.getByRole('tablist', { name: shop.categoryGroupLabel, exact: true });
  const campCategory = page.getByRole('tablist', { name: shop.campCategoryLabel, exact: true });
  await group.getByRole('tab', { name: shop.shopCamp, exact: true }).click();
  await page.getByRole('button', { name: shop.addProduct, exact: true }).click();
  await expect(materialTab).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: shop.materialActivities, exact: true }).click();
  const reading = page.getByRole('table').getByRole('row').filter({ hasText: 'activity-reading-book-v1' }).first();
  await expect(reading.getByRole('cell', { name: '阅读', exact: true })).toBeVisible();
  await page.getByRole('tablist', { name: shop.materialGroupLabel, exact: true }).getByRole('tab', { name: shop.shopCamp, exact: true }).click();
  await campCategory.getByRole('tab', { name: shop.campCategories.scene, exact: true }).click();

  const assets = await catalogAPI(page, '/assets') as components['schemas']['AssetList'];
  const scene = assets.items.find((asset) => asset.key === assetKey)!;
  const addScene = page.getByRole('button', { name: `${shop.addProduct} ${scene.name}`, exact: true });
  const material = page.locator('.shop-material-card').filter({ has: addScene });
  const thumbnail = material.locator(`img[src$="/${assetKey}"]`);
  await thumbnail.scrollIntoViewIfNeeded();
  await expect.poll(() => thumbnail.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await addScene.click();

  const dialog = page.getByRole('dialog');
  const name = dialog.getByLabel(shop.name, { exact: true });
  await name.fill(originalName);
  await dialog.getByRole('button', { name: content.common.close, exact: true }).click();
  await expect(page.getByRole('dialog', { name: shop.discardChanges, exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: shop.keepEditing, exact: true }).click();
  await expect(name).toHaveValue(originalName);
  await name.fill('   ');
  await dialog.getByRole('button', { name: shop.save, exact: true }).click();
  await expect(dialog.getByRole('alert').first()).toBeVisible();
  await name.fill(originalName);
  await dialog.getByRole('checkbox', { name: shop.unlimitedStock, exact: true }).uncheck();
  await dialog.getByLabel(shop.finiteStock, { exact: true }).fill('0');
  await dialog.getByRole('button', { name: shop.save, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(productTab).toHaveAttribute('aria-selected', 'true');
  await expect(campCategory.getByRole('tab', { name: shop.campCategories.scene, exact: true })).toHaveAttribute('aria-selected', 'true');

  const readProduct = async (query: string) => {
    const products = await catalogAPI(page, `/products?include_inactive=true&group=camp&category=scene&search=${encodeURIComponent(query)}`) as { items: Product[] };
    return products.items.find((item) => item.name === query);
  };
  try {
    const created = await readProduct(originalName);
    expect(created).toMatchObject({ type: 'scene', asset_key: assetKey, stock: 0, enabled: true });

    await searchCatalogProduct(page, originalName);
    const edit = page.getByRole('button', { name: `${shop.edit} ${originalName}`, exact: true });
    const product = page.locator('.shop-management-card').filter({ has: edit });
    await expect(product.locator(`img[src$="/${assetKey}"]`)).toBeVisible();
    await expect(product.getByRole('button', { name: /^删除/ })).toHaveCount(0);
    await edit.click();
    await expect(dialog.getByRole('combobox')).toHaveCount(0);
    await name.fill(editedName);
    await dialog.getByLabel(shop.coinPrice, { exact: true }).fill('2');
    await dialog.getByLabel(shop.diamondPrice, { exact: true }).fill('1');
    await dialog.getByLabel(shop.finiteStock, { exact: true }).fill('3');
    await dialog.getByRole('checkbox', { name: shop.enabled, exact: true }).uncheck();
    await dialog.getByRole('button', { name: shop.save, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(await readProduct(editedName)).toMatchObject({
      id: created!.id, type: 'scene', scene_key: created!.scene_key, asset_key: assetKey,
      name: editedName, coin_price: 2, diamond_price: 1, stock: 3, enabled: false,
    });

    await closeConfigurationSettings(page, 'shop');
    await expect(page.getByRole('tablist', { name: shop.categoryGroupLabel, exact: true })).toBeVisible();
    const visible = await catalogAPI(page, '/shop/products?group=camp&category=scene') as { items: Product[] };
    expect(visible.items.some((item) => item.id === created!.id)).toBe(false);
    await enterManagement(page);
    await management.getByRole('tab', { name: content.navigation.products, exact: true }).click();
    await group.getByRole('tab', { name: shop.shopCamp, exact: true }).click();
    await campCategory.getByRole('tab', { name: shop.campCategories.scene, exact: true }).click();
    await searchCatalogProduct(page, editedName);
    await page.getByRole('button', { name: `${shop.edit} ${editedName}`, exact: true }).click();
    await dialog.getByRole('checkbox', { name: shop.enabled, exact: true }).check();
    await dialog.getByRole('button', { name: shop.save, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(await readProduct(editedName)).toMatchObject({ enabled: true, asset_key: assetKey });
  } finally {
    await catalogAPI(page, '/management/unlock', 'POST', { password: 'Manage-Test-2026' });
    const product = await readProduct(editedName) ?? await readProduct(originalName);
    if (product?.enabled) await catalogAPI(page, `/management/products/${product.id}`, 'PATCH', {
      name: product.name, coin_price: product.coin_price, diamond_price: product.diamond_price,
      stock: product.stock, enabled: false, expected_version: product.version,
    });
    await catalogAPI(page, '/management/lock', 'POST');
  }
});

// 两个业务日期的独立记录隔离历史数据，管理规则变化必须立即影响普通成就页。
test('成就管理的天数指标、范围窗口、资格重算、启停和删除闭环', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const name = `天数徽章-${suffix}`;
  const categoryName = `徽章类别-${suffix}`;
  const taskName = `徽章任务-${suffix}`;
  const cleanup: { category?: Category; task?: Task; records: components['schemas']['Checkin'][] } = { records: [] };
  try {
    await page.goto('/');
    await page.getByLabel(content.account.username).fill('island-e2e');
    await page.getByLabel(content.account.loginPassword).fill('Island-Test-2026');
    await page.getByRole('button', { name: content.account.login, exact: true }).click();
    await enterManagement(page);
    const category = await catalogAPI(page, '/management/categories', 'POST', { name: categoryName, sort_order: 0 }) as Category;
    cleanup.category = category;
    const task = await catalogAPI(page, '/management/tasks', 'POST', { category_id: category.id, name: taskName, icon_key: 'book-v1', coin_reward: 1, diamond_reward: 0, daily_limit: 1, weekdays: [1, 2, 3, 4, 5, 6, 7], enabled: true }) as Task;
    cleanup.task = task;
    const camp = await catalogAPI(page, '/camp') as Camp;
    const yesterday = new Date(`${camp.today}T00:00:00Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    for (const date of [yesterday.toISOString().slice(0, 10), camp.today]) {
      const result = await catalogAPI(page, '/management/checkins', 'POST', { task_id: task.id, expected_task_version: task.version, business_date: date, text: '', photo_media_id: null, audio_media_id: null }) as components['schemas']['CheckinResult'];
      cleanup.records.push(result.checkin);
    }
    await page.getByRole('tablist', { name: content.navigation.management, exact: true }).getByRole('tab', { name: content.navigation.achievementManagement, exact: true }).click();
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
    await page.getByRole('navigation', { name: content.navigation.label, exact: true }).getByRole('button', { name: content.navigation.camp, exact: true }).click();
    await page.getByRole('button', { name: character.achievements, exact: true }).click();
    const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
    await expect(card).toBeVisible();
    await page.getByRole('button', { name: achievement.chooseTitle, exact: true }).click();
    await dialog.getByRole('button', { name, exact: true }).click();
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();

    await enterManagement(page);
    await page.getByRole('tablist', { name: content.navigation.management, exact: true }).getByRole('tab', { name: content.navigation.achievementManagement, exact: true }).click();
    await page.getByRole('button', { name: `${achievement.edit} ${name}`, exact: true }).click();
    await dialog.getByRole('checkbox', { name: achievement.enabled, exact: true }).uncheck();
    await dialog.getByRole('button', { name: achievement.save, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const row = page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
    await expect(row.getByText(achievement.disabled, { exact: true })).toBeVisible();
    await closeConfigurationSettings(page);
    await expect(page.getByRole('region', { name: character.label }).getByText(name, { exact: true })).toBeVisible();

    await enterManagement(page);
    await page.getByRole('tablist', { name: content.navigation.management, exact: true }).getByRole('tab', { name: content.navigation.achievementManagement, exact: true }).click();
    await page.getByRole('button', { name: `${achievement.edit} ${name}`, exact: true }).click();
    await dialog.getByRole('checkbox', { name: achievement.enabled, exact: true }).check();
    await dialog.getByLabel(achievement.target, { exact: true }).fill('3');
    await dialog.getByRole('button', { name: achievement.save, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row.getByText(achievement.active, { exact: true })).toBeVisible();
    await page.getByRole('navigation', { name: content.navigation.label, exact: true }).getByRole('button', { name: content.navigation.camp, exact: true }).click();
    await expect(page.getByRole('region', { name: character.label }).getByText(name, { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: character.achievements, exact: true }).click();
    await expect(page.getByRole('button', { name: achievement.chooseTitle, exact: true })).toBeVisible();
    await page.getByRole('button', { name: achievement.unowned, exact: true }).click();
    await expect(card).toBeVisible();

    await enterManagement(page);
    await page.getByRole('tablist', { name: content.navigation.management, exact: true }).getByRole('tab', { name: content.navigation.achievementManagement, exact: true }).click();
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
    await page.getByRole('navigation', { name: content.navigation.label, exact: true }).getByRole('button', { name: content.navigation.camp, exact: true }).click();
    await expect(card).toHaveCount(0);
  } finally {
    await catalogAPI(page, '/management/unlock', 'POST', { password: 'Manage-Test-2026' });
    const achievements = await catalogAPI(page, '/management/achievements') as { items: Achievement[] };
    const current = achievements.items.find((item) => item.name === name);
    if (current) await catalogAPI(page, `/management/achievements/${current.id}`, 'DELETE', { expected_version: current.version });
    for (const record of cleanup.records) await catalogAPI(page, `/management/checkins/${record.id}`, 'DELETE', { expected_version: record.version });
    if (cleanup.task) await catalogAPI(page, `/management/tasks/${cleanup.task.id}`, 'DELETE', { expected_version: cleanup.task.version });
    if (cleanup.category) await catalogAPI(page, `/management/categories/${cleanup.category.id}`, 'DELETE', { expected_version: cleanup.category.version });
    await catalogAPI(page, '/management/lock', 'POST');
  }
});
